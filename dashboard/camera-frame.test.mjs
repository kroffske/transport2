import test from 'node:test';
import assert from 'node:assert/strict';
import {FRAME_GAP, FRAME_LABEL_H, FRAME_MARGIN, MIN_FRAME, TARGET_LABEL_W, edgeAnchor, framePadding} from './camera-frame.js';

const rect = (left, top, width, height) => ({left, top, right: left + width, bottom: top + height});
// 1920×1080 three columns: the map is 0–1120 under a 56 px header.
const fhdPane = rect(0, 56, 1120, 1024);
// 1366×768 laptop: the map is 0–1046; the card panel covers 626–1046 when open.
const laptopPane = rect(0, 56, 1046, 712);
const laptopCard = rect(626, 56, 420, 712);

// The legend is a vertical panel docked to the map's left edge, bottom-anchored.
const fhdLegend = rect(14, 790, 200, 260);

test('top clears the attention bar with a gap and a label; left clears the legend panel with a gap', () => {
  const pad = framePadding({pane: fhdPane, attention: rect(14, 70, 600, 58), legend: fhdLegend});
  assert.equal(pad.top, 128 - 56 + FRAME_GAP + FRAME_LABEL_H);
  assert.equal(pad.left, 214 + FRAME_GAP);
  assert.deepEqual([pad.bottom, pad.right], [FRAME_MARGIN, FRAME_MARGIN]);
});

test('a legend narrower than the margin keeps the minimum margin on the left', () => {
  assert.equal(framePadding({pane: fhdPane, legend: rect(0, 900, 10, 100)}).left, FRAME_MARGIN);
});

test('without panels every side keeps the minimum margin', () => {
  assert.deepEqual(framePadding({pane: fhdPane}), {top: FRAME_MARGIN, bottom: FRAME_MARGIN, left: FRAME_MARGIN, right: FRAME_MARGIN});
});

test('a card column beside the map covers nothing; a card panel over the map adds its width on the right', () => {
  assert.equal(framePadding({pane: fhdPane, overlay: rect(1120, 56, 440, 1024)}).right, FRAME_MARGIN);
  assert.equal(framePadding({pane: laptopPane, overlay: laptopCard}).right, FRAME_MARGIN + 420);
});

test('the target label adds room only when the target is the east-most point', () => {
  assert.equal(framePadding({pane: fhdPane, targetEast: true}).right, FRAME_MARGIN + TARGET_LABEL_W);
  assert.equal(framePadding({pane: fhdPane, targetEast: true, targetLabelWidth: 180}).right, FRAME_MARGIN + 180);
  assert.equal(framePadding({pane: fhdPane, targetEast: false, targetLabelWidth: 180}).right, FRAME_MARGIN);
});

test('laptop with the panel open and the target east: frame keeps MIN_FRAME, the label room gives way first', () => {
  const narrow = rect(0, 56, 780, 712); // 1100 px window: 1100 − 320 queue
  const pad = framePadding({pane: narrow, overlay: rect(360, 56, 420, 712), targetEast: true});
  assert.equal(780 - pad.left - pad.right, MIN_FRAME);
  assert.equal(pad.left, FRAME_MARGIN);
  assert.ok(pad.right >= 420, 'the covered strip is never given up');
});

test('at 1366 px with the panel open the full label room still fits', () => {
  const pad = framePadding({pane: laptopPane, overlay: laptopCard, targetEast: true});
  assert.equal(pad.right, FRAME_MARGIN + 420 + TARGET_LABEL_W);
  assert.ok(1046 - pad.left - pad.right >= MIN_FRAME);
});

test('at 1366 px with the panel open, the legend and the target east: the label room gives way first', () => {
  const pad = framePadding({pane: laptopPane, overlay: laptopCard, legend: rect(14, 400, 200, 330), targetEast: true});
  assert.equal(1046 - pad.left - pad.right, MIN_FRAME);
  assert.equal(pad.left, 214 + FRAME_GAP);
  assert.ok(pad.right >= FRAME_MARGIN + 420 && pad.right < FRAME_MARGIN + 420 + TARGET_LABEL_W);
});

test('a narrow map: label, then the gaps, then the legend strip give way; the card panel strip stays', () => {
  const narrow = rect(0, 56, 780, 712); // 1100 px window: 1100 − 320 queue
  const pad = framePadding({pane: narrow, overlay: rect(360, 56, 420, 712), legend: rect(14, 400, 200, 330), targetEast: true});
  assert.equal(780 - pad.left - pad.right, MIN_FRAME);
  assert.equal(pad.right, 420, 'the covered strip is never given up; the right margin and the label are gone');
  assert.equal(pad.left, 780 - MIN_FRAME - 420, 'the legend strip keeps what is left');
});

test('a short map shrinks top and bottom in proportion to keep MIN_FRAME', () => {
  const pad = framePadding({pane: rect(0, 56, 1000, 400), attention: rect(14, 70, 400, 200), legend: rect(14, 230, 200, 200)});
  assert.ok(400 - pad.top - pad.bottom >= MIN_FRAME);
  assert.ok(pad.top > pad.bottom);
});

test('edge arrow: none while the point is inside the zone', () => {
  assert.equal(edgeAnchor(rect(0, 0, 600, 400), {x: 100, y: 100}), null);
});

test('edge arrow: on the border towards the point, the label kept whole inside', () => {
  const zone = rect(0, 0, 600, 400);
  const east = edgeAnchor(zone, {x: 2000, y: 200}, {width: 160, height: 30});
  assert.deepEqual([east.x, east.y, east.angle], [520, 200, 0]);
  const north = edgeAnchor(zone, {x: 300, y: -900}, {width: 160, height: 30});
  assert.deepEqual([north.x, north.y, north.angle], [300, 15, -90]);
  const corner = edgeAnchor(zone, {x: -3000, y: 3000}, {width: 100, height: 20});
  assert.ok(corner.x >= 50 && corner.y <= 390 && corner.angle > 90 && corner.angle < 180);
});
