import test from 'node:test';
import assert from 'node:assert/strict';
import {UNMAPPED, acknowledge, addNote, assess, countByFilter, countByRoute, createIncidentStore, groupKey, incidentCounts,
  incidentForVehicle, markRead, newWarningIds, normalizeNote, observeSnapshot, orderedIncidents, reopen, routeKeyOf,
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

test('a new warning is one that was not a warning in the previous rows', () => {
  const before = [bus('1', 200), bus('2', 60), bus('3', null)];
  const after = [bus('1', 250), bus('2', 400), bus('3', 150)];
  assert.deepEqual([...newWarningIds(before, after)].sort(), ['2', '3']);
  assert.deepEqual([...newWarningIds(after, after)], []);
  assert.deepEqual([...newWarningIds(after, [bus('2', 90)])], []);
});

// ---- Route keys and incidents ----------------------------------------------------------------

const onRoute = (tr_id, prediction_s, direction_id, status = 'normal') =>
  ({tr_id, prediction_s, status, route_id: 'demo-line', direction_id, route_label: `Демо-линия · ${direction_id}`});

test('the route key always includes the direction; rows without both stay unmapped', () => {
  assert.equal(routeKeyOf(onRoute('1', 0, 'a')), 'demo-line:a');
  assert.notEqual(routeKeyOf(onRoute('1', 0, 'a')), routeKeyOf(onRoute('2', 0, 'b')));
  assert.equal(routeKeyOf({tr_id: '1', route_id: 'demo-line'}), null);
  assert.equal(routeKeyOf({tr_id: '1', direction_id: 'a'}), null);
  assert.equal(routeKeyOf(bus('1', 0)), null);
  assert.equal(groupKey('live', bus('7', 0)), 'live|unmapped:7');
  assert.deepEqual(countByRoute([onRoute('1', 0, 'b'), bus('9', 0), onRoute('2', 0, 'a'), onRoute('3', 0, 'a')]),
    [['demo-line:a', 2], ['demo-line:b', 1], [UNMAPPED, 1]]);
  assert.deepEqual(visibleRows([onRoute('1', 0, 'a'), onRoute('2', 0, 'b'), bus('3', 0)], {route: 'demo-line:b', fresh: true}).map(r => r.vehicle.tr_id), ['2']);
  assert.deepEqual(visibleRows([onRoute('1', 0, 'a'), bus('3', 0)], {route: UNMAPPED, fresh: true}).map(r => r.vehicle.tr_id), ['3']);
});

test('normal → >120 → repeated snapshot → ≤120 is one episode ending in a resolution', () => {
  const store = createIncidentStore('demo');
  assert.deepEqual(observeSnapshot(store, [onRoute('1', 60, 'a')], {fresh: true, clock: 't0'}), []);
  const opened = observeSnapshot(store, [onRoute('1', 200, 'a')], {fresh: true, clock: 't1'});
  assert.equal(opened.length, 1);
  for (let i = 0; i < 5; i += 1) assert.deepEqual(observeSnapshot(store, [onRoute('1', 200, 'a')], {fresh: true, clock: 't1'}), []);
  assert.equal(store.incidents.length, 1);
  assert.equal(store.incidents[0].history.length, 1, 'repeated polling adds no history');
  observeSnapshot(store, [onRoute('1', 100, 'a')], {fresh: true, clock: 't2'});
  const [incident] = store.incidents;
  assert.equal(incident.id, opened[0]);
  assert.equal(incident.state, 'resolved');
  assert.equal(incident.resolved_at, 't2');
  assert.equal(incident.peak_s, 200);
  assert.match(incident.history.at(-1).text, /Задержка закончилась/);
  // A new warning after the resolution is a new episode with a new ID.
  const again = observeSnapshot(store, [onRoute('1', 250, 'a')], {fresh: true, clock: 't3'});
  assert.equal(again.length, 1);
  assert.notEqual(again[0], incident.id);
  assert.equal(store.incidents.length, 2);
});

test('two objects of one direction share an episode; the opposite direction is separate', () => {
  const store = createIncidentStore('demo');
  observeSnapshot(store, [onRoute('1', 200, 'a')], {fresh: true, clock: 't0'});
  const opened = observeSnapshot(store, [onRoute('1', 200, 'a'), onRoute('2', 400, 'a'), onRoute('3', 150, 'b')], {fresh: true, clock: 't1'});
  assert.equal(opened.length, 1, 'only the opposite direction opens a new episode');
  const [a, b] = store.incidents;
  assert.deepEqual(a.members.map(m => m.tr_id), ['1', '2']);
  assert.equal(a.route_key, 'demo-line:a');
  assert.deepEqual(b.members.map(m => m.tr_id), ['3']);
  assert.equal(b.route_key, 'demo-line:b');
  assert.equal(b.id, opened[0]);
  // Unmapped objects are never grouped together.
  const live = createIncidentStore('live');
  assert.equal(observeSnapshot(live, [bus('x', 200), bus('y', 300)], {fresh: true, clock: 't'}).length, 2);
  assert.equal(orderedIncidents(store)[0].id, b.id, 'newest open episode first');
});

test('lost data or an offline source is monitoring_lost, never a resolution', () => {
  const store = createIncidentStore('live');
  observeSnapshot(store, [onRoute('1', 200, 'a')], {fresh: true, clock: 't0'});
  observeSnapshot(store, [onRoute('1', 200, 'a')], {fresh: false, clock: 't0'});
  const [incident] = store.incidents;
  assert.equal(incident.state, 'monitoring_lost');
  observeSnapshot(store, [onRoute('1', 200, 'a', 'degraded')], {fresh: true, clock: 't1'});
  observeSnapshot(store, [], {fresh: true, clock: 't1'});
  assert.equal(incident.state, 'monitoring_lost');
  assert.equal(incident.history.filter(h => /Мониторинг потерян/.test(h.text)).length, 1, 'logged once');
  observeSnapshot(store, [onRoute('1', 220, 'a')], {fresh: true, clock: 't2'});
  assert.equal(incident.state, 'active', 'same episode continues');
  assert.equal(store.incidents.length, 1);
  observeSnapshot(store, [onRoute('1', 60, 'a')], {fresh: true, clock: 't3'});
  assert.equal(incident.state, 'resolved');
  assert.deepEqual(incidentCounts(store), {active: 0, monitoring_lost: 0, resolved: 1, unread: 1});
});

test('acknowledge/reopen and notes live on the incident ID and survive polling', () => {
  const store = createIncidentStore('live');
  const [id] = observeSnapshot(store, [bus('1', 200)], {fresh: true, clock: 't0'});
  assert.equal(incidentCounts(store).unread, 1);
  assert.equal(acknowledge(store, id, 't1'), true);
  assert.equal(acknowledge(store, id, 't1'), false, 'no duplicate action');
  assert.equal(addNote(store, id, '  <img src=x onerror="alert(1)">\n  позвонить  ', 't1'), true);
  assert.equal(addNote(store, id, '   ', 't1'), false, 'empty note rejected');
  for (let i = 0; i < 3; i += 1) observeSnapshot(store, [bus('1', 210)], {fresh: true, clock: 't2'});
  const incident = incidentForVehicle(store, '1');
  assert.equal(incident.id, id);
  assert.equal(incident.workflow, 'in_work');
  assert.equal(incident.unread, false);
  assert.deepEqual(incident.notes.map(n => n.text), ['<img src=x onerror="alert(1)"> позвонить'], 'stored as plain text');
  assert.equal(reopen(store, id, 't3'), true);
  assert.equal(incident.workflow, 'new');
  assert.deepEqual(incident.history.map(h => h.kind), ['lifecycle', 'action', 'note', 'action']);
  observeSnapshot(store, [bus('1', 30)], {fresh: true, clock: 't4'});
  assert.equal(acknowledge(store, id, 't4'), false, 'an ended delay cannot be taken into work');
  assert.equal(markRead(store, id).unread, false);
  assert.equal(normalizeNote('x'.repeat(500)).length, 280);
  // A new store (reset or mode change) carries nothing over.
  assert.deepEqual(createIncidentStore('live').incidents, []);
});
