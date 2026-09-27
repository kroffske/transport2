// Map symbols of the transport layer: what a vehicle or the target looks like, and their bitmaps.
//
// Every state differs by shape, not only by colour (task T-7, «Карта (W7)»):
//   vehicle      — rounded square with the Lucide `bus` glyph; never a circle, so never a stop;
//   warning      — badge «!» (≥ 5 min: «!!») at the top-right corner;
//   no current prediction (stale, degraded, Backend offline) — hollow white icon, dashed border;
//   invalid GPS  — grey icon with badge «?», drawn at the last valid position;
//   selected     — larger icon inside a dark ring; hovered — thin blue ring;
//   target       — white diamond with a dark border and the Lucide `flag` glyph;
//   stop         — small white circle with a dark border (a MapLibre layer, route-layers.js).
// `vehicleLook`/`targetLook` are pure; `drawSymbol` needs a browser canvas.

import {bus, flag} from './icons/lucide.js';

export const VEHICLE_SIZE = 24; // css px, the icon body
export const SELECTED_SIZE = 32;
export const TARGET_SIZE = 30;
const PAD = 10; // room around the body for the ring and the badge
const INK = '#1b2a36';
const GREY = '#5d6b76';
const LEVEL_FILL = {severe: '#c8412f', warning: '#e39a2d', normal: '#23845f', nodata: '#ffffff'};

// level: severe | warning | normal | nodata (incidents.js assess).
export function vehicleLook(level, {gpsValid = true, selected = false, hovered = false} = {}) {
  const stale = level === 'nodata';
  return {
    kind: 'vehicle',
    size: selected ? SELECTED_SIZE : VEHICLE_SIZE,
    fill: !gpsValid ? '#cfd5d9' : LEVEL_FILL[level],
    glyph: !gpsValid || stale ? GREY : level === 'warning' ? INK : '#ffffff',
    border: stale ? 'dashed' : 'solid',
    badge: !gpsValid ? '?' : level === 'severe' ? '!!' : level === 'warning' ? '!' : null,
    ring: selected ? 'selected' : hovered ? 'hovered' : null,
  };
}

export const targetLook = () => ({kind: 'target', size: TARGET_SIZE});

// The parts of a look that do not depend on colour: two states must differ here.
export const shapeOf = look => [look.kind, look.size, look.border ?? '', look.badge ?? '', look.ring ?? ''].join('|');

export const symbolKey = look => JSON.stringify(look);

function strokeIcon(ctx, nodes, size, color, width = 2.4) {
  const k = size / 24;
  ctx.save();
  ctx.translate(-size / 2, -size / 2);
  ctx.scale(k, k);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [tag, attrs] of nodes) {
    if (tag === 'path') ctx.stroke(new Path2D(attrs.d));
    else if (tag === 'circle') { ctx.beginPath(); ctx.arc(attrs.cx, attrs.cy, attrs.r, 0, 2 * Math.PI); ctx.stroke(); }
  }
  ctx.restore();
}

function drawVehicle(ctx, look) {
  const s = look.size;
  if (look.ring) {
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.62 + 3, 0, 2 * Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = look.ring === 'selected' ? 3 : 2.5;
    ctx.strokeStyle = look.ring === 'selected' ? '#10202e' : '#2f6f9f';
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.roundRect(-s / 2, -s / 2, s, s, s * 0.26);
  ctx.fillStyle = look.fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = look.border === 'dashed' ? GREY : INK;
  ctx.setLineDash(look.border === 'dashed' ? [3.2, 2.4] : []);
  ctx.stroke();
  ctx.setLineDash([]);
  strokeIcon(ctx, bus, s * 0.66, look.glyph);
  if (look.badge) {
    const r = 7;
    const x = s / 2 - 2, y = -s / 2 + 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = look.badge === '?' ? GREY : INK;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${look.badge.length > 1 ? 8.5 : 10}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(look.badge, x, y + 0.5);
  }
}

function drawTarget(ctx, look) {
  const half = look.size / 2;
  ctx.beginPath();
  ctx.moveTo(0, -half); ctx.lineTo(half, 0); ctx.lineTo(0, half); ctx.lineTo(-half, 0); ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.stroke();
  strokeIcon(ctx, flag, look.size * 0.46, INK, 2.6);
}

// A bitmap of the symbol: `box` css px square (body + padding), drawn at `ratio` device pixels.
export function drawSymbol(look, ratio = 2) {
  const box = look.size + 2 * PAD;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.ceil(box * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.translate(box / 2, box / 2);
  if (look.kind === 'target') drawTarget(ctx, look);
  else drawVehicle(ctx, look);
  return {canvas, box};
}
