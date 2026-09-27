// Route context of the selected vehicle (consumer GET /api/route/{tr_id}) turned into what the map
// and the card show. Backend owns the roles of the stops; this module only decides which time each
// role may show and how it is labelled:
//   passed        — plan time only (grey);
//   before_target — plan + cur_dev_s, «по факту, не прогноз» (the current delay carried forward);
//   target        — plan + prediction_s, «прогноз модели»;
//   after_target  — plan + prediction_s, «допущение: тот же сдвиг», only while the toggle is on;
//   planned       — no target: plan time only.
// The model value is used only when the caller says it is usable (the row's `assess()` level, i.e.
// a current `normal` row from an online Backend); a stale or degraded value is never shown as
// «прогноз модели». Likewise the fact needs a current source.
// Coordinates outside the data extent, missing, or (0, 0) are never drawn.

// Extent of the data drawn on the map: the local tile extract (consumer/map/manifest.json) and
// Backend MAP_BBOX (transport_backend/orchestration.py), so the UI and Backend drop the same points.
// The camera may range wider (app.js CAMERA_BOUNDS); nothing is drawn outside this box.
export const DATA_BOUNDS = [[37.25, 55.5], [38.0, 56.0]];

export const BASIS = {
  fact: 'по факту, не прогноз',
  model: 'прогноз модели',
  assumption: 'допущение: тот же сдвиг',
};

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

export function coordOk(lon, lat) {
  if (!finite(lon) || !finite(lat)) return false;
  const x = Number(lon), y = Number(lat);
  return x >= DATA_BOUNDS[0][0] && x <= DATA_BOUNDS[1][0] && y >= DATA_BOUNDS[0][1] && y <= DATA_BOUNDS[1][1];
}

// «1 мин 35 с», «45 с», «2 мин»; sign handled by the caller.
export function durationText(seconds) {
  if (!finite(seconds)) return null;
  const total = Math.round(Math.abs(Number(seconds)));
  const m = Math.floor(total / 60), s = total % 60;
  if (!m) return `${s} с`;
  return s ? `${m} мин ${s} с` : `${m} мин`;
}

// «+2 мин 20 с», «−30 с», «0 с».
export function signedDurationText(seconds) {
  if (!finite(seconds)) return null;
  const value = Math.round(Number(seconds));
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${durationText(value)}`;
}

// Seconds of the day from «HH:MM[:SS]» or an ISO date-time.
function daySeconds(time) {
  const match = typeof time === 'string' ? /(?:^|T|\s)(\d{2}):(\d{2})(?::(\d{2}))?/.exec(time) : null;
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0) : null;
}

const pad = n => String(n).padStart(2, '0');
function clock(seconds, withSeconds) {
  const day = ((Math.round(seconds) % 86400) + 86400) % 86400;
  const text = `${pad(Math.floor(day / 3600))}:${pad(Math.floor(day / 60) % 60)}`;
  return withSeconds || day % 60 ? `${text}:${pad(day % 60)}` : text;
}

// Plan time as written in the timetable: «06:52», or «06:52:30» when it has seconds.
export function planText(time) {
  const seconds = daySeconds(time);
  return seconds === null ? null : clock(seconds, false);
}

// Plan time shifted by a delay: «~06:53:35».
export function shiftedText(time, delay) {
  const seconds = daySeconds(time);
  return seconds === null || !finite(delay) ? null : `~${clock(seconds + Number(delay), true)}`;
}

// One row per stop of the route payload, in the Backend's (time) order.
// `modelUsable` / `factUsable` are the caller's decision about the vehicle row (both required).
export function stopRows(route, {shiftAfterTarget = true, modelUsable, factUsable}) {
  if (typeof modelUsable !== 'boolean' || typeof factUsable !== 'boolean') throw new TypeError('stopRows needs modelUsable and factUsable');
  const stops = Array.isArray(route?.stops) ? route.stops : [];
  const cur = factUsable && finite(route?.cur_dev_s) ? Number(route.cur_dev_s) : null;
  const prediction = modelUsable && finite(route?.prediction_s) ? Number(route.prediction_s) : null;
  return stops.map(stop => {
    const role = stop.role;
    let delay = null, basis = null;
    if (role === 'before_target' && cur !== null) { delay = cur; basis = 'fact'; }
    else if (role === 'target' && prediction !== null) { delay = prediction; basis = 'model'; }
    else if (role === 'after_target' && prediction !== null && shiftAfterTarget) { delay = prediction; basis = 'assumption'; }
    return {
      stop_id: stop.stop_id == null ? null : String(stop.stop_id),
      role,
      lon: Number(stop.lon), lat: Number(stop.lat),
      onMap: coordOk(stop.lon, stop.lat),
      plan: planText(stop.time),
      expected: basis ? shiftedText(stop.time, delay) : null,
      basis,
    };
  });
}

// The two stops whose times are written on the map: the target, and the nearest future stop
// before it (without a target: the first planned stop). Hover and the card show the others.
export function labelledStops(rows) {
  const drawable = rows.filter(r => r.onMap);
  const target = drawable.find(r => r.role === 'target') ?? null;
  const next = target
    ? drawable.find(r => r.role === 'before_target') ?? null
    : drawable.find(r => r.role === 'planned') ?? null;
  return {target, next};
}

// A GPS line as drawable pieces: invalid points split the line instead of joining through them.
// Accepts [lon, lat] and [lon, lat, time] points.
export function lineParts(points) {
  const parts = [];
  let current = [];
  for (const point of Array.isArray(points) ? points : []) {
    if (Array.isArray(point) && coordOk(point[0], point[1])) current.push([Number(point[0]), Number(point[1])]);
    else { if (current.length > 1) parts.push(current); current = []; }
  }
  if (current.length > 1) parts.push(current);
  return parts;
}

// Count of payload points or stops that cannot be drawn (missing, outside the map, 0/0).
export function undrawnCount(route) {
  const bad = list => (Array.isArray(list) ? list : []).filter(p => !(Array.isArray(p) ? coordOk(p[0], p[1]) : coordOk(p?.lon, p?.lat))).length;
  return {path: bad(route?.path), passed: bad(route?.passed), stops: bad(route?.stops)};
}

// Stop thinning on the map below DECLUTTER_BELOW_ZOOM (route-layers.js). Pure: points are
// [{row, x, y}] in screen pixels, in preference order; `avoid` are points to keep clear of (the
// target, the labelled stop). A stop is kept if it is at least `gap` px from all kept and avoided.
export const DECLUTTER_BELOW_ZOOM = 13;
export const MIN_STOP_GAP_PX = 14;
export function thinStops(points, {avoid = [], gap = MIN_STOP_GAP_PX} = {}) {
  const kept = [];
  const far = p => [...avoid, ...kept].every(q => Math.hypot(p.x - q.x, p.y - q.y) >= gap);
  for (const p of points) if (far(p)) kept.push(p);
  return kept.map(p => p.row);
}

// Which selected-route layers a /api/route `route_line` asks for, bottom to top (also the value of
// `#map-pane[data-route-layers]`). on_route: passed dim + ahead bright; otherwise the whole window
// line dim (if any), and for off_route a leader from the vehicle to `nearest` of the day's line.
const drawablePoint = p => Array.isArray(p) && coordOk(p[0], p[1]);
export function routeLayersFor(routeLine, vehiclePoint) {
  if (!routeLine) return [];
  if (routeLine.split_reason === 'on_route') return ['route-passed', 'route-ahead'];
  const layers = lineParts(routeLine.line ?? []).length ? ['route-dim'] : [];
  if (routeLine.split_reason === 'off_route' && drawablePoint(routeLine.nearest) && drawablePoint(vehiclePoint)) layers.push('offroute-leader');
  return layers;
}

// «~3,4 км» / «~400 м» for route_offset_m.
export function offsetText(meters) {
  if (meters == null || !Number.isFinite(Number(meters))) return null;
  const m = Number(meters);
  return m >= 1000 ? `~${(m / 1000).toLocaleString('ru-RU', {maximumFractionDigits: 1})} км` : `~${Math.round(m / 10) * 10} м`;
}
