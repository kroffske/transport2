import test from 'node:test';
import assert from 'node:assert/strict';
import {LOST_AFTER_S, acknowledge, addNote, assess, countByFilter, createIncidentStore, incidentCounts,
  incidentForVehicle, markRead, normalizeNote, observeSnapshot, orderedIncidents, reopen,
  visibleRows} from './incidents.js';

const bus = (tr_id, prediction_s, status = 'normal') => ({tr_id, prediction_s, status});

test('levels follow the Backend 120 s alert threshold and 300 s severe band', () => {
  assert.equal(assess(bus('a', 120), true).level, 'normal');
  assert.equal(assess(bus('a', 121), true).level, 'warning');
  assert.equal(assess(bus('a', 300), true).level, 'severe');
});

test('missing, degraded or offline predictions are "no data", never a warning', () => {
  assert.equal(assess(bus('a', null), true).level, 'nodata');
  assert.equal(assess(bus('a', ''), true).level, 'nodata');
  assert.equal(assess(bus('a', 400, 'degraded'), true).level, 'nodata');
  const offline = assess(bus('a', 400), false);
  assert.equal(offline.level, 'nodata');
  assert.equal(offline.hasPrediction, true);
});

test('a forecast held over a target change keeps its level; other degraded reasons and «none» do not', () => {
  const held = (prediction_s, extra = {}) => ({tr_id: 'h', prediction_s, status: 'degraded', reason: 'prediction_held_previous_target',
    prediction_state: 'updating', prediction_updating: true, ...extra});
  assert.equal(assess(held(200), true).level, 'warning');
  assert.equal(assess(held(40), true).level, 'normal');
  assert.equal(assess(held(40), false).level, 'nodata'); // offline: still never current
  assert.equal(assess(held(200, {reason: 'invalid_gps'}), true).level, 'nodata');
  assert.equal(assess(held(200, {prediction_state: 'none'}), true).level, 'nodata');
  assert.equal(assess({...bus('a', 90), prediction_state: 'none'}, true).hasPrediction, false);
  assert.deepEqual(countByFilter([held(200), held(40), bus('n', null)], true), {all: 3, warning: 1, nodata: 1});
  // A held switch in the middle of an episode changes nothing: same incident, still active.
  const store = createIncidentStore();
  observeSnapshot(store, [bus('h', 200)], {fresh: true, clock: 't1', wallS: 0});
  observeSnapshot(store, [held(200)], {fresh: true, clock: 't2', wallS: 100});
  const [incident] = orderedIncidents(store);
  assert.equal(incident.state, 'active');
  assert.equal(orderedIncidents(store).length, 1);
});

test('filter counts describe the current set only', () => {
  const rows = [bus('1', 30), bus('2', 200), bus('3', 400), bus('4', null), bus('5', 90, 'unavailable')];
  assert.deepEqual(countByFilter(rows, true), {all: 5, warning: 2, nodata: 2});
  assert.deepEqual(countByFilter(rows, false), {all: 5, warning: 0, nodata: 5});
  assert.deepEqual(countByFilter([], true), {all: 0, warning: 0, nodata: 0});
});

test('visible rows are filtered, searched by displayed ID and sorted by urgency', () => {
  const rows = [bus('Д-101', 30), bus('Д-104', 400), bus('Д-103', 170), bus('Д-106', null)];
  assert.deepEqual(visibleRows(rows, {fresh: true}).map(r => r.vehicle.tr_id), ['Д-104', 'Д-103', 'Д-101', 'Д-106']);
  assert.deepEqual(visibleRows(rows, {filter: 'warning', fresh: true}).map(r => r.vehicle.tr_id), ['Д-104', 'Д-103']);
  assert.deepEqual(visibleRows(rows, {filter: 'nodata', fresh: true}).map(r => r.vehicle.tr_id), ['Д-106']);
  assert.deepEqual(visibleRows(rows, {query: ' 101 ', fresh: true}).map(r => r.vehicle.tr_id), ['Д-101']);
  assert.deepEqual(visibleRows(rows, {query: 'нет такого', fresh: true}), []);
});

// ---- Incidents: one episode per vehicle ------------------------------------------------------

test('normal → >120 → repeated snapshot → ≤120 is one episode ending in a resolution', () => {
  const store = createIncidentStore('run-1');
  assert.deepEqual(observeSnapshot(store, [bus('1', 60)], {fresh: true, clock: 't0', wallS: 0}), []);
  const opened = observeSnapshot(store, [bus('1', 200)], {fresh: true, clock: 't1', wallS: 20});
  assert.equal(opened.length, 1);
  for (let i = 0; i < 5; i += 1) assert.deepEqual(observeSnapshot(store, [bus('1', 200)], {fresh: true, clock: 't1', wallS: 20}), []);
  assert.equal(store.incidents.length, 1);
  assert.equal(store.incidents[0].history.length, 1, 'repeated polling adds no history');
  observeSnapshot(store, [bus('1', 100)], {fresh: true, clock: 't2', wallS: 40});
  const [incident] = store.incidents;
  assert.equal(incident.id, opened[0]);
  assert.equal(incident.state, 'resolved');
  assert.equal(incident.resolved_at, 't2');
  assert.equal(incident.peak_s, 200);
  assert.match(incident.history.at(-1).text, /Задержка закончилась/);
  // A new warning after the resolution is a new episode with a new ID.
  const again = observeSnapshot(store, [bus('1', 250)], {fresh: true, clock: 't3', wallS: 60});
  assert.equal(again.length, 1);
  assert.notEqual(again[0], incident.id);
  assert.equal(store.incidents.length, 2);
});

test('each vehicle is its own episode; there is no grouping by route or direction', () => {
  const store = createIncidentStore('run-1');
  observeSnapshot(store, [bus('1', 200)], {fresh: true, clock: 't0', wallS: 0});
  // Fields a scenario once used for grouping are ignored.
  const opened = observeSnapshot(store, [bus('1', 200), {...bus('2', 400), route_id: 'x', direction_id: 'a'}, {...bus('3', 150), route_id: 'x', direction_id: 'a'}],
    {fresh: true, clock: 't1', wallS: 20});
  assert.equal(opened.length, 2, 'vehicles 2 and 3 open their own episodes');
  assert.deepEqual(store.incidents.map(i => i.tr_id), ['1', '2', '3']);
  assert.equal(new Set(store.incidents.map(i => i.id)).size, 3);
  assert.equal(orderedIncidents(store)[0].tr_id, '3', 'newest open episode first');
  assert.equal(incidentForVehicle(store, '2').id, opened[0]);
});

test('data lost for LOST_AFTER_S or an offline source is monitoring_lost, never a resolution', () => {
  const store = createIncidentStore('run-1');
  observeSnapshot(store, [bus('1', 200)], {fresh: true, clock: 't0', wallS: 0});
  observeSnapshot(store, [bus('1', 200)], {fresh: false, clock: 't0', wallS: 1});
  const [incident] = store.incidents;
  assert.equal(incident.state, 'active', 'offline for 0 s is not yet a loss');
  observeSnapshot(store, [bus('1', 200)], {fresh: false, clock: 't0', wallS: 1 + LOST_AFTER_S});
  assert.equal(incident.state, 'monitoring_lost');
  observeSnapshot(store, [bus('1', 200, 'degraded')], {fresh: true, clock: 't1', wallS: 20});
  observeSnapshot(store, [], {fresh: true, clock: 't1', wallS: 20});
  assert.equal(incident.state, 'monitoring_lost');
  assert.equal(incident.history.filter(h => /Мониторинг потерян/.test(h.text)).length, 1, 'logged once');
  observeSnapshot(store, [bus('1', 220)], {fresh: true, clock: 't2', wallS: 40});
  assert.equal(incident.state, 'active', 'same episode continues');
  assert.equal(store.incidents.length, 1);
  observeSnapshot(store, [bus('1', 60)], {fresh: true, clock: 't3', wallS: 60});
  assert.equal(incident.state, 'resolved');
  assert.deepEqual(incidentCounts(store), {active: 0, monitoring_lost: 0, resolved: 1, unread: 1});
});

test('acknowledge/reopen and notes live on the incident ID and survive polling', () => {
  const store = createIncidentStore('run-1');
  const [id] = observeSnapshot(store, [bus('1', 200)], {fresh: true, clock: 't0', wallS: 0});
  assert.equal(incidentCounts(store).unread, 1);
  assert.equal(acknowledge(store, id, 't1'), true);
  assert.equal(acknowledge(store, id, 't1'), false, 'no duplicate action');
  assert.equal(addNote(store, id, '  <img src=x onerror="alert(1)">\n  позвонить  ', 't1'), true);
  assert.equal(addNote(store, id, '   ', 't1'), false, 'empty note rejected');
  for (let i = 0; i < 3; i += 1) observeSnapshot(store, [bus('1', 210)], {fresh: true, clock: 't2', wallS: 40});
  const incident = incidentForVehicle(store, '1');
  assert.equal(incident.id, id);
  assert.equal(incident.workflow, 'in_work');
  assert.equal(incident.unread, false);
  assert.deepEqual(incident.notes.map(n => n.text), ['<img src=x onerror="alert(1)"> позвонить'], 'stored as plain text');
  assert.equal(reopen(store, id, 't3'), true);
  assert.equal(incident.workflow, 'new');
  assert.deepEqual(incident.history.map(h => h.kind), ['lifecycle', 'action', 'note', 'action']);
  observeSnapshot(store, [bus('1', 30)], {fresh: true, clock: 't4', wallS: 80});
  assert.equal(acknowledge(store, id, 't4'), false, 'an ended delay cannot be taken into work');
  assert.equal(markRead(store, id).unread, false);
  assert.equal(normalizeNote('x'.repeat(500)).length, 280);
  // A new store (reset or mode change) carries nothing over.
  assert.deepEqual(createIncidentStore('run-1').incidents, []);
});

// PR-019: the live stream changes target about every 12 s of wall time at ×5; the new target's
// prediction is `pending` (no data) for a few seconds. That gap is neither a loss nor an end.
test('a nodata gap shorter than LOST_AFTER_S is neither monitoring_lost nor resolved, and leaves no trace', () => {
  const store = createIncidentStore('run-1');
  const [id] = observeSnapshot(store, [bus('1', 200)], {fresh: true, clock: 't0', wallS: 100});
  markRead(store, id);
  const incident = incidentForVehicle(store, '1');
  const history = incident.history.length;
  const pending = {tr_id: '1', prediction_s: null, status: 'degraded', reason: 'prediction_pending'};
  for (const wallS of [101.5, 103, 110, 100 + LOST_AFTER_S - 0.5]) {
    observeSnapshot(store, [pending], {fresh: true, clock: 't1', wallS});
    assert.equal(incident.state, 'active', `still active at +${wallS - 100} s`);
  }
  // Row missing from one snapshot, then the new target's prediction arrives: still one quiet episode.
  observeSnapshot(store, [], {fresh: true, clock: 't1', wallS: 100 + LOST_AFTER_S - 0.2});
  observeSnapshot(store, [bus('1', 180)], {fresh: true, clock: 't2', wallS: 100 + LOST_AFTER_S + 1});
  assert.equal(incident.state, 'active');
  assert.equal(incident.history.length, history, 'no history line for a short gap');
  assert.equal(incident.unread, false, 'no unread mark for a short gap');
  assert.equal(store.incidents.length, 1);
  // A later short gap does not resolve the episode either.
  observeSnapshot(store, [pending], {fresh: true, clock: 't3', wallS: 200});
  observeSnapshot(store, [pending], {fresh: true, clock: 't3', wallS: 200 + LOST_AFTER_S - 1});
  assert.equal(incident.state, 'active', 'a gap is not a resolution');
  // The gap timer restarts after data returned: a second short gap is still short.
  observeSnapshot(store, [bus('1', 190)], {fresh: true, clock: 't4', wallS: 220});
  observeSnapshot(store, [pending], {fresh: true, clock: 't4', wallS: 221});
  observeSnapshot(store, [pending], {fresh: true, clock: 't4', wallS: 221 + LOST_AFTER_S - 1});
  assert.equal(incident.state, 'active');
  // A continuous gap of LOST_AFTER_S is a loss, logged once.
  observeSnapshot(store, [pending], {fresh: true, clock: 't5', wallS: 221 + LOST_AFTER_S});
  assert.equal(incident.state, 'monitoring_lost');
  assert.equal(incident.history.length, history + 1);
});

test('observeSnapshot requires the wall time', () => {
  assert.throws(() => observeSnapshot(createIncidentStore('run-1'), [], {fresh: true, clock: 't0'}), /wallS/);
});
