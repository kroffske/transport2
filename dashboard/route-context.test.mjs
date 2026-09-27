import test from 'node:test';
import assert from 'node:assert/strict';
import {BASIS, MIN_STOP_GAP_PX, offsetText, routeLayersFor, coordOk, durationText, labelledStops, lineParts, planText, shiftedText, signedDurationText, stopRows,
  thinStops, undrawnCount} from './route-context.js';

const usable = {modelUsable: true, factUsable: true};
const route = (overrides = {}) => ({
  run_id: 'run-a', tr_id: '132430', cur_dev_s: 95, prediction_s: 140,
  stops: [
    {stop_id: 1, time: '06:41:00', lon: 37.60, lat: 55.75, role: 'passed'},
    {stop_id: 2, time: '06:52:00', lon: 37.61, lat: 55.75, role: 'before_target'},
    {stop_id: 3, time: '06:55:00', lon: 37.62, lat: 55.75, role: 'before_target'},
    {stop_id: 4, time: '06:58:00', lon: 37.63, lat: 55.75, role: 'target'},
    {stop_id: 5, time: '07:03:00', lon: 37.64, lat: 55.75, role: 'after_target'},
  ],
  ...overrides,
});

test('stops before the target carry the current delay as a fact, the target the model, after it an assumption', () => {
  const rows = stopRows(route(), usable);
  assert.deepEqual(rows.map(r => [r.stop_id, r.plan, r.expected, r.basis]), [
    ['1', '06:41', null, null],
    ['2', '06:52', '~06:53:35', 'fact'],
    ['3', '06:55', '~06:56:35', 'fact'],
    ['4', '06:58', '~07:00:20', 'model'],
    ['5', '07:03', '~07:05:20', 'assumption'],
  ]);
  assert.equal(BASIS.fact, 'по факту, не прогноз');
  assert.equal(BASIS.model, 'прогноз модели');
  assert.equal(BASIS.assumption, 'допущение: тот же сдвиг');
});

test('the toggle hides the shift after the target; plan time stays', () => {
  const after = stopRows(route(), {...usable, shiftAfterTarget: false}).at(-1);
  assert.deepEqual([after.plan, after.expected, after.basis], ['07:03', null, null]);
  const target = stopRows(route(), {...usable, shiftAfterTarget: false})[3];
  assert.equal(target.basis, 'model', 'the target keeps the model value');
});

test('no model value or no fact: only plan times, nothing borrowed from the other', () => {
  const noPrediction = stopRows(route({prediction_s: null}), usable);
  assert.deepEqual(noPrediction.map(r => r.basis), [null, 'fact', 'fact', null, null]);
  const noFact = stopRows(route({cur_dev_s: null}), usable);
  assert.deepEqual(noFact.map(r => r.basis), [null, null, null, 'model', 'assumption']);
  const planned = stopRows(route({stops: [{stop_id: 9, time: '07:00:30', lon: 37.6, lat: 55.7, role: 'planned'}]}), usable);
  assert.deepEqual([planned[0].plan, planned[0].expected], ['07:00:30', null]);
});

test('a negative delay moves the time earlier; the day wraps at midnight', () => {
  assert.equal(shiftedText('06:52:00', -30), '~06:51:30');
  assert.equal(shiftedText('23:59:00', 120), '~00:01:00');
  assert.equal(shiftedText('2026-01-06T06:58:00', 140), '~07:00:20');
  assert.equal(planText('2026-01-06T06:58:00'), '06:58');
  assert.equal(shiftedText(null, 10), null);
  assert.equal(shiftedText('06:52:00', null), null);
});

test('durations are written in minutes and seconds', () => {
  assert.equal(durationText(95), '1 мин 35 с');
  assert.equal(durationText(45), '45 с');
  assert.equal(durationText(120), '2 мин');
  assert.equal(durationText(-95), '1 мин 35 с');
  assert.equal(signedDurationText(140), '+2 мин 20 с');
  assert.equal(signedDurationText(-30), '−30 с');
  assert.equal(signedDurationText(0), '0 с');
  assert.equal(signedDurationText(null), null);
});

test('only the target and the nearest future stop get a time label on the map', () => {
  const {target, next} = labelledStops(stopRows(route(), usable));
  assert.equal(target.stop_id, '4');
  assert.equal(next.stop_id, '2');
  const onlyAfter = labelledStops(stopRows(route({stops: route().stops.filter(s => s.role !== 'before_target')}), usable));
  assert.equal(onlyAfter.next, null, 'the target is the nearest future stop');
  const noTarget = labelledStops(stopRows(route({stops: [
    {stop_id: 7, time: '07:00', lon: 37.6, lat: 55.7, role: 'passed'},
    {stop_id: 8, time: '07:05', lon: 37.61, lat: 55.7, role: 'planned'}]}), usable));
  assert.equal(noTarget.target, null);
  assert.equal(noTarget.next.stop_id, '8');
});

test('coordinates at 0/0, missing or outside the map are never drawn', () => {
  assert.equal(coordOk(37.6, 55.75), true);
  assert.equal(coordOk(37.25, 55.5), true, 'the tile extract edge is inside');
  for (const [lon, lat] of [[0, 0], [null, null], [undefined, 55.7], ['', ''], [NaN, 55.7], [30.3, 59.9], [37.6, 0], [37.2, 55.7], [37.6, 56.05]]) {
    assert.equal(coordOk(lon, lat), false, `${lon},${lat}`);
  }
  const rows = stopRows(route({stops: [...route().stops, {stop_id: 'z', time: '07:10', lon: 0, lat: 0, role: 'target'},
    {stop_id: 'n', time: '07:11', lon: null, lat: null, role: 'before_target'}]}), usable);
  assert.deepEqual(rows.filter(r => !r.onMap).map(r => r.stop_id), ['z', 'n']);
  assert.equal(labelledStops(rows).target.stop_id, '4', 'a target without a drawable coordinate is not labelled');
  // A bad point splits the line; it is never joined through (0, 0).
  const parts = lineParts([[37.60, 55.75], [37.61, 55.75], [0, 0], [37.62, 55.75], [37.63, 55.75, '06:41:05'], [null, 55.7]]);
  assert.deepEqual(parts, [[[37.60, 55.75], [37.61, 55.75]], [[37.62, 55.75], [37.63, 55.75]]]);
  assert.deepEqual(lineParts([[37.6, 55.7]]), [], 'a single point is not a line');
  assert.deepEqual(undrawnCount({path: [[0, 0], [37.6, 55.7]], passed: [[37.6, 55.7, 't']], stops: [{lon: 0, lat: 0}]}),
    {path: 1, passed: 0, stops: 1});
});

test('a stale or degraded prediction is never shown as the model value; an offline fact is not a fact', () => {
  const stale = stopRows(route(), {modelUsable: false, factUsable: true});
  assert.deepEqual(stale.map(r => r.basis), [null, 'fact', 'fact', null, null], 'no «прогноз модели», no «допущение»');
  assert.equal(stale[3].expected, null);
  const offline = stopRows(route(), {modelUsable: false, factUsable: false});
  assert.ok(offline.every(r => r.basis === null && r.expected === null), 'offline: plan times only');
  assert.throws(() => stopRows(route(), {}), /modelUsable/);
});

test('stops are thinned on screen: none closer than the gap to a kept stop or to the target', () => {
  const points = Array.from({length: 10}, (_, i) => ({row: `s${i}`, x: i * 5, y: 0}));
  const kept = thinStops(points, {avoid: [{x: 45, y: 0}]});
  const xs = kept.map(id => Number(id.slice(1)) * 5);
  for (let i = 1; i < xs.length; i += 1) assert.ok(xs[i] - xs[i - 1] >= MIN_STOP_GAP_PX);
  assert.ok(xs.every(x => Math.abs(x - 45) >= MIN_STOP_GAP_PX), 'clear of the target');
  assert.deepEqual(kept, ['s0', 's3', 's6']);
  assert.equal(thinStops(points, {gap: 0}).length, 10, 'no thinning at gap 0');
});

test('route_line decides the selected-route layers; the UI never splits the line itself', () => {
  const line = [[37.60, 55.70], [37.61, 55.71], [37.62, 55.72]];
  const car = [37.605, 55.705];
  assert.deepEqual(routeLayersFor({split_reason: 'on_route', line, passed: line.slice(0, 2), ahead: line.slice(1)}, car), ['route-passed', 'route-ahead']);
  assert.deepEqual(routeLayersFor({split_reason: 'no_segment', line, passed: [], ahead: []}, car), ['route-dim']);
  assert.deepEqual(routeLayersFor({split_reason: 'off_route', line, nearest: [37.61, 55.71]}, car), ['route-dim', 'offroute-leader']);
  assert.deepEqual(routeLayersFor({split_reason: 'off_route', line: [], nearest: [37.61, 55.71]}, car), ['offroute-leader'], 'empty window: leader only');
  assert.deepEqual(routeLayersFor({split_reason: 'off_route', line, nearest: [0, 0]}, car), ['route-dim'], 'no leader to 0/0');
  assert.deepEqual(routeLayersFor({split_reason: 'no_position', line: []}, null), []);
  assert.deepEqual(routeLayersFor(null, car), [], 'an older Backend without route_line draws no line');
  assert.equal(offsetText(3440), '~3,4 км');
  assert.equal(offsetText(410), '~410 м');
  assert.equal(offsetText(null), null);
});
