import * as maplibregl from 'maplibre-gl';
import {PMTiles, Protocol} from 'pmtiles';
import {NOTE_MAX, acknowledge, addNote, assess, countByFilter, createIncidentStore, findIncident, incidentCounts,
  incidentForVehicle, markRead, observeSnapshot, orderedIncidents, reopen, visibleRows} from './incidents.js';
import {patchChildren, patchText} from './dom.js';
import {placeLabels} from './map-labels.js';
import {drawSymbol, shapeOf, targetLook, vehicleLook} from './map-symbols.js';
import {reasonText} from './reasons.js';
import {BASIS, coordOk, durationText, labelledStops, planText, shiftedText, signedDurationText,
  stopRows, undrawnCount} from './route-context.js';
import {createRouteLayers} from './route-layers.js';
import {createRunTracker, dataTimeText, runStateText, shortRunId, sourceText, speedupText} from './run.js';
import {createTransportLayer} from './transport-layer.js';
import './style.css';

const $ = id => document.getElementById(id);
const text = value => value === null || value === undefined || value === '' ? 'неизвестно' : String(value);
const minutes = seconds => seconds == null || !Number.isFinite(Number(seconds)) ? 'неизвестно' : `${(Number(seconds) / 60).toFixed(1)} мин`;
const ageText = seconds => seconds == null || !Number.isFinite(Number(seconds)) ? 'неизвестно' : `${Number(seconds).toFixed(0)} с назад`;
const clockText = iso => typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : text(iso);
const percentText = ratio => ratio == null || ratio === '' || !Number.isFinite(Number(ratio)) ? '—'
  : `${(Number(ratio) * 100).toLocaleString('ru-RU', {maximumFractionDigits: 1})} %`;
// Backend `lon/lat` is the last valid GPS position; `location_valid` describes the latest frame.
// A vehicle is drawn at that position when it lies inside the data extent (DATA_BOUNDS); with an
// invalid latest frame it is drawn grey with «?» (map-symbols.js). No position: listed, not drawn.
const locationOk = v => coordOk(v.lon, v.lat);
const gpsValid = v => v.location_valid === true;
const positionNote = v => (locationOk(v) ? (gpsValid(v) ? '' : 'GPS недостоверен · последняя позиция')
  : v.lon != null && v.lat != null && !(Number(v.lon) === 0 && Number(v.lat) === 0) ? 'вне карты' : 'без позиции');
const targetOk = v => coordOk(v.target_lon, v.target_lat);

const LEVEL = {
  severe: {label: 'Сильная задержка'},
  warning: {label: 'Предупреждение'},
  normal: {label: 'В пределах нормы'},
  nodata: {label: 'Нет прогноза'},
};
const FILTER_LABEL = {all: 'Все', warning: 'С предупреждениями', nodata: 'Нет прогноза'};
const STATUS = {normal: 'данные в норме', degraded: 'данные частично устарели', unavailable: 'прогноз недоступен'};
const DEFAULT_VIEW = {center: [37.6173, 55.7558], zoom: 11};
const TOAST_MS = 15000;
const POLL_MS = 1500;
const ROUTE_REFRESH_MS = 3000;
const INCIDENT_STATE = {active: 'Активно', monitoring_lost: 'Мониторинг потерян', resolved: 'Задержка закончилась'};
const WORKFLOW = {new: 'Новое', in_work: 'В работе'};
// The camera may range wider than the data extent, so a 1500×1024 map can zoom out far enough to show
// every vehicle of a run at once; nothing is drawn outside DATA_BOUNDS (route-context.js).
const CAMERA_BOUNDS = [[36.8, 55.42], [38.45, 56.08]];
const STOP_OBSTACLE_PX = 12; // an unlabelled route stop kept clear of time labels

// ---- Page state -------------------------------------------------------------------------
let feed = {status: 'loading', snapshot: null}; // {status: loading|online|offline, snapshot, reason, age_s, fetched_at, checked_at}
let receivedAt = performance.now();
let filter = 'all';
let query = '';
let selected = null;
let hovered = null;
let visible = [];
let pendingOverview = true;
let mapStatus = 'loading'; // loading | ready | unavailable
let mapReason = '';
let manifest = null;
const runs = createRunTracker();
// Local events and dispatcher actions of the run on screen. The epoch is part of every incident ID,
// so a control left from a previous run can never act on an episode of the new one.
let epoch = 1;
let incidents = createIncidentStore(`live${epoch}`);
let eventsOpen = false;
let toasts = []; // [{id, timer}] — one per newly opened episode
let noteDraft = {id: null, text: ''};
let contact = {id: null, result: null}; // driver-contact preview: open incident and last copy outcome
let build = null; // consumer /api/build: served-file hashes and build identity
// Route context of the selected vehicle (consumer /api/route/{tr_id}).
// status: idle | loading | ok | missing | offline; `data` is the last good payload for `id`.
let route = {id: null, status: 'idle', data: null, reason: null, at: 0, inFlight: false};
let routeToken = 0;
let shiftAfterTarget = true; // «Показывать сдвиг после цели»
let stopsShownFor = null; // the vehicle whose stop list was already scrolled to its upcoming stops
let cardFor; // the vehicle the card's DOM was built for; another vehicle gets a fresh card

const snapshotRows = () => Array.isArray(feed?.snapshot?.vehicles) ? feed.snapshot.vehicles : [];
const currentRun = () => feed?.snapshot?.run ?? null;
// Values are current only while Backend answers.
const isFresh = () => feed?.status === 'online';
const findRow = id => snapshotRows().find(v => String(v.tr_id) === id);
const sourceClock = () => feed?.snapshot?.clock_time ?? null;
// The route payload drawn for the selection: same vehicle and same run as the snapshot on screen.
const shownRoute = () => (route.data && route.id === selected && selected
  && (route.data.run_id ?? null) === (currentRun()?.run_id ?? null) ? route.data : null);
// Which values of the selected row may be shown on its stops (route-context.js stopRows): the model
// value only while the row is a current `normal` prediction (the same rule as the headline), the
// fact only while Backend answers.
const usability = v => ({modelUsable: Boolean(v) && assess(v, isFresh()).level !== 'nodata', factUsable: Boolean(v) && isFresh()});
const routeRows = data => (data ? stopRows(data, {shiftAfterTarget, ...usability(findRow(selected))}) : []);

// ---- Map: MapLibre base, locked top-down view, local PMTiles ------------------------------
maplibregl.setWorkerUrl('/static/map-worker.js');
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
const tiles = new PMTiles(`${location.origin}/map/moscow.pmtiles`);
protocol.add(tiles);

// Road-first base map (inline style, local tiles only). Roads carry the picture: every class has a
// casing, and the hierarchy highway > major > minor reads by width and colour on a slightly darker
// ground. Parks and water are muted; buildings are faint and appear only from z15. No labels: no
// glyphs are shipped (README «Происхождение геоосновы»).
const roadWidth = (base, top) => ['interpolate', ['exponential', 1.6], ['zoom'], 9, base, 16, top];
const roadKind = kinds => ['in', ['get', 'kind'], ['literal', kinds]];
const ROAD = {
  minor: {filter: roadKind(['minor_road', 'other']), fill: '#ffffff', casing: '#c5cac4', width: [0.35, 5.5], minzoom: 11},
  major: {filter: roadKind(['major_road']), fill: '#ffffff', casing: '#9ea59d', width: [0.9, 9.5]},
  highway: {filter: roadKind(['highway']), fill: '#f6cf7d', casing: '#b3873a', width: [1.5, 12.5]},
};
const casing = ([base, top]) => roadWidth(base + 0.9, top + 3);
const roadLayers = [
  ...Object.entries(ROAD).map(([name, road]) => ({id: `roads-${name}-casing`, type: 'line', source: 'osm', 'source-layer': 'roads',
    filter: road.filter, ...(road.minzoom ? {minzoom: road.minzoom} : {}), layout: {'line-cap': 'round', 'line-join': 'round'},
    paint: {'line-color': road.casing, 'line-width': casing(road.width)}})),
  ...Object.entries(ROAD).map(([name, road]) => ({id: `roads-${name}`, type: 'line', source: 'osm', 'source-layer': 'roads',
    filter: road.filter, ...(road.minzoom ? {minzoom: road.minzoom} : {}), layout: {'line-cap': 'round', 'line-join': 'round'},
    paint: {'line-color': road.fill, 'line-width': roadWidth(...road.width)}})),
];
const baseStyle = {
  version: 8,
  sources: {osm: {type: 'vector', url: `pmtiles://${location.origin}/map/moscow.pmtiles`, attribution: '© OpenStreetMap contributors (ODbL)'}},
  layers: [
    {id: 'land', type: 'background', paint: {'background-color': '#e6e8e3'}},
    {id: 'green', type: 'fill', source: 'osm', 'source-layer': 'landuse',
      filter: ['in', ['get', 'kind'], ['literal', ['park', 'forest', 'wood', 'grass', 'garden', 'cemetery', 'nature_reserve', 'meadow']]],
      paint: {'fill-color': '#d7e2d3'}},
    {id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water',
      filter: ['==', ['geometry-type'], 'Polygon'], paint: {'fill-color': '#c2d6df'}},
    {id: 'buildings', type: 'fill', source: 'osm', 'source-layer': 'buildings', minzoom: 15,
      paint: {'fill-color': '#dcddd8', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0.35, 16, 0.6]}},
    {id: 'rail', type: 'line', source: 'osm', 'source-layer': 'roads',
      filter: ['==', ['get', 'kind'], 'rail'], minzoom: 11,
      paint: {'line-color': '#b7bcc0', 'line-width': 1, 'line-dasharray': [3, 2]}},
    ...roadLayers,
    {id: 'boundaries', type: 'line', source: 'osm', 'source-layer': 'boundaries',
      paint: {'line-color': '#b9bfc4', 'line-width': 0.8, 'line-dasharray': [2, 2]}},
  ],
};

let map = null;
try {
  map = new maplibregl.Map({
    container: 'map', style: baseStyle, ...DEFAULT_VIEW, minZoom: 9, maxZoom: 16,
    maxBounds: CAMERA_BOUNDS,
    pitch: 0, bearing: 0, maxPitch: 0, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    attributionControl: false,
  });
  if (new URLSearchParams(location.search).has('debug')) window.__map = map; // browser-check only: query rendered layers
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'bottom-right');
  map.addControl(new maplibregl.AttributionControl({compact: false}), 'bottom-left');
} catch (error) {
  // Rendering starts at the end of this module; only record the failure here.
  map = null;
  mapStatus = 'unavailable';
  mapReason = `WebGL-карта не запустилась: ${error.message || error}`;
}

function markMapUnavailable(reason) {
  if (mapStatus === 'unavailable') return;
  mapStatus = 'unavailable';
  mapReason = reason;
  renderMapState();
  renderMapObjects();
  renderRouteLayers();
  renderDiagnostics();
}

const transportLayer = createTransportLayer();
const routeLayers = map ? createRouteLayers(map) : null;
let tileErrorSeen = false;
if (map) {
  map.on('error', event => {
    tileErrorSeen = true;
    const message = event.error?.message || 'ошибка плиток';
    if (mapStatus !== 'ready') markMapUnavailable(`плитки Москвы не загрузились (${message})`);
    else $('map-state').textContent = `Часть плиток не загрузилась: ${message}`;
  });
  map.on('load', () => { routeLayers.add(); map.addLayer(transportLayer); renderMapObjects(); });
  map.on('idle', () => {
    if (mapStatus !== 'loading' || tileErrorSeen || !map.isSourceLoaded('osm')) return;
    mapStatus = 'ready';
    renderMapState();
    renderRouteLayers();
    renderMapObjects();
    if (pendingOverview && snapshotRows().length) overview(false);
  });
  map.on('move', layoutLabels);
  map.on('zoomend', () => { routeLayers.rethin(); layoutLabels(); });
  map.on('resize', layoutLabels);
  map.on('click', event => { const hit = hitTest(event.point); if (hit) choose(hit, false); });
  map.on('mousemove', event => {
    const hit = hitTest(event.point);
    map.getCanvas().style.cursor = hit ? 'pointer' : '';
    setHovered(hit);
    routeLayers.showTip(hit ? null : event);
  });
  map.on('mouseout', () => { setHovered(null); routeLayers.showTip(null); });
}
// A missing or unreadable archive fails here deterministically, before any tile request.
tiles.getHeader().catch(error => markMapUnavailable(`нет локального архива плиток (${error.message || error})`));
fetch('/map/manifest.json').then(r => { if (!r.ok) throw Error(`HTTP ${r.status}`); return r.json(); })
  .then(body => { manifest = body; renderDiagnostics(); })
  .catch(error => markMapUnavailable(`нет описания геоосновы manifest.json (${error.message})`));

// ---- Route context and transport symbols: route-layers.js, transport-layer.js ----------------
function renderRouteLayers() {
  const data = mapStatus === 'ready' ? shownRoute() : null;
  const rows = routeRows(data);
  const chosen = findRow(selected);
  routeLayers?.render(data, rows, {keep: labelledStops(rows).next, target: chosen ? targetPoint(chosen) : null});
}

const vehicleSymbol = (vehicle, assessment) => {
  const id = String(vehicle.tr_id);
  return {lon: Number(vehicle.lon), lat: Number(vehicle.lat),
    look: vehicleLook(assessment.level, {gpsValid: gpsValid(vehicle), selected: id === selected, hovered: id === hovered})};
};

// Where the selected vehicle's target is drawn: the snapshot's coordinate, else the route's target stop.
function targetPoint(vehicle) {
  if (!vehicle?.target_stop_id) return null;
  if (targetOk(vehicle)) return [Number(vehicle.target_lon), Number(vehicle.target_lat)];
  const data = shownRoute();
  const stop = data ? routeRows(data).find(r => r.role === 'target' && r.stop_id === String(vehicle.target_stop_id) && r.onMap) : null;
  return stop ? [stop.lon, stop.lat] : null;
}

function renderMapObjects() {
  const drawable = mapStatus === 'ready' && map;
  const located = drawable ? visible.filter(({vehicle}) => locationOk(vehicle)) : [];
  const chosen = findRow(selected);
  const target = drawable && chosen ? targetPoint(chosen) : null;
  const symbols = target ? [{lon: target[0], lat: target[1], look: targetLook()}] : [];
  const ordered = [...located].sort((a, b) => (String(a.vehicle.tr_id) === selected) - (String(b.vehicle.tr_id) === selected)
    || (String(a.vehicle.tr_id) === hovered) - (String(b.vehicle.tr_id) === hovered));
  // A selected object hidden by the filter stays on the map, drawn on top.
  if (drawable && chosen && locationOk(chosen) && !located.some(({vehicle}) => vehicle === chosen)) {
    ordered.push({vehicle: chosen, assessment: assess(chosen, isFresh())});
  }
  for (const {vehicle, assessment} of ordered) symbols.push(vehicleSymbol(vehicle, assessment));
  transportLayer.setSymbols(symbols);
  renderLabels(ordered);
  renderStopLabels(drawable && chosen ? chosen : null, target);
  $('legend-route').hidden = !chosen; // the route legend only describes a selected vehicle
  layoutLabels();
}

// Time labels on the map: the target (from the snapshot row, the same value as the card headline)
// and the nearest future stop before it (from the route). Other stops: hover and card only.
const stopLabels = new Map(); // kind → marker
function stopLabel(kind, lngLat, content) {
  let marker = stopLabels.get(kind);
  if (!lngLat) { marker?.remove(); stopLabels.delete(kind); return; }
  if (!marker) {
    const element = document.createElement('div');
    element.className = 'stop-label';
    element.dataset.kind = kind;
    marker = new maplibregl.Marker({element, anchor: 'center'}).setLngLat(lngLat).addTo(map);
    stopLabels.set(kind, marker);
  }
  marker.setLngLat(lngLat);
  marker.getElement().textContent = content;
}

// Without a target the nearest planned stop still gets its plan time (labelledStops).
function renderStopLabels(vehicle, target) {
  if (!vehicle) { stopLabel('target', null); stopLabel('next', null); return; }
  if (target) {
    const assessment = assess(vehicle, isFresh());
    const expected = shiftedText(vehicle.target_time_begin, assessment.level !== 'nodata' ? vehicle.prediction_s : null);
    stopLabel('target', target, `Цель · план ${planText(vehicle.target_time_begin) ?? '?'}${expected ? ` → ${expected} · ${BASIS.model}`
      : assessment.hasPrediction ? ' · прогноз устарел' : ' · прогноза нет'}`);
  } else stopLabel('target', null);
  const next = labelledStops(routeRows(shownRoute())).next;
  stopLabel('next', next ? [next.lon, next.lat] : null,
    next ? `план ${next.plan}${next.expected ? ` → ${next.expected} · по факту` : ''}` : '');
}

// Editable DOM labels for the vehicles; the dot itself stays in the Three.js layer.
const labels = new Map();
function renderLabels(rows) {
  const keep = new Set();
  for (const {vehicle, assessment} of rows) {
    const id = String(vehicle.tr_id);
    keep.add(id);
    let marker = labels.get(id);
    if (!marker) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'vehicle-label';
      element.dataset.id = id;
      element.addEventListener('click', event => { event.stopPropagation(); choose(id, false); });
      element.addEventListener('mouseenter', () => setHovered(id));
      element.addEventListener('mouseleave', () => setHovered(null));
      marker = new maplibregl.Marker({element, anchor: 'center'})
        .setLngLat([Number(vehicle.lon), Number(vehicle.lat)]).addTo(map);
      labels.set(id, marker);
    }
    const element = marker.getElement();
    element.dataset.level = assessment.level;
    element.dataset.symbol = shapeOf(vehicleSymbol(vehicle, assessment).look); // what the icon shows besides colour
    element.classList.toggle('is-selected', id === selected);
    element.classList.toggle('is-hovered', id === hovered);
    element.textContent = `${id} · ${shortValue(vehicle, assessment)}`;
    marker.setLngLat([Number(vehicle.lon), Number(vehicle.lat)]);
  }
  for (const [id, marker] of labels) if (!keep.has(id)) { marker.remove(); labels.delete(id); }
}

// Each label takes a free side of its point (see map-labels.js); redone on every camera move because
// label sizes are fixed in pixels while the distances between points change with zoom. Vehicle and
// stop time labels are placed together (selected vehicle, then target, then next stop, then the
// others); the panels drawn over the map (legend, banner, buttons, toasts) are obstacles.
const STOP_LABEL_PRIORITY = {target: 2, next: 1};
function layoutLabels() {
  if (!map || !(labels.size || stopLabels.size)) return;
  const canvas = map.getCanvas();
  const origin = canvas.getBoundingClientRect();
  const obstacles = [...document.querySelectorAll('#map-pane .legend, #map-pane .attention:not([hidden]), #map-pane .overview, #map-pane .toast, #map-pane .maplibregl-ctrl-bottom-right')]
    .map(el => el.getBoundingClientRect())
    .filter(r => r.width && r.height)
    .map(r => ({x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height}));
  const area = {x: 0, y: 0, width: canvas.clientWidth, height: canvas.clientHeight};
  // A label whose point is off screen is hidden, never pulled into view without its point.
  const item = (id, marker, extra) => {
    const p = map.project(marker.getLngLat());
    const element = marker.getElement();
    element.hidden = !(p.x >= 0 && p.y >= 0 && p.x <= area.width && p.y <= area.height);
    return element.hidden ? null : {id, x: p.x, y: p.y, width: element.offsetWidth, height: element.offsetHeight, ...extra};
  };
  // Route stops drawn without a time label are obstacles too: a label must not hide a stop. The
  // target and the labelled next stop are already kept clear as the dots of their own labels.
  const labelled = labelledStops(routeRows(shownRoute()));
  for (const row of routeLayers?.drawnStops() ?? []) {
    if (row.stop_id === labelled.next?.stop_id && row.time === labelled.next?.time) continue;
    const p = map.project([row.lon, row.lat]);
    obstacles.push({x: p.x - STOP_OBSTACLE_PX / 2, y: p.y - STOP_OBSTACLE_PX / 2, width: STOP_OBSTACLE_PX, height: STOP_OBSTACLE_PX});
  }
  const markers = new Map([...labels, ...[...stopLabels].map(([kind, marker]) => [`stop:${kind}`, marker])]);
  const placement = placeLabels([
    ...[...labels].map(([id, marker]) => item(id, marker, {selected: id === selected})),
    ...[...stopLabels].map(([kind, marker]) => item(`stop:${kind}`, marker, {priority: STOP_LABEL_PRIORITY[kind]})),
  ].filter(Boolean), {obstacles, area});
  for (const [id, {placement: side, offset}] of placement) {
    const marker = markers.get(id);
    marker.setOffset(offset);
    marker.getElement().dataset.placement = side;
  }
}

function hitTest(point) {
  if (mapStatus !== 'ready') return null;
  let best = null;
  for (const {vehicle} of visible) {
    if (!locationOk(vehicle)) continue;
    const p = map.project([Number(vehicle.lon), Number(vehicle.lat)]);
    const distance = Math.hypot(p.x - point.x, p.y - point.y);
    if (distance < 16 && (!best || distance < best.distance)) best = {id: String(vehicle.tr_id), distance};
  }
  return best?.id ?? null;
}

function overview(animate = true) {
  if (!map || mapStatus === 'unavailable') return;
  pendingOverview = false;
  const points = (visible.length ? visible.map(r => r.vehicle) : snapshotRows()).filter(locationOk)
    .map(v => [Number(v.lon), Number(v.lat)]);
  const duration = animate ? 600 : 0;
  if (!points.length) { map.easeTo({...DEFAULT_VIEW, duration}); return; }
  const bounds = points.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
  // Padding clears the banner and the legend; a larger one would push the view against maxBounds.
  map.fitBounds(bounds, {padding: {top: 100, bottom: 140, left: 110, right: 110}, maxZoom: 14, duration});
}

// Show the selected vehicle together with its target, so the forecast's stop is on screen.
function focusSelected() {
  const v = findRow(selected);
  if (!map || mapStatus !== 'ready' || !v || !locationOk(v)) return;
  const here = [Number(v.lon), Number(v.lat)];
  const target = targetPoint(v);
  if (!target) { map.easeTo({center: here, zoom: Math.max(13, map.getZoom()), duration: 600}); return; }
  const bounds = new maplibregl.LngLatBounds(here, here).extend(target);
  map.fitBounds(bounds, {padding: {top: 150, bottom: 200, left: 160, right: 160}, maxZoom: 15, duration: 600}); // bottom clears the legend
}

// ---- Selection ---------------------------------------------------------------------------
function choose(id, focus) {
  const next = id == null ? null : String(id);
  const changed = next !== selected;
  selected = next;
  // Choosing an object is reading its event; it is not taking it into work.
  const incident = selected ? incidentForVehicle(incidents, selected) : null;
  if (incident?.unread) { markRead(incidents, incident.id); renderEvents(); }
  if (changed) { clearRoute(); if (selected) loadRoute(); }
  renderList();
  renderCard();
  renderMapObjects();
  if (focus) focusSelected();
}

function setHovered(id) {
  if (hovered === id) return;
  hovered = id;
  for (const item of document.querySelectorAll('.vehicle')) item.classList.toggle('is-hovered', item.dataset.id === id);
  renderMapObjects();
}

// ---- Route context source -----------------------------------------------------------------
// What the route must agree with: the target and the prediction of the snapshot row.
const rowKey = v => (v ? `${v.target_stop_id ?? ''}|${v.prediction_s ?? ''}` : null);
const routeKey = data => (data ? `${data.target_stop_id ?? ''}|${data.prediction_s ?? ''}` : null);

function clearRoute() {
  routeToken += 1;
  stopsShownFor = null;
  route = {id: selected, status: selected ? 'loading' : 'idle', data: null, reason: null, at: 0, inFlight: false};
  renderRouteLayers();
}

// Consumer /api/route/{tr_id}: 200 {status: online, …route}; 404 {status: not_found, reason};
// 503 {status: offline, reason}. An offline answer or a failure keeps the last good payload of this
// vehicle on screen, marked as not updating; nothing is invented.
async function loadRoute() {
  const id = selected;
  const token = ++routeToken;
  route.at = performance.now();
  route.inFlight = true;
  let next;
  try {
    const response = await fetch(`/api/route/${encodeURIComponent(id)}`, {cache: 'no-store', signal: AbortSignal.timeout(2500)});
    const body = await response.json().catch(() => null);
    if (response.status === 404) next = {status: 'missing', reason: reasonText(body?.reason) ?? 'маршрут не найден'};
    else if (response.ok && body?.status === 'online' && Array.isArray(body.stops) && String(body.tr_id) === id) next = {status: 'ok', data: body};
    else next = {status: 'offline', reason: body?.reason || body?.detail || `HTTP ${response.status}`};
  } catch (error) {
    next = {status: 'offline', reason: String(error.message || error)};
  }
  if (token !== routeToken || id !== selected) return; // the selection changed meanwhile
  route = {...route, id, status: next.status, reason: next.reason ?? null, inFlight: false,
    data: next.status === 'ok' ? next.data : next.status === 'offline' ? route.data : null};
  renderRouteLayers();
  renderMapObjects();
  renderCard();
}

// Called after each snapshot: the route follows the selected vehicle's new frames, and at once
// when the row's target or prediction moved past the route on screen.
function refreshRoute() {
  const row = findRow(selected);
  if (!row || route.inFlight) return;
  const behind = route.data && routeKey(route.data) !== rowKey(row);
  if (!route.at || behind || performance.now() - route.at >= ROUTE_REFRESH_MS) loadRoute();
}

// ---- Panels ------------------------------------------------------------------------------
function shortValue(vehicle, assessment) {
  if (assessment.level !== 'nodata') return minutes(vehicle.prediction_s);
  return assessment.hasPrediction ? `${minutes(vehicle.prediction_s)} · устарел` : 'нет прогноза';
}

const capital = value => value ? value[0].toUpperCase() + value.slice(1) : value;
const updatingText = v => `обновляется · возраст ${durationText(v.prediction_age_s) ?? 'неизвестен'} (время данных)`;

function rowNote(vehicle, assessment) {
  let note = LEVEL[assessment.level].label;
  const incident = incidentForVehicle(incidents, vehicle.tr_id);
  if (incident?.unread && incident.state !== 'resolved' && assessment.level !== 'nodata') note = `Новое · ${note.toLowerCase()}`;
  if (assessment.level === 'nodata') {
    note = capital(!isFresh() ? 'Backend недоступен' : reasonText(vehicle.reason) || (assessment.hasPrediction ? 'прогноз устарел' : 'нет прогноза'));
  } else if (vehicle.prediction_updating === true) {
    note = `${note} · обновляется`;
  }
  // An invalid-GPS reason already says it; the position note is not repeated.
  const where = assessment.level === 'nodata' && vehicle.reason === 'invalid_gps' && locationOk(vehicle) ? '' : positionNote(vehicle);
  return where ? `${note} · ${where}` : note;
}

function renderFilters() {
  const counts = countByFilter(snapshotRows(), isFresh());
  for (const button of document.querySelectorAll('[data-filter]')) {
    const key = button.dataset.filter;
    button.setAttribute('aria-pressed', String(key === filter));
    button.querySelector('b').textContent = String(counts[key]);
  }
}

// Panels are built as fresh detached nodes and merged into the live DOM (dom.js), so a row or button
// under the pointer survives the 1.5 s poll. Controls carry `data-action` (and `data-id` of their
// entity) and are handled by one delegated listener per panel (see Controls), never by listeners
// that captured an object of an earlier snapshot.
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'dataset') Object.assign(node.dataset, value);
    else if (name in node && name !== 'role') node[name] = value;
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  node.append(...children.filter(c => c !== null && c !== undefined && c !== false));
  return node;
};

function renderList() {
  const list = $('vehicles');
  if (feed?.status === 'loading') { patchText(list, 'Загрузка снимка Backend…'); return; }
  if (!feed?.snapshot) { patchText(list, 'Backend недоступен, снимков ещё не было. Данные не подставляются.'); return; }
  if (!snapshotRows().length) {
    patchText(list, currentRun()?.state === 'waiting_driver'
      ? 'Прогон ещё не начат: Backend ждёт регистрации драйвера эмулятора. Машины появятся после неё.'
      : 'В снимке нет машин прогона.');
    return;
  }
  if (!visible.length) {
    patchText(list, query.trim() ? `Ничего не найдено по «${query.trim()}».` : `Нет машин для фильтра «${FILTER_LABEL[filter]}».`);
    return;
  }
  patchChildren(list, visible.map(({vehicle, assessment}) => {
    const id = String(vehicle.tr_id);
    return el('button', {type: 'button', className: `vehicle${id === hovered ? ' is-hovered' : ''}`,
      'data-key': id, 'aria-current': id === selected ? 'true' : null, dataset: {id, level: assessment.level, action: 'choose'}},
    el('span', {className: 'vehicle-id'}, id),
    el('span', {className: 'vehicle-value'}, shortValue(vehicle, assessment)),
    el('span', {className: 'vehicle-note'}, rowNote(vehicle, assessment)));
  }));
}

function field(dl, label, value, hint) {
  const dt = document.createElement('dt'); dt.textContent = label;
  const dd = document.createElement('dd'); dd.textContent = value;
  if (hint) { const small = document.createElement('small'); small.textContent = hint; dd.append(small); }
  dl.append(dt, dd);
  return dd;
}

// «1 мин 35 с (факт)»; a negative value is running ahead of the timetable.
function currentDelayText(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return 'неизвестно';
  const value = Math.round(Number(seconds));
  if (value === 0) return 'по графику (факт)';
  return value > 0 ? `${durationText(value)} (факт)` : `опережение ${durationText(value)} (факт)`;
}

function renderCard() {
  const card = $('card');
  const v = findRow(selected);
  if (!v) {
    const empty = document.createElement('p');
    empty.className = 'card-empty';
    empty.textContent = snapshotRows().length
      ? 'Выберите машину на карте или в списке: появятся её путь, остановки и цель с прогнозом. Сначала — объекты с предупреждением.'
      : 'Карточка появится, когда в снимке будут машины прогона.';
    patchChildren(card, [empty]);
    card.dataset.level = 'none';
    cardFor = null;
    return;
  }
  const fresh = isFresh();
  const assessment = assess(v, fresh);
  const head = document.createElement('header');
  const kind = document.createElement('span'); kind.className = 'card-kind'; kind.textContent = 'Автобус · ТС прогона';
  const title = document.createElement('h2'); title.textContent = text(v.tr_id);
  const chip = document.createElement('span'); chip.className = 'level-chip'; chip.dataset.level = assessment.level;
  chip.textContent = assessment.level === 'nodata' && assessment.hasPrediction ? 'Прогноз устарел' : LEVEL[assessment.level].label;
  const close = document.createElement('button');
  close.type = 'button';
  close.id = 'card-close';
  close.className = 'card-close';
  close.setAttribute('aria-label', 'Закрыть карточку');
  close.textContent = '×';
  close.dataset.action = 'close-card';
  head.append(kind, title, chip, close);

  const headline = document.createElement('div');
  headline.className = 'headline';
  const label = document.createElement('span'); label.textContent = 'Прогноз задержки у цели';
  const value = document.createElement('strong');
  const source = document.createElement('small');
  if (assessment.level !== 'nodata') {
    value.textContent = signedDurationText(v.prediction_s);
    source.textContent = `${capital(BASIS.model)}${v.model_version ? ` · ${v.model_version}` : ''}`;
    if (v.prediction_updating === true) {
      const badge = document.createElement('span');
      badge.id = 'prediction-updating';
      badge.className = 'updating';
      badge.textContent = updatingText(v);
      badge.title = 'Пришли новые кадры той же цели; прогноз по ним ещё считается. Показан последний прогноз для этой цели.';
      source.append(' ', badge);
    }
  } else if (assessment.hasPrediction) {
    value.textContent = `${signedDurationText(v.prediction_s)} · устарел`;
    source.textContent = fresh ? `Последний известный: ${reasonText(v.reason) || STATUS[v.status] || text(v.status)}` : 'Последний известный: Backend недоступен';
  } else {
    value.textContent = 'Нет прогноза';
    source.textContent = `Прогноза нет: ${fresh ? reasonText(v.reason) || 'источник не передал прогноз' : 'Backend недоступен'}`;
  }
  headline.append(label, value, source);

  const facts = document.createElement('dl');
  facts.dataset.key = 'facts';
  field(facts, 'Текущее опоздание', currentDelayText(v.cur_dev_s),
    v.cur_dev_s == null ? reasonText(v.reason) ?? 'факт не определён' : 'на последней пройденной остановке; это факт, не прогноз');
  const prediction = assessment.level !== 'nodata' ? v.prediction_s : null;
  const targetExpected = shiftedText(v.target_time_begin, prediction);
  field(facts, 'Цель прогноза', v.target_stop_id
    ? `план ${planText(v.target_time_begin) ?? '?'}${targetExpected ? ` → ${targetExpected} (${BASIS.model})` : assessment.hasPrediction ? ' · прогноз устарел' : ' · прогноза нет'}`
    : 'цель не определена',
  v.target_stop_id ? `первая плановая остановка через 10–15 мин · запись расписания ${v.target_stop_id}${targetPoint(v) ? '' : ' · координаты нет — на карте не показана'}` : null);

  const details = document.createElement('dl');
  details.dataset.key = 'details';
  // Identity of the Backend's saved ML success: which received NDTP frame and context it used.
  if (v.prediction_input_frame_id) {
    const sha = typeof v.artifact_sha256 === 'string' ? v.artifact_sha256.slice(0, 12) : 'неизвестно';
    const link = field(details, 'Результат модели', `кадр NDTP ${v.prediction_input_frame_id} · контекст №${text(v.prediction_context_revision)}`,
      `модель ${text(v.model_version)} · артефакт ${sha} · расчёт на ${text(v.last_success_at)} (время данных)`);
    link.id = 'model-link';
    link.dataset.frame = String(v.prediction_input_frame_id);
    link.dataset.contextRevision = text(v.prediction_context_revision);
  }
  field(details, 'Свежесть', [v.prediction_age_s == null ? 'прогноза нет' : `прогноз ${ageText(v.prediction_age_s)}`,
    `GPS ${gpsValid(v) ? ageText(v.gps_age_s) : `недостоверен · последняя валидная позиция ${ageText(v.gps_age_s)}`}`].join(' · '),
    fresh ? 'возраст во времени данных, на момент снимка Backend' : 'на момент последнего снимка; Backend недоступен — снимок не обновляется');
  field(details, 'Состояние данных', `${STATUS[v.status] || text(v.status)}${v.reason ? ` · ${reasonText(v.reason)}` : ''}`);
  field(details, 'Причина задержки', 'не установлена', 'источника причин нет — причина не угадывается');
  const shownData = shownRoute();
  field(details, 'Ревизия строки ТС', `снимок rev ${text(v.revision)}${shownData ? ` · маршрутный контекст rev ${text(shownData.vehicle_revision)}` : ''}`,
    'маршрут и снимок берут цель и прогноз из одной строки Backend; ревизия связывает их');

  const incident = incidentForVehicle(incidents, v.tr_id);
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  if (incident && incident.state !== 'resolved') {
    const act = document.createElement('button');
    act.type = 'button';
    act.id = 'incident-action';
    act.className = 'primary';
    act.dataset.workflow = incident.workflow;
    act.textContent = incident.workflow === 'in_work' ? 'Вернуть в новые' : 'Взять в работу';
    act.dataset.action = 'incident-workflow';
    act.dataset.id = incident.id;
    act.dataset.key = incident.id;
    actions.append(act);
  }
  const show = document.createElement('button');
  show.type = 'button';
  show.id = 'card-show';
  if (!incident || incident.state === 'resolved') show.className = 'primary';
  show.textContent = 'Показать на карте';
  show.disabled = !(locationOk(v) && mapStatus === 'ready');
  show.dataset.action = 'focus';
  actions.append(show);
  if (!locationOk(v) || !gpsValid(v)) {
    const note = document.createElement('p'); note.className = 'card-note';
    note.textContent = locationOk(v) ? 'Последний кадр без валидного GPS: на карте — последняя валидная позиция, серая иконка с «?».'
      : positionNote(v) === 'вне карты' ? 'Позиция вне области карты — объект на карте не показан.' : 'Валидной позиции нет — объект не показан на карте.';
    actions.append(note);
  }
  const parts = [head, headline, facts, incident ? incidentBlock(incident, v) : null, routeBlock(v), details, actions].filter(Boolean);
  // Another vehicle gets a fresh card; the same vehicle is patched in place, so focus, typing, the
  // stop list's scroll and a button being pressed all survive the poll.
  if (cardFor !== selected) { card.replaceChildren(...parts); cardFor = selected; } else patchChildren(card, parts);
  card.dataset.level = assessment.level;
  const stops = card.querySelector('.stops');
  if (stops && stopsShownFor !== selected) {
    // First view of this vehicle's stops: start at the last passed stop, so the target is in view.
    const first = stops.querySelector('li:not([data-role=passed])');
    stops.scrollTop = first ? Math.max(0, first.offsetTop - stops.offsetTop - 24) : 0;
    stopsShownFor = selected;
  }
}

// The selected vehicle's stops: passed ones with plan time only; before the target the current
// delay carried forward (a fact, not a forecast); the target with the model's value; after it
// the same shift as an explicit assumption, behind a toggle.
function routeBlock(vehicle) {
  const box = document.createElement('section');
  box.className = 'route';
  box.id = 'route';
  box.dataset.key = 'route';
  box.dataset.status = route.status;
  const head = document.createElement('div');
  head.className = 'route-head';
  const title = document.createElement('b'); title.textContent = 'Остановки по плану';
  const toggle = document.createElement('label');
  toggle.className = 'route-toggle';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.id = 'shift-after-target';
  check.checked = shiftAfterTarget;
  check.dataset.action = 'shift-after-target';
  toggle.append(check, ' Показывать сдвиг после цели');
  head.append(title, toggle);
  box.append(head);

  const note = (content, kind = 'info') => {
    const p = document.createElement('p'); p.className = 'route-note'; p.dataset.kind = kind; p.textContent = content; box.append(p);
  };
  const data = shownRoute();
  if (!data) {
    if (route.status === 'loading') note('Загрузка маршрутного контекста…');
    else if (route.status === 'missing') note(`Маршрутного контекста нет: ${route.reason}.`, 'warn');
    else if (route.status === 'offline') note(`Маршрутный контекст недоступен: ${route.reason}. Путь и остановки не показаны.`, 'warn');
    return box;
  }
  if (route.status === 'offline') note(`Backend не отвечает (${route.reason}) — показан последний полученный контекст, он не обновляется.`, 'warn');
  // Same row revision but other values would break the Backend contract: say so rather than mix values.
  // A different revision is only a newer/older calculation; refreshRoute catches up.
  if (routeKey(data) !== rowKey(vehicle) && data.vehicle_revision === vehicle.revision) {
    note('Маршрутный контекст расходится со снимком при той же ревизии строки ТС; значения остановок — из маршрутного контекста.', 'warn');
  }
  const {modelUsable} = usability(vehicle);
  const staleModel = !modelUsable && data.prediction_s != null;
  const rows = routeRows(data);
  const windowText = data.window_start && data.window_end ? `${planText(data.window_start)}–${planText(data.window_end)}` : '«сейчас − 5 мин … цель + 15 мин»';
  if (!rows.length) note(`В окне ${windowText} плановых остановок нет.`);
  const list = document.createElement('ol');
  list.className = 'stops';
  for (const row of rows) {
    const item = document.createElement('li');
    item.dataset.role = row.role;
    item.dataset.stop = row.stop_id ?? '';
    const time = document.createElement('span');
    time.className = 'stop-time';
    time.textContent = row.expected ? `${row.plan} → ${row.expected}` : row.plan ?? '—';
    const what = document.createElement('span');
    what.className = 'stop-basis';
    // A stale or degraded prediction is never labelled as the model's value or its assumption.
    what.textContent = row.role === 'target' ? `цель · ${row.basis ? BASIS.model : staleModel ? 'прогноз устарел' : 'прогноза нет'}`
      : row.basis ? BASIS[row.basis]
      : row.role === 'passed' ? 'пройдена · план'
      : row.role === 'after_target' && staleModel ? 'план · прогноз устарел'
      : row.role === 'after_target' && modelUsable && !shiftAfterTarget && data.prediction_s != null ? 'план · сдвиг скрыт'
      : 'план';
    if (row.basis) what.dataset.basis = row.basis;
    item.append(time, what);
    if (!row.onMap) item.title = 'Координаты нет — на карте не показана';
    list.append(item);
  }
  box.append(list);
  const bad = undrawnCount(data);
  const dropped = Number(data.stops_dropped) || 0;
  const truncated = Number(data.stops_truncated) || 0;
  const missing = [dropped ? `${dropped} остановок без координат исключены Backend` : null,
    truncated ? `${truncated} самых ранних остановок окна не показаны (не больше 40)` : null,
    bad.stops ? `${bad.stops} остановок без координат на карте не показаны` : null,
    bad.path + bad.passed ? `${bad.path + bad.passed} точек GPS вне карты пропущены` : null].filter(Boolean);
  if (missing.length) note(`${missing.join(' · ')}.`);
  const caption = document.createElement('small');
  caption.className = 'route-caption';
  caption.textContent = `Окно остановок ${windowText} · расчёт строки ТС rev ${text(data.vehicle_revision)}. Серая линия — путь по GPS прогона (траектория ТС в окне данных), не официальная трасса маршрута и не вход модели. Синяя — уже пройдено в этом прогоне.`;
  box.append(caption);
  return box;
}

// An episode is one vehicle (incidents.js); its line is the vehicle as last seen.
const incidentTitle = incident => `ТС ${incident.tr_id}`;
const vehicleStateText = incident => (incident.vehicle_state === 'nodata' ? 'нет данных'
  : incident.vehicle_state === 'normal' ? 'в норме' : minutes(incident.last_s));

// The object's event: lifecycle, dispatcher status, a plain-text note and the local history.
function incidentBlock(incident, vehicle) {
  const box = document.createElement('section');
  box.className = 'incident';
  box.dataset.state = incident.state;
  box.dataset.id = incident.id;
  box.dataset.key = incident.id;
  const head = document.createElement('div');
  head.className = 'incident-head';
  const name = document.createElement('b'); name.textContent = `Событие №${incident.number}`;
  const state = document.createElement('span'); state.className = 'incident-state'; state.dataset.state = incident.state; state.textContent = INCIDENT_STATE[incident.state];
  const flow = document.createElement('span'); flow.className = 'incident-flow'; flow.dataset.workflow = incident.workflow; flow.textContent = WORKFLOW[incident.workflow];
  head.append(name, state, flow);
  const who = document.createElement('p');
  who.className = 'incident-members';
  who.textContent = `${incidentTitle(incident)} · ${vehicleStateText(incident)}`;

  const form = document.createElement('form');
  form.className = 'note-form';
  const input = document.createElement('input');
  input.id = 'note-input';
  input.type = 'text';
  input.maxLength = NOTE_MAX;
  input.placeholder = 'Заметка к событию';
  input.setAttribute('aria-label', 'Заметка к событию');
  input.autocomplete = 'off';
  input.value = noteDraft.id === incident.id ? noteDraft.text : '';
  input.dataset.id = incident.id;
  const add = document.createElement('button'); add.type = 'submit'; add.textContent = 'Добавить';
  form.append(input, add);
  form.dataset.id = incident.id;

  const history = document.createElement('ol');
  history.className = 'incident-history';
  history.setAttribute('aria-label', 'История события');
  for (const entry of [...incident.history].reverse()) {
    const item = document.createElement('li');
    item.dataset.kind = entry.kind;
    const time = document.createElement('time'); time.textContent = clockText(entry.at);
    const what = document.createElement('span');
    what.textContent = entry.kind === 'note' ? `Заметка: ${entry.text}` : entry.text; // plain text, never markup
    item.append(time, what);
    history.append(item);
  }
  const scope = document.createElement('small');
  scope.className = 'incident-scope';
  scope.textContent = 'Действия и заметки хранятся только в этом браузере и этом прогоне эмулятора; время — по часам данных.';
  box.append(head, who, form, contactBlock(incident, vehicle), history, scope);
  return box;
}

// Driver contact is a prototype: it prepares a text for the dispatcher to send by the usual
// channel. Nothing is sent from this screen, and a copy is reported only when it succeeded.
function contactBlock(incident, vehicle) {
  if (incident.state === 'resolved') return document.createDocumentFragment();
  if (contact.id !== incident.id) {
    const open = document.createElement('button');
    open.type = 'button';
    open.id = 'contact-open';
    open.className = 'contact-open';
    open.textContent = 'Связь с водителем · прототип';
    open.dataset.action = 'contact-open';
    open.dataset.id = incident.id;
    return open;
  }
  const box = document.createElement('section');
  box.className = 'contact';
  box.dataset.key = `contact:${incident.id}`;
  box.setAttribute('aria-label', 'Связь с водителем, прототип');
  const title = document.createElement('b'); title.textContent = 'Прототип · отправка не подключена';
  const hint = document.createElement('small');
  hint.textContent = 'Экран только готовит текст. Отправьте его водителю по штатному каналу связи.';
  const message = document.createElement('textarea');
  message.id = 'contact-text';
  message.readOnly = true;
  message.rows = 3;
  message.setAttribute('aria-label', 'Текст для водителя');
  const target = vehicle.target_stop_id ? `у плановой остановки ${planText(vehicle.target_time_begin) ?? ''} ` : '';
  message.value = `${vehicle.tr_id}: прогноз задержки ${target}${minutes(vehicle.prediction_s)}. Сообщите диспетчеру обстановку на линии.`;
  const copy = document.createElement('button'); copy.type = 'button'; copy.id = 'contact-copy'; copy.textContent = 'Скопировать текст';
  copy.dataset.action = 'contact-copy'; copy.dataset.id = incident.id;
  const close = document.createElement('button'); close.type = 'button'; close.id = 'contact-close'; close.textContent = 'Закрыть';
  close.dataset.action = 'contact-close';
  const result = document.createElement('p');
  result.id = 'contact-result';
  result.setAttribute('role', 'status');
  result.dataset.result = contact.result || 'none';
  result.textContent = contact.result === 'copied' ? 'Текст скопирован. Он ещё не отправлен — отправьте его вручную.'
    : contact.result === 'manual' ? 'Буфер обмена недоступен: текст выделен — скопируйте его вручную (Ctrl+C / ⌘C). Ничего не отправлено.' : '';
  const buttons = document.createElement('div'); buttons.className = 'contact-buttons'; buttons.append(copy, close);
  box.append(title, hint, result, message, buttons);
  return box;
}

function renderAttention() {
  const box = $('attention');
  if (!feed?.snapshot || !snapshotRows().length) { box.hidden = true; return; }
  box.hidden = false;
  if (!isFresh()) {
    box.dataset.level = 'nodata';
    patchText(box, 'Backend недоступен: показан последний снимок, предупреждения не оцениваются.');
    return;
  }
  const warnings = visibleRows(snapshotRows(), {filter: 'warning', fresh: true});
  if (!warnings.length) {
    const {all, nodata} = countByFilter(snapshotRows(), true);
    box.dataset.level = nodata ? 'nodata' : 'normal';
    patchText(box, nodata === all
      ? `Нет актуальных прогнозов (${all} машин): предупреждения сейчас не оцениваются.`
      : `Предупреждений нет${nodata ? ` · ${nodata} машин без актуального прогноза` : ''}.`);
    return;
  }
  const [{vehicle, assessment}] = warnings;
  box.dataset.level = assessment.level;
  const title = document.createElement('span'); title.className = 'attention-title';
  title.textContent = incidentForVehicle(incidents, vehicle.tr_id)?.unread ? 'Новое предупреждение' : 'Требует внимания';
  const body = document.createElement('span');
  body.textContent = `${vehicle.tr_id} · прогноз задержки ${minutes(vehicle.prediction_s)}${warnings.length > 1 ? ` · ещё ${warnings.length - 1}` : ''}`;
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = 'Открыть карточку';
  open.dataset.action = 'choose';
  open.dataset.id = String(vehicle.tr_id);
  open.dataset.key = 'attention-open';
  patchChildren(box, [title, body, open]);
}

// ---- Event centre and toasts ---------------------------------------------------------------
function renderEvents() {
  const counts = incidentCounts(incidents);
  const toggle = $('events-toggle');
  toggle.setAttribute('aria-expanded', String(eventsOpen));
  toggle.dataset.active = String(counts.active + counts.monitoring_lost);
  $('events-unread').textContent = String(counts.unread);
  $('events-unread').hidden = counts.unread === 0;
  toggle.title = `Непрочитанных ${counts.unread} · активных ${counts.active} · мониторинг потерян ${counts.monitoring_lost} · закончились ${counts.resolved}`;
  const panel = $('events-panel');
  panel.hidden = !eventsOpen;
  if (!eventsOpen) return;
  $('events-summary').textContent = `Активных ${counts.active} · мониторинг потерян ${counts.monitoring_lost} · закончились ${counts.resolved}`;
  const list = $('events-list');
  const all = orderedIncidents(incidents);
  if (!all.length) {
    const empty = document.createElement('p');
    empty.className = 'events-empty';
    empty.textContent = `Событий нет. Событие открывается, когда прогноз задержки больше 2 мин${!isFresh() ? '; сейчас Backend недоступен и предупреждения не оцениваются' : ''}.`;
    patchChildren(list, [empty]);
    return;
  }
  patchChildren(list, all.map(incident => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'event';
    item.dataset.id = incident.id;
    item.dataset.key = incident.id;
    item.dataset.action = 'open-event';
    item.dataset.state = incident.state;
    item.dataset.unread = String(incident.unread);
    const title = document.createElement('span'); title.className = 'event-title'; title.textContent = incidentTitle(incident);
    const state = document.createElement('span'); state.className = 'incident-state'; state.dataset.state = incident.state; state.textContent = INCIDENT_STATE[incident.state];
    const who = document.createElement('span'); who.className = 'event-members'; who.textContent = vehicleStateText(incident);
    const meta = document.createElement('span'); meta.className = 'event-meta';
    meta.textContent = [`№${incident.number}`, `с ${clockText(incident.opened_at)}`, `пик ${minutes(incident.peak_s)}`, WORKFLOW[incident.workflow],
      incident.notes.length ? `заметок ${incident.notes.length}` : null, incident.unread ? 'не прочитано' : null].filter(Boolean).join(' · ');
    item.append(title, state, who, meta);
    return item;
  }));
}

// Go from an event to its vehicle.
function openEvent(id) {
  const incident = markRead(incidents, id);
  if (!incident) return;
  eventsOpen = false;
  dismissToast(id);
  filter = 'all'; query = ''; $('search').value = '';
  choose(findRow(incident.tr_id) ? incident.tr_id : null, true);
  render();
}

function showToast(id) {
  if (toasts.some(t => t.id === id)) return;
  toasts.push({id, timer: setTimeout(() => dismissToast(id), TOAST_MS)});
  toasts = toasts.slice(-3);
  renderToasts();
}

function dismissToast(id) {
  const toast = toasts.find(t => t.id === id);
  if (!toast) return;
  clearTimeout(toast.timer);
  toasts = toasts.filter(t => t !== toast);
  renderToasts();
}

function clearToasts() { for (const t of toasts) clearTimeout(t.timer); toasts = []; renderToasts(); }

function renderToasts() {
  patchChildren($('toasts'), toasts.map(({id}) => findIncident(incidents, id)).filter(Boolean).map(incident => {
    const {id} = incident;
    const box = document.createElement('div');
    box.className = 'toast';
    box.dataset.id = id;
    box.dataset.key = id;
    box.setAttribute('role', 'status');
    const title = document.createElement('b'); title.textContent = `Новое событие №${incident.number}`;
    const body = document.createElement('span');
    body.textContent = `${incidentTitle(incident)} · ${vehicleStateText(incident)}`;
    const open = document.createElement('button'); open.type = 'button'; open.className = 'toast-open'; open.textContent = 'Открыть';
    open.dataset.action = 'open-event'; open.dataset.id = id;
    const close = document.createElement('button'); close.type = 'button'; close.className = 'toast-close'; close.textContent = '×';
    close.setAttribute('aria-label', 'Скрыть уведомление');
    close.dataset.action = 'dismiss-toast'; close.dataset.id = id;
    box.append(title, body, open, close);
    return box;
  }));
}

// Feed a newly received snapshot into the local event store. The first snapshot of a store
// only records what already exists; later new episodes get one toast each.
function ingest() {
  if (!feed?.snapshot) return;
  const known = incidents.observed > 0;
  const opened = observeSnapshot(incidents, snapshotRows(), {fresh: isFresh(), clock: sourceClock(), wallS: performance.now() / 1000});
  if (known) for (const id of opened) showToast(id);
}

// Header: where the data comes from and how fast it runs — all from `snapshot.run`.
function renderStatus() {
  const run = currentRun();
  const box = $('run');
  box.dataset.state = run?.state ?? 'unknown';
  const snap = feed?.snapshot;
  // Outside SOURCE_CLOCK=simulation Backend has no run (snapshot.run = null): say which clock it runs on.
  $('run-source').textContent = !snap ? 'Источник неизвестен' : run ? `${sourceText(run.source)} → ML` : `Backend без прогона · часы ${text(snap.source_clock)} → ML`;
  const runId = $('run-id');
  runId.textContent = run?.run_id ? `прогон ${shortRunId(run.run_id)}` : !snap ? 'прогон неизвестен' : run ? 'прогон не зарегистрирован' : 'прогона нет';
  runId.title = run?.run_id ?? '';
  runId.dataset.runId = run?.run_id ?? '';
  const speed = $('run-speed');
  speed.textContent = speedupText(run?.speedup);
  speed.dataset.speedup = run?.speedup ?? '';
  speed.title = 'Время данных идёт в N раз быстрее времени показа (значение прогона Backend).';
  const clock = dataTimeText(run?.dataset_time);
  $('run-clock').textContent = clock ? `время данных ${clock}` : 'время данных неизвестно';
  $('run-state').textContent = feed?.snapshot ? runStateText(run) : '—';
  box.title = run?.driver?.reason ? `Драйвер: ${run.driver.state ?? ''} · ${run.driver.reason}` : '';
  const progress = Number(run?.progress);
  $('run-progress-bar').style.width = `${Number.isFinite(progress) ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : 0}%`;
  const status = $('data-status');
  status.dataset.status = feed?.status || 'loading';
  if (feed?.status === 'loading') status.textContent = 'Ожидание ответа Backend…';
  else if (feed?.status === 'online') status.textContent = `Backend online · снимок ${liveAge()}`;
  else if (feed?.snapshot) status.textContent = `Backend недоступен · последний снимок ${liveAge()}`;
  else status.textContent = 'Backend недоступен · данных нет';
  status.title = feed?.reason ? `Ошибка: ${feed.reason}` : '';
}

function liveAge() {
  const age = feed?.age_s;
  return age == null ? 'возраст неизвестен' : ageText(Math.max(0, Number(age) + (performance.now() - receivedAt) / 1000));
}

function renderDiagnostics() {
  const snap = feed?.snapshot;
  const run = snap?.run;
  const rows = [
    ['Источник данных', run ? `${sourceText(run.source)} (${text(run.source)})` : 'нет данных о прогоне'],
    ['Прогон (run_id)', text(run?.run_id)],
    ['Состояние прогона', runStateText(run)],
    ['Ускорение', `${speedupText(run?.speedup)} · период POST драйвера ${text(run?.post_period_s)} с`],
    ['Окно данных', `${text(run?.dataset_start)} — ${text(run?.dataset_end)}`],
    ['Время данных', text(run?.dataset_time)],
    ['Прореживание (thinned_ratio)', `${percentText(run?.thinned_ratio)} точек окна не отправлено из-за ускорения`],
    ['Повторы (repeat_ratio)', `${percentText(run?.repeat_ratio)} отправок — повтор последней точки`],
    ['ТС прогона · принято кадров', `${text(run?.vehicle_count)} · ${text(run?.accepted_frames)} · последний кадр ${ageText(run?.last_frame_age_s)}`],
    ['Прогон зарегистрирован (UTC)', text(run?.registered_at_utc)],
    ['Драйвер', run?.driver ? `${text(run.driver.state)}${run.driver.reason ? ` · ${run.driver.reason}` : ''} · отчёт ${text(run.driver.reported_at_utc)}` : 'отчётов нет'],
    // Build identity exactly as consumer /api/build reports it; nothing here is computed or assumed.
    ['Сборка · source_commit', build ? text(build.source_commit) : 'неизвестно (нет ответа /api/build)'],
    ['Сборка · dashboard_bundle_sha256', text(build?.dashboard_bundle_sha256)],
    ['Сборка · consumer_static_sha256', text(build?.consumer_static_sha256)],
    ...Object.entries(build?.files && typeof build.files === 'object' ? build.files : {}).map(([name, hash]) => [`Файл ${name} · sha256`, text(hash)]),
    ['Путь данных', 'официальный эмулятор → Backend /v1/vehicles → consumer /api/snapshot'],
    ['Состояние ответа', text(feed?.status)], ['Ошибка', text(feed?.reason)], ['Часы Backend', text(snap?.source_clock)],
    ['Последний успешный ответ', text(feed?.fetched_at)], ['Последняя проверка', text(feed?.checked_at)], ['Возраст снимка', liveAge()],
  ];
  if (snap?.ingest) {
    rows.push(['Ingest NDTP', `принято ${text(snap.ingest.accepted)} · отброшено ${text(snap.ingest.dropped)} · ошибок ${text(snap.ingest.errors)}`
      + `${snap.ingest.rejected_no_run != null ? ` · до регистрации прогона ${snap.ingest.rejected_no_run}` : ''}`]);
  }
  if (snap?.processing) rows.push(['Вызовы ML', `успешно ${text(snap.processing.ml_succeeded)} · ошибок ${text(snap.processing.ml_failed)} · недоступно ${text(snap.processing.ml_unavailable)}`]);
  const events = incidentCounts(incidents);
  rows.push(['События (локально)', `активных ${events.active} · мониторинг потерян ${events.monitoring_lost} · закончились ${events.resolved}`]);
  rows.push(['Revision', text(snap?.revision)], ['Объектов в снимке', String(snapshotRows().length)],
    ['Геооснова', mapStatus === 'unavailable' ? `недоступна: ${mapReason}` : manifest ? `OSM · ${manifest.date} · ${manifest.coverage}` : 'загрузка…']);
  if (manifest?.sha256) rows.push(['PMTiles sha256', manifest.sha256]);
  const dl = document.createElement('dl');
  for (const [label, value] of rows) field(dl, label, value);
  patchChildren($('diag-list'), [...dl.childNodes]); // a patch keeps a text selection the presenter is copying
}

function renderMapState() {
  $('map-pane').dataset.state = mapStatus;
  const box = $('map-state');
  if (mapStatus === 'loading') box.textContent = 'Загрузка геоосновы…';
  else if (mapStatus === 'ready') box.textContent = '';
  else box.textContent = `Карта недоступна: ${mapReason}. Позиции на карте не показываются; список и карточка справа работают.`;
  box.hidden = mapStatus === 'ready';
  if (findRow(selected)) renderCard();
}

function render() {
  if (selected && !findRow(selected)) { selected = null; clearRoute(); }
  visible = visibleRows(snapshotRows(), {filter, query, fresh: isFresh()});
  renderStatus();
  renderFilters();
  renderList();
  renderCard();
  renderAttention();
  renderEvents();
  renderToasts();
  renderDiagnostics();
  renderMapObjects();
  if (pendingOverview && mapStatus === 'ready' && snapshotRows().length) overview(false);
}

// A new run on screen: nothing of the previous run stays — events, actions, notes, selection,
// filters and the route context.
function resetView() {
  selected = null; hovered = null; filter = 'all'; query = ''; $('search').value = '';
  pendingOverview = true;
  epoch += 1;
  incidents = createIncidentStore(`live${epoch}`);
  eventsOpen = false;
  noteDraft = {id: null, text: ''};
  contact = {id: null, result: null};
  clearToasts();
  clearRoute();
}

// ---- Source -------------------------------------------------------------------------------
async function poll() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  let next;
  try {
    const response = await fetch('/api/snapshot', {cache: 'no-store', signal: controller.signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!['online', 'offline'].includes(payload?.status)) throw new Error('неверный формат snapshot');
    next = payload;
  } catch (error) {
    // Keep the last snapshot we showed; never substitute other data.
    next = {...(feed?.snapshot ? feed : {snapshot: null, age_s: null, fetched_at: null}), status: 'offline', reason: String(error.message || error)};
  } finally {
    clearTimeout(timeout);
  }
  feed = next;
  receivedAt = performance.now();
  if (feed.status === 'online' && runs.observe(feed.snapshot)) resetView();
  ingest();
  render();
  refreshRoute();
  setTimeout(poll, POLL_MS);
}

// ---- Controls -----------------------------------------------------------------------------
for (const button of document.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => { filter = button.dataset.filter; render(); });
}
$('search').addEventListener('input', event => { query = event.target.value; render(); });

// Panel controls: one delegated listener per panel. Every entity is looked up by its ID when the
// control is used, so a node kept across polls always acts on the current state.
async function copyContactText(id) {
  const text = $('contact-text')?.value ?? '';
  let outcome = 'manual';
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    outcome = 'copied';
  } catch { /* reported as manual copy, never as success */ }
  if (contact.id !== id) return;
  contact = {id, result: outcome};
  renderCard();
  if (outcome === 'manual') { const area = $('contact-text'); area?.focus(); area?.select(); }
}

function onPanelClick(event) {
  const control = event.target.closest('[data-action]');
  if (!control || !event.currentTarget.contains(control) || control.disabled) return;
  const {action, id} = control.dataset;
  if (control.type === 'checkbox') return; // handled on change
  if (action === 'choose') choose(id, true);
  else if (action === 'close-card') choose(null, false);
  else if (action === 'focus') focusSelected();
  else if (action === 'open-event') openEvent(id);
  else if (action === 'dismiss-toast') dismissToast(id);
  else if (action === 'incident-workflow') {
    const incident = findIncident(incidents, id);
    if (!incident) return;
    if (incident.workflow === 'in_work') reopen(incidents, id, sourceClock());
    else acknowledge(incidents, id, sourceClock());
    renderCard(); renderEvents();
  } else if (action === 'contact-open') {
    if (!findIncident(incidents, id)) return;
    contact = {id, result: null}; renderCard(); $('contact-copy')?.focus();
  } else if (action === 'contact-close') {
    contact = {id: null, result: null}; renderCard(); $('contact-open')?.focus();
  } else if (action === 'contact-copy') copyContactText(id);
}
for (const panel of ['vehicles', 'card', 'attention', 'events-list', 'toasts']) $(panel).addEventListener('click', onPanelClick);
$('vehicles').addEventListener('mouseover', event => setHovered(event.target.closest?.('.vehicle')?.dataset.id ?? null));
$('vehicles').addEventListener('mouseleave', () => setHovered(null));
$('card').addEventListener('change', event => {
  if (event.target.id !== 'shift-after-target') return;
  shiftAfterTarget = event.target.checked;
  renderRouteLayers(); renderMapObjects(); renderCard();
});
$('card').addEventListener('input', event => {
  if (event.target.id === 'note-input') noteDraft = {id: event.target.dataset.id, text: event.target.value};
});
$('card').addEventListener('submit', event => {
  if (!event.target.classList.contains('note-form')) return;
  event.preventDefault();
  const input = $('note-input');
  if (!addNote(incidents, event.target.dataset.id, input?.value, sourceClock())) { input?.focus(); return; }
  noteDraft = {id: null, text: ''};
  renderCard(); renderEvents();
  $('note-input')?.focus();
});
$('clear-selection').addEventListener('click', () => choose(null, false));
$('overview').addEventListener('click', () => overview(true));
$('events-toggle').addEventListener('click', () => { eventsOpen = !eventsOpen; renderEvents(); });
$('events-close').addEventListener('click', () => { eventsOpen = false; renderEvents(); });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.target.closest?.('input, textarea')) return;
  if (eventsOpen) { eventsOpen = false; renderEvents(); } else if (selected) choose(null, false);
});
setInterval(() => { renderStatus(); if ($('diagnostics').open) renderDiagnostics(); }, 1000);

// The served build is shown in diagnostics so a presenter can confirm the browser has the new bundle.
fetch('/api/build', {cache: 'no-store'}).then(r => r.ok ? r.json() : null).then(payload => { build = payload && typeof payload === 'object' ? payload : null; })
  .catch(() => { build = null; }).finally(() => { if ($('diagnostics').open) renderDiagnostics(); });

// The legend shows the same bitmaps as the map.
const LEGEND_LOOKS = {normal: vehicleLook('normal'), warning: vehicleLook('warning'), severe: vehicleLook('severe'),
  nodata: vehicleLook('nodata'), invalid: vehicleLook('normal', {gpsValid: false}), selected: vehicleLook('normal', {selected: true}), target: targetLook()};
for (const img of document.querySelectorAll('img.legend-symbol')) {
  const {canvas, box} = drawSymbol(LEGEND_LOOKS[img.dataset.symbol], 2);
  img.src = canvas.toDataURL();
  img.width = img.height = Math.round(box * 0.6);
}

renderMapState();
render();
poll();
