// Route context of the selected vehicle on the map: ordinary MapLibre layers under the transport
// layer. The grey GPS path of this run (display only — not an official route and not a model
// input), the passed part in colour, and the timetable stops of the window as small white circles
// with a dark border (a vehicle is a bus icon, the target a diamond with a flag: map-symbols.js).
// Hovering a stop shows its plan, expected time and basis.
//
// Below DECLUTTER_BELOW_ZOOM the stops are thinned on screen (task T-7 UI review M-2): the nearest
// labelled stop is always kept, then each stop only if it is at least MIN_STOP_GAP_PX (route-context.js) from every
// stop already kept and from the target. Redone on every zoom change; the card still lists all.

import * as maplibregl from 'maplibre-gl';
import {BASIS, DECLUTTER_BELOW_ZOOM, lineParts, thinStops} from './route-context.js';

export const ROLE = {passed: 'пройдена', before_target: 'до цели', target: 'цель', after_target: 'после цели', planned: 'по плану'};
const COLOR = {path: '#6f8190', passed: '#2f6f9f', stop: '#1b2a36', stopPassed: '#a9b3ba'};
const LAYERS = ['route-path-casing', 'route-path', 'route-passed', 'route-stops'];
const empty = {type: 'FeatureCollection', features: []};
const multiLine = parts => ({type: 'FeatureCollection', features: parts.length
  ? [{type: 'Feature', properties: {}, geometry: {type: 'MultiLineString', coordinates: parts}}] : []});

// One line of a stop for hover and the card: «до цели · план 06:52 → ~06:53:35 · по факту, не прогноз».
export function stopTip(row) {
  return [ROLE[row.role] ?? row.role, `план ${row.plan ?? 'неизвестно'}${row.expected ? ` → ${row.expected}` : ''}`,
    row.basis ? BASIS[row.basis] : null].filter(Boolean).join(' · ');
}

export function createRouteLayers(map) {
  let popup = null;
  let drawn = []; // stop rows on the map now (for label obstacles)
  let last = {data: null, rows: [], keep: null, target: null};
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
      .map(r => ({type: 'Feature', properties: {role: r.role, tip: stopTip(r)}, geometry: {type: 'Point', coordinates: [r.lon, r.lat]}}))});
  };
  return {
    // Called once on map load, before the transport layer is added on top.
    add() {
      for (const id of ['route-path', 'route-passed', 'route-stops']) map.addSource(id, {type: 'geojson', data: empty});
      const round = {'line-cap': 'round', 'line-join': 'round'};
      map.addLayer({id: 'route-path-casing', type: 'line', source: 'route-path', layout: round,
        paint: {'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9}});
      map.addLayer({id: 'route-path', type: 'line', source: 'route-path', layout: round,
        paint: {'line-color': COLOR.path, 'line-width': 4}});
      map.addLayer({id: 'route-passed', type: 'line', source: 'route-passed', layout: round,
        paint: {'line-color': COLOR.passed, 'line-width': 5}});
      const passed = ['==', ['get', 'role'], 'passed'];
      map.addLayer({id: 'route-stops', type: 'circle', source: 'route-stops',
        paint: {'circle-radius': ['case', passed, 3.5, 5], 'circle-color': '#ffffff',
          'circle-stroke-color': ['case', passed, COLOR.stopPassed, COLOR.stop], 'circle-stroke-width': ['case', passed, 1.5, 2.5]}});
    },
    // data: the route payload on screen or null; rows: its stopRows (route-context.js);
    // keep: the stop row with a time label (always drawn); target: [lon, lat] of the target symbol.
    render(data, rows, {keep = null, target = null} = {}) {
      if (!LAYERS.every(id => map.getLayer(id))) return;
      last = {data, rows: data ? rows : [], keep, target};
      map.getSource('route-path').setData(multiLine(data ? lineParts(data.path) : []));
      map.getSource('route-passed').setData(multiLine(data ? lineParts(data.passed) : []));
      drawStops();
    },
    // After a zoom: the thinning depends on screen distances.
    rethin() { if (LAYERS.every(id => map.getLayer(id))) drawStops(); },
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
