import test from 'node:test';
import assert from 'node:assert/strict';
import {SELECTED_SIZE, VEHICLE_SIZE, shapeOf, targetLook, vehicleLook} from './map-symbols.js';

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
