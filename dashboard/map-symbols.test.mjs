import test from 'node:test';
import assert from 'node:assert/strict';
import {MARKED_FILL, SELECTED_SIZE, STOP_COLOR, VEHICLE_SIZE, headingLook, shapeOf, stopKind, stopLook, targetLook, vehicleLook} from './map-symbols.js';

// Colour aside, every state a dispatcher must tell apart has its own shape (task T-7, W7).
test('vehicle states differ without colour: badge, dashed border, «?», ring and size', () => {
  const looks = {
    normal: vehicleLook('normal'),
    warning: vehicleLook('warning'),
    severe: vehicleLook('severe'),
    nodata: vehicleLook('nodata'),
    invalidGps: vehicleLook('normal', {gpsValid: false}),
    selected: vehicleLook('normal', {selected: true}),
    hovered: vehicleLook('normal', {hovered: true}),
    offRoute: vehicleLook('normal', {offRoute: true}),
    gpsMarked: vehicleLook('nodata', {gpsValid: false, gpsMarked: true}),
    heading: headingLook(),
    target: targetLook(),
  };
  const shapes = Object.values(looks).map(shapeOf);
  assert.equal(new Set(shapes).size, shapes.length, `shapes: ${shapes.join(' / ')}`);
  assert.equal(looks.warning.badge, '!');
  assert.equal(looks.severe.badge, '!!');
  assert.equal(looks.nodata.border, 'dashed');
  assert.equal(looks.nodata.fill, '#ffffff', 'no current prediction: hollow icon');
  assert.equal(looks.invalidGps.badge, '?');
  assert.equal(looks.selected.ring, 'selected');
  assert.equal(looks.selected.size, SELECTED_SIZE);
  assert.ok(SELECTED_SIZE > VEHICLE_SIZE);
});

test('a vehicle is never drawn like a stop or the target', () => {
  for (const level of ['normal', 'warning', 'severe', 'nodata']) {
    for (const gpsValid of [true, false]) assert.equal(vehicleLook(level, {gpsValid}).kind, 'vehicle');
  }
  assert.equal(targetLook().kind, 'target');
  assert.notEqual(shapeOf(vehicleLook('nodata')), shapeOf(targetLook()));
});

test('invalid GPS wins over the level mark; a stale vehicle keeps its dashed border', () => {
  const look = vehicleLook('nodata', {gpsValid: false});
  assert.equal(look.badge, '?');
  assert.equal(look.border, 'dashed');
  assert.equal(vehicleLook('severe', {gpsValid: false}).badge, '?');
});

test('off route is its own mark and combines with the level mark', () => {
  const look = vehicleLook('warning', {offRoute: true});
  assert.equal(look.badge, '!');
  assert.equal(look.offRoute, true);
  assert.notEqual(shapeOf(look), shapeOf(vehicleLook('warning')));
  assert.equal(vehicleLook('normal', {offRoute: null}).offRoute, false, 'unknown (null) is not off route');
});

test('a GPS marked faulty by the dispatcher has its own violet look, unlike grey no-forecast or «?»', () => {
  const marked = vehicleLook('nodata', {gpsValid: false, offRoute: true, gpsMarked: true});
  assert.equal(marked.badge, '×');
  assert.equal(marked.border, 'solid');
  assert.equal(marked.fill, MARKED_FILL);
  assert.equal(marked.offRoute, false, 'no «≠» from the faulty coordinates');
  for (const other of [vehicleLook('nodata'), vehicleLook('normal', {gpsValid: false})]) {
    assert.notEqual(marked.fill, other.fill);
    assert.notEqual(shapeOf(marked), shapeOf(other));
  }
  assert.equal(vehicleLook('nodata', {gpsMarked: true, selected: true}).ring, 'selected');
});

// Spec §S (T-17): the four stop roles differ without colour — size, ring style — and never use a
// severity colour (that belongs to the vehicle icon only).
test('stop roles differ without colour: passed dot, solid ring, dashed ring, target diamond', () => {
  const looks = {passed: stopLook('passed'), before: stopLook('before_target'), after: stopLook('after_target'), target: targetLook()};
  const shapes = Object.values(looks).map(shapeOf);
  assert.equal(new Set(shapes).size, shapes.length, `shapes: ${shapes.join(' / ')}`);
  assert.ok(looks.passed.size < looks.before.size, 'a passed stop is the small one');
  assert.equal(looks.passed.fill, STOP_COLOR.passed);
  assert.deepEqual([looks.before.fill, looks.before.ringColor, looks.before.ringWidth, looks.before.border], ['#ffffff', STOP_COLOR.ahead, 3, 'solid']);
  assert.deepEqual([looks.after.fill, looks.after.ringColor, looks.after.border], ['#ffffff', STOP_COLOR.after, 'dashed']);
});

test('stop colours are the CSS tokens and never a severity colour', () => {
  assert.deepEqual(STOP_COLOR, {passed: '#a9b3ba', ahead: '#1b2a36', after: '#6b7780'});
  const severity = new Set(['normal', 'warning', 'severe'].map(level => vehicleLook(level).fill.toLowerCase()));
  for (const role of ['passed', 'before_target', 'after_target', 'planned']) {
    const look = stopLook(role);
    for (const colour of [look.fill, look.ringColor]) assert.ok(!severity.has(colour.toLowerCase()), `${role}: ${colour}`);
  }
});

test('stop roles map onto three icons; without a target the planned stops look like «до цели»', () => {
  assert.equal(stopKind('passed'), 'passed');
  assert.equal(stopKind('before_target'), 'ahead');
  assert.equal(stopKind('planned'), 'ahead');
  assert.equal(stopKind('after_target'), 'after');
  assert.equal(shapeOf(stopLook('planned')), shapeOf(stopLook('before_target')));
  assert.notEqual(shapeOf(stopLook('passed')), shapeOf(vehicleLook('nodata')), 'a stop is never a vehicle');
});
