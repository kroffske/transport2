// Routes on the map: ordinary MapLibre layers under the transport layer. What is drawn is the
// planned route of the day assignment (a line through its timetable stops), never the GPS track.
//
//   overview   — every vehicle's route in the display window (/api/routes `line`), thin and muted;
//   selected   — /api/route `route_line` (Backend decides the split at the vehicle, the UI never
//                computes it): on_route → `passed` dim and `ahead` bright with direction arrows up
//                to the target stop; past the target (`splitAtTarget`: the target is a vertex of
//                the line) a dashed slate line without arrows — times there are only an assumption;
//                any other split_reason → the whole `line` dim; off_route → plus a dashed leader
//                from the vehicle to `nearest` (the label with the distance is a DOM label, app.js);
//   stops      — the timetable stops of the selected vehicle's window, their role told by shape
//                (map-symbols.js `stopLook`, spec §S): passed a small grey dot, before the target a
//                white circle with a solid ink ring, after the target a dashed slate ring; the
//                target is the diamond with a flag of the transport layer, a vehicle a bus icon.
// Hovering a stop shows its role, plan, expected time and basis.
//
// Every route line is drawn shifted to the right of its direction of travel (`line-offset`, the
// line coordinates are in travel order): the two directions of an out-and-back or loop route on
// the same street separate instead of being drawn on top of each other (T-7 W14). The geometry
// may be a dense road-following polyline; stops are drawn from the route's stops, never from the
// line's vertices.
//
// Below DECLUTTER_BELOW_ZOOM the stops are thinned on screen (task T-7 UI review M-2): the labelled
// stop is always kept, then each stop only if it is at least MIN_STOP_GAP_PX (route-context.js)
// from every stop already kept and from the target. Redone on every zoom change; the card lists all.

import * as maplibregl from 'maplibre-gl';
import {STOP_COLOR, drawStopSymbol, stopKind, stopLook} from './map-symbols.js';
import {BASIS, DECLUTTER_BELOW_ZOOM, lineParts, routeLayersFor, thinStops} from './route-context.js';

export const ROLE = {passed: 'пройдена', before_target: 'до цели', target: 'цель', after_target: 'после цели', planned: 'по плану'};
export const ROUTE_COLOR = {overview: '#7f8d99', dim: '#a4b0b9', ahead: '#1565c0', after: STOP_COLOR.after, leader: '#1b2a36'};
const SOURCES = ['routes-all', 'route-dim', 'route-passed', 'route-after', 'route-ahead', 'offroute-leader', 'route-stops'];
const empty = {type: 'FeatureCollection', features: []};
const multiLine = parts => ({type: 'FeatureCollection', features: parts.length
  ? [{type: 'Feature', properties: {}, geometry: {type: 'MultiLineString', coordinates: parts}}] : []});

// One line of a stop for hover and the card: «до цели · план 06:52 → ~06:53:35 · по факту, не прогноз».
export function stopTip(row) {
  return [ROLE[row.role] ?? row.role, `план ${row.plan ?? 'неизвестно'}${row.expected ? ` → ${row.expected}` : ''}`,
    row.basis ? BASIS[row.basis] : null].filter(Boolean).join(' · ');
}

// The `ahead` points of an on_route line cut at the target stop: `toTarget` ends at the target,
// `after` starts there (the target point is in both). Backend puts every stop coordinate of the
// window into the line exactly (anchors), so the target is found as a vertex; a stop served twice
// in the window (loop) is skipped once per earlier `before_target` row at the same place. Without
// a drawable target, or when the target is not on `ahead`, all of it stays `toTarget`.
const SAME_POINT_DEG = 1e-6; // ≈ 0.1 m
export function splitAtTarget(ahead, rows) {
  const points = Array.isArray(ahead) ? ahead : [];
  const target = (rows ?? []).find(r => r.role === 'target' && r.onMap);
  if (!target) return {toTarget: points, after: []};
  const at = (p, r) => Array.isArray(p) && Math.abs(Number(p[0]) - r.lon) <= SAME_POINT_DEG && Math.abs(Number(p[1]) - r.lat) <= SAME_POINT_DEG;
  // A repeated vertex (anchor next to the first shape point) is one visit.
  const hits = points.flatMap((p, i) => (at(p, target) && !(i && at(points[i - 1], target)) ? [i] : []));
  if (!hits.length) return {toTarget: points, after: []};
  const earlier = rows.filter(r => r.role === 'before_target' && at([r.lon, r.lat], target)).length;
  const cut = hits[Math.min(earlier, hits.length - 1)];
  return {toTarget: points.slice(0, cut + 1), after: points.slice(cut)};
}

// A white chevron pointing along the line; MapLibre turns it with the line direction.
function arrowImage() {
  const ratio = 2, w = 12, h = 12;
  const canvas = document.createElement('canvas');
  canvas.width = w * ratio; canvas.height = h * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(3.5, 2.5); ctx.lineTo(8.5, 6); ctx.lineTo(3.5, 9.5); ctx.stroke();
  return {image: ctx.getImageData(0, 0, canvas.width, canvas.height), ratio};
}

// Right-of-travel shift in px by zoom: thin overview lines need less than the selected route,
// whose two directions (5.5 px wide each) must keep a gap. The arrows follow the selected shift
// (icon y offset: +y is the right of a line-placed icon).
const OFFSET = ['interpolate', ['linear'], ['zoom'], 10, 1.5, 13, 2.5, 16, 4];
const SELECTED_STOPS = [10, 3, 13, 4, 15, 4.5, 16, 6];
const SELECTED_OFFSET = ['interpolate', ['linear'], ['zoom'], ...SELECTED_STOPS];
const ARROW_OFFSET = ['interpolate', ['linear'], ['zoom'],
  ...SELECTED_STOPS.flatMap((value, i) => (i % 2 ? [['literal', [0, value]]] : [value]))];

export function createRouteLayers(map) {
  let popup = null;
  let drawn = []; // stop rows on the map now (for label obstacles)
  let last = {data: null, rows: [], keep: null, target: null};
  const ready = () => SOURCES.every(id => map.getSource(id));
  const visibleStops = () => {
    const {rows, keep, target} = last;
    const candidates = rows.filter(r => r.onMap && r.role !== 'target');
    if (map.getZoom() >= DECLUTTER_BELOW_ZOOM) return candidates;
    const project = r => { const p = map.project([r.lon, r.lat]); return {row: r, x: p.x, y: p.y}; };
    const ordered = [...candidates.filter(r => r === keep), ...candidates.filter(r => r !== keep)].map(project);
    const avoid = target ? [map.project(target)].map(p => ({x: p.x, y: p.y})) : [];
    const kept = thinStops(ordered.slice(keep ? 1 : 0), {avoid: [...avoid, ...ordered.slice(0, keep ? 1 : 0)]});
    return keep ? [keep, ...kept] : kept;
  };
  const drawStops = () => {
    drawn = last.data ? visibleStops() : [];
    map.getSource('route-stops').setData({type: 'FeatureCollection', features: drawn
      .map(r => ({type: 'Feature', properties: {role: r.role, look: stopKind(r.role), tip: stopTip(r)}, geometry: {type: 'Point', coordinates: [r.lon, r.lat]}}))});
  };
  return {
    // Called once on map load, before the transport layer is added on top.
    add() {
      for (const id of SOURCES) map.addSource(id, {type: 'geojson', data: empty});
      const {image, ratio} = arrowImage();
      map.addImage('route-arrow', image, {pixelRatio: ratio});
      for (const role of ['passed', 'before_target', 'after_target']) {
        const look = stopLook(role);
        const {canvas} = drawStopSymbol(look, 2);
        map.addImage(`stop-${look.stop}`, canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height), {pixelRatio: 2});
      }
      const round = {'line-cap': 'round', 'line-join': 'round'};
      map.addLayer({id: 'routes-all', type: 'line', source: 'routes-all', layout: round,
        paint: {'line-color': ROUTE_COLOR.overview, 'line-opacity': 0.55,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 15, 2.5], 'line-offset': OFFSET}});
      map.addLayer({id: 'route-dim', type: 'line', source: 'route-dim', layout: round,
        paint: {'line-color': ROUTE_COLOR.dim, 'line-width': 4.5, 'line-offset': SELECTED_OFFSET}});
      map.addLayer({id: 'route-passed', type: 'line', source: 'route-passed', layout: round,
        paint: {'line-color': ROUTE_COLOR.dim, 'line-width': 4.5, 'line-offset': SELECTED_OFFSET}});
      // After the target: dashed slate over a light casing, no arrows (spec §S).
      map.addLayer({id: 'route-after-casing', type: 'line', source: 'route-after', layout: round,
        paint: {'line-color': '#ffffff', 'line-width': 6.5, 'line-opacity': 0.75, 'line-offset': SELECTED_OFFSET}});
      map.addLayer({id: 'route-after', type: 'line', source: 'route-after', layout: {'line-cap': 'butt', 'line-join': 'round'},
        paint: {'line-color': ROUTE_COLOR.after, 'line-width': 3.5, 'line-dasharray': [2, 1.5], 'line-offset': SELECTED_OFFSET}});
      map.addLayer({id: 'route-ahead-casing', type: 'line', source: 'route-ahead', layout: round,
        paint: {'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9, 'line-offset': SELECTED_OFFSET}});
      map.addLayer({id: 'route-ahead', type: 'line', source: 'route-ahead', layout: round,
        paint: {'line-color': ROUTE_COLOR.ahead, 'line-width': 5.5, 'line-offset': SELECTED_OFFSET}});
      map.addLayer({id: 'route-ahead-arrows', type: 'symbol', source: 'route-ahead',
        layout: {'symbol-placement': 'line', 'symbol-spacing': 80, 'icon-image': 'route-arrow',
          'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map',
          'icon-offset': ARROW_OFFSET}});
      map.addLayer({id: 'offroute-leader', type: 'line', source: 'offroute-leader', layout: {'line-cap': 'butt'},
        paint: {'line-color': ROUTE_COLOR.leader, 'line-width': 2, 'line-dasharray': [2, 2]}});
      // A symbol layer, not a circle layer: MapLibre cannot dash a circle stroke.
      map.addLayer({id: 'route-stops', type: 'symbol', source: 'route-stops',
        layout: {'icon-image': ['concat', 'stop-', ['get', 'look']], 'icon-allow-overlap': true, 'icon-ignore-placement': true}});
    },
    // routes: /api/routes `routes`; the selected vehicle's own route is drawn by `render`.
    renderOverview(routes, selectedId) {
      if (!ready()) return;
      const parts = routes.filter(r => String(r.tr_id) !== selectedId).flatMap(r => lineParts(r.line ?? []));
      map.getSource('routes-all').setData({type: 'FeatureCollection', features: parts
        .map(coordinates => ({type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates}}))});
    },
    // data: the route payload on screen or null; rows: its stopRows (route-context.js);
    // keep: the stop row with a time label (always drawn); target: [lon, lat] of the target symbol;
    // vehicle: [lon, lat] of the vehicle symbol (the leader starts there).
    // Returns the selected-route layers route_line asks for, bottom to top (routeLayersFor; the
    // dashed part after the target is drawn within `route-ahead`, not listed separately).
    render(data, rows, {keep = null, target = null, vehicle = null} = {}) {
      if (!ready()) return [];
      const routeLine = data?.route_line ?? null;
      const layers = routeLayersFor(routeLine, vehicle);
      const on = name => layers.includes(name);
      map.getSource('route-dim').setData(multiLine(on('route-dim') ? lineParts(routeLine.line) : []));
      map.getSource('route-passed').setData(multiLine(on('route-passed') ? lineParts(routeLine.passed ?? []) : []));
      const {toTarget, after} = on('route-ahead') ? splitAtTarget(routeLine.ahead, rows) : {toTarget: [], after: []};
      map.getSource('route-ahead').setData(multiLine(lineParts(toTarget)));
      map.getSource('route-after').setData(multiLine(lineParts(after)));
      map.getSource('offroute-leader').setData(multiLine(on('offroute-leader') ? [[vehicle, routeLine.nearest]] : []));
      last = {data, rows: data ? rows : [], keep, target};
      drawStops();
      return layers;
    },
    // After a zoom: the thinning depends on screen distances.
    rethin() { if (ready()) drawStops(); },
    drawnStops: () => drawn,
    // Mouse event over the map, or null to hide the tip.
    showTip(event) {
      const features = event && map.getLayer('route-stops') ? map.queryRenderedFeatures(event.point, {layers: ['route-stops']}) : [];
      if (!features.length) { popup?.remove(); popup = null; return; }
      popup ??= new maplibregl.Popup({closeButton: false, closeOnClick: false, className: 'stop-tip', offset: 8});
      popup.setLngLat(features[0].geometry.coordinates).setText(`Остановка · ${features[0].properties.tip}`).addTo(map);
    },
  };
}
