import test from 'node:test';
import assert from 'node:assert/strict';
import {DOT_RADIUS, LABEL_GAP, LABEL_MARGIN, labelOffset, nextLabelText, placeLabels, targetLabelText, vehicleLabelText} from './map-labels.js';

const W = 103.3671875, H = 26; // a «Д-10x · 0.7 мин» label as measured in the browser at 1920×1080
const label = (id, x, y, extra = {}) => ({id, x, y, width: W, height: H, ...extra});
const intersection = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const assertNoOverlap = placed => {
  const rects = [...placed.values()].map(p => p.rect);
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) assert.equal(intersection(rects[i], rects[j]), 0, `labels ${i} and ${j} overlap`);
  }
};
const naiveTop = l => ({x: l.x - l.width / 2, y: l.y - LABEL_GAP - l.height, width: l.width, height: l.height});

test('an unobstructed label keeps the former place: centred 14 px above its dot', () => {
  const placed = placeLabels([label('Д-101', 500, 400)]).get('Д-101');
  assert.equal(placed.placement, 'top');
  assert.deepEqual(placed.rect, naiveTop(label('Д-101', 500, 400)));
});

test('QA phase 5: Д-104 and Д-107 no longer cover each other', () => {
  // Dots recovered from the QA label boxes (label bottom centre + 14 px); above-only labels overlapped 47.37×18 px.
  const rows = [label('Д-107', 1289, 765), label('Д-104', 1233, 773)];
  assert.ok(intersection(naiveTop(rows[0]), naiveTop(rows[1])) > 0);
  const placed = placeLabels(rows);
  assertNoOverlap(placed);
  // Above its dot Д-104 would also cover the Д-107 dot, so it moves below; Д-107 keeps its place.
  assert.equal(placed.get('Д-107').placement, 'top');
  assert.equal(placed.get('Д-104').placement, 'bottom');
});

test('QA phase 4: the smaller Д-101/Д-105 overlap is resolved by the same policy', () => {
  const rows = [label('Д-101', 700, 500), label('Д-105', 700 + (W - 40.3671875), 500 + (H - 4))];
  assert.ok(intersection(naiveTop(rows[0]), naiveTop(rows[1])) > 0);
  assertNoOverlap(placeLabels(rows));
});

test('a label never covers another object\'s dot', () => {
  const rows = [label('a', 400, 300), label('b', 400, 300 - LABEL_GAP - H / 2)];
  const placed = placeLabels(rows);
  const dotB = {x: 400 - DOT_RADIUS, y: rows[1].y - DOT_RADIUS, width: 2 * DOT_RADIUS, height: 2 * DOT_RADIUS};
  assert.equal(intersection(placed.get('a').rect, dotB), 0);
});

test('even eight objects on one point get eight readable labels', () => {
  const rows = Array.from({length: 8}, (_, i) => label(`Д-10${i + 1}`, 900, 500));
  const placed = placeLabels(rows);
  assert.equal(placed.size, 8);
  assertNoOverlap(placed);
});

test('placement is deterministic and does not depend on input order', () => {
  const rows = [label('Д-103', 610, 420), label('Д-101', 640, 430), label('Д-102', 600, 445), label('Д-105', 660, 410)];
  const first = placeLabels(rows);
  const second = placeLabels([...rows].reverse());
  assert.deepEqual([...first].sort(), [...second].sort());
  assertNoOverlap(first);
});

test('the selected object is placed first and keeps its place above the dot', () => {
  const rows = [label('Д-101', 1233, 773), label('Д-107', 1289, 765, {selected: true})];
  const placed = placeLabels(rows);
  assert.equal(placed.get('Д-107').placement, 'top');
  assert.notEqual(placed.get('Д-101').placement, 'top');
  assertNoOverlap(placed);
});

test('fixed map labels and the map edge are avoided when a free side exists', () => {
  const target = {x: 450, y: 360, width: 110, height: 20}; // e.g. «Цель А3 · план 12:45» just above the dot
  const nearTop = placeLabels([label('a', 500, 400)], {obstacles: [target]}).get('a');
  assert.equal(intersection(nearTop.rect, target), 0);
  const atEdge = placeLabels([label('b', 500, 20)], {area: {x: 0, y: 0, width: 1500, height: 1000}}).get('b');
  assert.equal(atEdge.placement, 'bottom');
  assert.ok(atEdge.rect.y >= 0);
});

test('offsets are symmetric and stacked levels keep the margin', () => {
  assert.deepEqual(labelOffset('top', W, H), [0, -(LABEL_GAP + H / 2)]);
  assert.deepEqual(labelOffset('bottom', W, H), [0, LABEL_GAP + H / 2]);
  assert.equal(labelOffset('top+1', W, H)[1] - labelOffset('top', W, H)[1], -(H + LABEL_MARGIN));
  assert.throws(() => labelOffset('middle', W, H));
});

test('priority places a label before others of lower priority; the selected label still goes first', () => {
  // Two labels competing for the same free side: the one placed first keeps «top».
  const rows = [label('A', 500, 400), label('Z-stop', 500 + W / 2, 400, {priority: 2})];
  const placed = placeLabels(rows);
  assertNoOverlap(placed);
  assert.equal(placed.get('Z-stop').placement, 'top', 'higher priority placed first despite its ID');
  const withSelected = placeLabels([...rows, label('S', 500 - W / 2, 400, {selected: true})]);
  assertNoOverlap(withSelected);
  assert.equal(withSelected.get('S').placement, 'top', 'the selected label is placed before any priority');
});

// ---- Label texts (C5) ----
const MINUS = String.fromCharCode(0x2212);

test('vehicle label: «опозд. +м:сс», never rounded to whole minutes; on time and no forecast said plainly', () => {
  assert.equal(vehicleLabelText('134040', {level: 'warning', prediction_s: 200}), '134040 · опозд. +3:20');
  assert.equal(vehicleLabelText('133300', {level: 'normal', prediction_s: 109}), '133300 · опозд. +1:49', '1:49 is not «+2 мин» (P2-2)');
  assert.equal(vehicleLabelText('135081', {level: 'normal', prediction_s: -86.3}), `135081 · опереж. ${MINUS}1:26`);
  assert.equal(vehicleLabelText('1', {level: 'normal', prediction_s: 12}), '1 · по графику');
  assert.equal(vehicleLabelText('2', {level: 'nodata', prediction_s: 400}), '2', 'a stale value is not on the map');
  assert.equal(vehicleLabelText('3', {level: 'severe', prediction_s: 725}), '3 · опозд. +12:05');
});

test('target label: «ЦЕЛЬ · ост. N · план → ожидается · +м:сс»; stale or missing values never shown as current', () => {
  assert.equal(targetLabelText({no: 12, plan: '08:42', expected: '08:45', delay: 200}), 'ЦЕЛЬ · ост. 12 · 08:42 → 08:45 · +3:20');
  assert.equal(targetLabelText({plan: '08:42', expected: '08:45', delay: 200}), 'ЦЕЛЬ · 08:42 → 08:45 · +3:20', 'route not loaded: no number');
  assert.equal(targetLabelText({no: 12, plan: '08:42', expected: null, delay: 200, stale: true}), 'ЦЕЛЬ · ост. 12 · 08:42 · прогноз устарел');
  assert.equal(targetLabelText({no: 12, plan: '08:42'}), 'ЦЕЛЬ · ост. 12 · 08:42 · прогноза нет');
  assert.equal(targetLabelText({no: 9, plan: '08:41', late: true}), 'ЦЕЛЬ · ост. 9 · 08:41 · прогноза не будет');
  assert.equal(targetLabelText({no: 12, plan: '08:42', expected: '08:42', delay: 10}), 'ЦЕЛЬ · ост. 12 · 08:42 → 08:42 · по графику');
  assert.equal(targetLabelText({no: 12, plan: '08:42', expected: '08:45', delay: 180, held: true}), 'ПРОШЛАЯ ЦЕЛЬ · ост. 12 · 08:42 → 08:45 · +3:00');
});

test('next stop label: «след. ост. N · план → по факту»', () => {
  assert.equal(nextLabelText({no: 5, plan: '08:32', expected: '08:33'}), 'след. ост. 5 · 08:32 → 08:33 · по факту');
  assert.equal(nextLabelText({no: 5, plan: '08:32', expected: null}), 'след. ост. 5 · 08:32');
});
