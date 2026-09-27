import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PHASES, ROUTE_CATALOG, SCENARIO_VERSION, catalogStop, createRun, isFinished, next, pause, phaseRows, scenarioSnapshot, start} from './scenario.js';
import {assess, countByFilter, createIncidentStore, newWarningIds, observeSnapshot, routeKeyOf} from './incidents.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../consumer/map/manifest.json', import.meta.url), 'utf8'));
const [west, south, east, north] = manifest.coverage.match(/bbox ([\d.,]+)/)[1].split(',').map(Number);
const phaseIndexes = PHASES.map((_, i) => i);

// Drive a run with Next only and record what the UI would render at each step.
function playThrough(run) {
  const seen = [];
  for (;;) {
    const snap = scenarioSnapshot(run);
    seen.push({phase: snap.phase.id, revision: snap.revision, vehicles: snap.vehicles});
    if (isFinished(run)) return {seen, run};
    run = next(run);
  }
}

test('one versioned scenario with 4–6 phases and 6–12 stable, uniquely named objects', () => {
  assert.match(SCENARIO_VERSION, /^d03\.v\d+$/);
  assert.ok(PHASES.length >= 4 && PHASES.length <= 6);
  const ids = phaseRows(0).map(v => v.tr_id);
  assert.ok(ids.length >= 6 && ids.length <= 12);
  assert.equal(new Set(ids).size, ids.length);
  for (const i of phaseIndexes) assert.deepEqual(phaseRows(i).map(v => v.tr_id), ids);
});

test('every value is marked as scenario input, never as model output', () => {
  for (const i of phaseIndexes) {
    for (const v of phaseRows(i)) {
      assert.equal(v.prediction_source, 'scenario');
      assert.equal(v.model_version, null);
    }
  }
  const snap = scenarioSnapshot(createRun(1, 'x'));
  assert.equal(snap.source_clock, 'scenario');
  assert.equal(snap.scenario_version, SCENARIO_VERSION);
});

test('phase rows are deterministic and returned as independent copies', () => {
  const first = phaseRows(2);
  first[0].prediction_s = 999;
  assert.deepEqual(phaseRows(2), phaseRows(2));
  assert.notEqual(phaseRows(2)[0].prediction_s, 999);
});

test('every position and target in every phase lies inside the local map extract', () => {
  for (const i of phaseIndexes) {
    for (const v of phaseRows(i)) {
      for (const [lon, lat] of [[v.lon, v.lat], [v.target_lon, v.target_lat]]) {
        if (lon == null) continue;
        assert.ok(lon > west && lon < east && lat > south && lat < north, `${PHASES[i].id} ${v.tr_id} ${lon},${lat}`);
      }
    }
  }
});

test('the phases cover no prediction, updating, a new warning, data unavailable and recovery', () => {
  const at = id => phaseRows(PHASES.findIndex(p => p.id === id));
  const row = (rows, id) => rows.find(v => v.tr_id === id);
  // Overview already shows one visible problem and honest no-data rows.
  const overview = at('overview');
  assert.deepEqual(countByFilter(overview, true), {all: 8, warning: 1, nodata: 2});
  assert.equal(row(overview, 'Д-106').prediction_s, null);
  assert.ok(overview.some(v => v.location_valid === false && v.lon == null));
  // Updating: the object has no prediction yet and a Backend-style pending reason.
  assert.equal(row(at('updating'), 'Д-104').reason, 'prediction_pending');
  assert.equal(assess(row(at('updating'), 'Д-104'), true).level, 'nodata');
  // New warning: Д-104 and Д-102 (both direction Б) are new compared with the phase before.
  const i = PHASES.findIndex(p => p.id === 'new-warning');
  assert.deepEqual([...newWarningIds(phaseRows(i - 1), phaseRows(i))].sort(), ['Д-102', 'Д-104']);
  // Data unavailable: a disconnected object keeps its last value but is not a current warning.
  const lost = row(at('data-loss'), 'Д-103');
  assert.equal(lost.reason, 'disconnected');
  assert.deepEqual(assess(lost, true), {level: 'nodata', hasPrediction: true});
  // Recovery: no warnings left.
  assert.equal(countByFilter(at('recovery'), true).warning, 0);
});

test('Start, Pause and Next move one run through the fixed phase order', () => {
  let run = createRun(1, 'a');
  assert.equal(run.phase, 0);
  assert.equal(run.playing, false);
  run = start(run);
  assert.equal(run.playing, true);
  run = next(run);
  assert.equal(run.phase, 1);
  assert.equal(run.playing, true);
  run = pause(run);
  assert.equal(run.playing, false);
  run = next(run);
  assert.equal(run.phase, 2);
  assert.equal(run.playing, false, 'Next while paused does not resume');
  while (!isFinished(run)) run = next(start(run));
  assert.equal(run.playing, false, 'a run stops on its last phase');
  assert.equal(start(run).playing, false, 'a finished run cannot be restarted without Reset');
  assert.deepEqual(next(run), run, 'Next at the end changes nothing');
  assert.deepEqual(run.history, PHASES.map(p => p.id));
});

test('three runs give the same phases; each reset has a new ID and its own empty history', () => {
  const runs = [1, 2, 3].map(n => playThrough(createRun(n, `n${n}`)));
  const values = runs.map(r => r.seen);
  assert.deepEqual(values[1], values[0]);
  assert.deepEqual(values[2], values[0]);
  assert.deepEqual(values[0].map(s => s.revision), phaseIndexes.map(i => i + 1));
  const ids = runs.map(r => r.run.scenario_run_id);
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.match(id, /^moscow-center-demo\.d03\.v\d+\.r\d+-\w+$/);
  // A fresh run knows nothing of the finished one.
  const fresh = createRun(4, 'n4');
  assert.deepEqual(fresh.history, [PHASES[0].id]);
  assert.equal(fresh.phase, 0);
  assert.equal(scenarioSnapshot(fresh).scenario_run_id, fresh.scenario_run_id);
});

test('the route catalog has two directions with their own ordered points; targets come only from it', () => {
  const keys = ROUTE_CATALOG.directions.map(d => d.route_key);
  assert.deepEqual(keys, ['demo-line:a', 'demo-line:b']);
  for (const direction of ROUTE_CATALOG.directions) {
    assert.ok(direction.stops.length >= 2);
    assert.match(direction.label, /^Демо-линия · направление/);
    for (const stop of direction.stops) assert.ok(stop.lon > west && stop.lon < east && stop.lat > south && stop.lat < north);
  }
  const [a, b] = ROUTE_CATALOG.directions;
  assert.equal(new Set([...a.stops, ...b.stops].map(s => s.id)).size, a.stops.length + b.stops.length, 'directions do not share point IDs');
  for (const i of phaseIndexes) {
    for (const v of phaseRows(i)) {
      if (v.target_stop_id == null) {
        assert.equal(v.target_lon, null, `${v.tr_id}: no target → no coordinate, never [0,0]`);
        continue;
      }
      const stop = catalogStop(v.target_stop_id);
      assert.deepEqual([v.target_lon, v.target_lat], [stop.lon, stop.lat]);
      const direction = ROUTE_CATALOG.directions.find(d => d.route_key === routeKeyOf(v));
      assert.ok(direction.stops.some(s => s.id === v.target_stop_id), `${v.tr_id}: target lies on its own direction`);
    }
  }
  const unmapped = phaseRows(0).filter(v => routeKeyOf(v) == null).map(v => v.tr_id);
  assert.deepEqual(unmapped, ['Д-108']);
  assert.equal(catalogStop('нет такой'), null);
});

test('a run produces one event per direction episode, then monitoring loss and resolution', () => {
  const store = createIncidentStore('demo');
  const openedPerPhase = phaseIndexes.map(i => observeSnapshot(store, phaseRows(i), {fresh: true, clock: PHASES[i].clock}));
  assert.deepEqual(openedPerPhase.map(o => o.length), [1, 0, 1, 0, 0]);
  const [a, b] = store.incidents;
  assert.equal(a.route_key, 'demo-line:a');
  assert.deepEqual(a.members.map(m => m.tr_id), ['Д-103']);
  assert.equal(b.route_key, 'demo-line:b');
  assert.deepEqual(b.members.map(m => m.tr_id).sort(), ['Д-102', 'Д-104']);
  assert.deepEqual([a.state, b.state], ['resolved', 'resolved']);
  assert.ok(a.history.some(h => /Мониторинг потерян/.test(h.text)), 'phase 4 loses monitoring of direction А');
  // Replaying the same phase adds nothing.
  assert.deepEqual(observeSnapshot(store, phaseRows(4), {fresh: true, clock: '12:45:00'}), []);
  assert.equal(store.incidents.length, 2);
});
