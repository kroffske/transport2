import test from 'node:test';
import assert from 'node:assert/strict';
import {splitAtTarget, stopTip} from './route-layers.js';

// Rows as route-context.js stopRows gives them (only the fields the split reads).
const row = (role, lon, lat, onMap = true) => ({role, lon, lat, onMap});
const A = [37.60, 55.75], B = [37.61, 55.751], T = [37.62, 55.752], C = [37.63, 55.753];

test('the ahead line is cut at the target stop: solid up to it, dashed after it (spec §S)', () => {
  const ahead = [[37.595, 55.7495], A, [37.605, 55.7505], B, T, [37.625, 55.7525], C];
  const {toTarget, after} = splitAtTarget(ahead, [row('passed', ...A), row('before_target', ...B), row('target', ...T), row('after_target', ...C)]);
  assert.deepEqual(toTarget, ahead.slice(0, 5));
  assert.deepEqual(after, ahead.slice(4));
  assert.deepEqual(toTarget.at(-1), T, 'the target point closes the solid part');
  assert.deepEqual(after[0], T, 'and opens the dashed one');
});

test('a loop that passes the target stop twice cuts at the target visit, not the earlier one', () => {
  const ahead = [A, T, B, C, T, [37.64, 55.76]];
  const rows = [row('before_target', ...T), row('before_target', ...B), row('target', ...T)];
  const {toTarget, after} = splitAtTarget(ahead, rows);
  assert.equal(toTarget.length, 5);
  assert.deepEqual(after, [T, [37.64, 55.76]]);
});

test('a repeated target vertex is one visit', () => {
  const ahead = [A, T, T, B, C, T, T];
  const {toTarget, after} = splitAtTarget(ahead, [row('before_target', ...T), row('target', ...T)]);
  assert.equal(toTarget.length, 6, 'the second visit, not the duplicate of the first');
  assert.deepEqual(after, [T, T]);
});

test('no split without a drawable target or when the target is not on the ahead line', () => {
  const ahead = [A, B, C];
  assert.deepEqual(splitAtTarget(ahead, [row('planned', ...A)]), {toTarget: ahead, after: []});
  assert.deepEqual(splitAtTarget(ahead, [row('target', ...T)]), {toTarget: ahead, after: []}, 'target behind the vehicle');
  assert.deepEqual(splitAtTarget(ahead, [row('target', ...B, false)]), {toTarget: ahead, after: []}, 'target outside the map');
  assert.deepEqual(splitAtTarget(null, []), {toTarget: [], after: []});
});

test('the target as the last vertex leaves nothing dashed', () => {
  const {toTarget, after} = splitAtTarget([A, B, T], [row('target', ...T)]);
  assert.equal(toTarget.length, 3);
  assert.deepEqual(after, [T], 'a single point: lineParts drops it');
});

test('the hover tip names the role in words, not only by the icon', () => {
  assert.match(stopTip({role: 'after_target', plan: '07:03', expected: '07:06', basis: 'assumption'}), /^после цели · план 07:03 → 07:06 · допущение/);
  assert.match(stopTip({role: 'passed', plan: '06:44'}), /^пройдена · план 06:44$/);
});
