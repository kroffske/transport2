import * as maplibregl from 'maplibre-gl';
import {PMTiles, Protocol} from 'pmtiles';
import {NOTE_MAX, acknowledge, addNote, assess, countByFilter, createIncidentStore, findIncident, incidentCounts,
  incidentForVehicle, markRead, observeSnapshot, orderedIncidents, reopen, visibleRows} from './incidents.js';
import {patchChildren, patchText} from './dom.js';
import {placeLabels} from './map-labels.js';
import {drawSymbol, headingLook, shapeOf, targetLook, vehicleLook} from './map-symbols.js';
import {reasonText} from './reasons.js';
import {BASIS, coordOk, delayText, durationText, labelledStops, offsetText, planText, shiftedText,
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
// Two separate things (UI review E-1): the delay itself, and what the dispatcher did about it.
const INCIDENT_STATE = {active: 'Задержка идёт', monitoring_lost: 'Нет данных', resolved: 'Задержка закончилась'};
const WORKFLOW = {new: 'Не взято', in_work: 'В работе'};
const TOAST_MAX = 2;
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
let follow = false; // the camera keeps the selected vehicle and its target in view
let lastFollowAt = 0;
let techOpen = false; // «Технические подробности» in the card, as the dispatcher left it
let cardFor; // the vehicle the card's DOM was built for; another vehicle gets a fresh card
// Planned routes of all vehicles for the overview (consumer /api/routes), refreshed every ROUTES_MS.
let routesFeed = {status: 'idle', data: null, at: 0, inFlight: false};
const ROUTES_MS = 10000;

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

// `?debug` (browser-check only): expose the map and keep the drawing buffer so pixels can be read.
const DEBUG = new URLSearchParams(location.search).has('debug');
let map = null;
try {
  map = new maplibregl.Map({
    container: 'map', style: baseStyle, ...DEFAULT_VIEW, minZoom: 9, maxZoom: 16,
    maxBounds: CAMERA_BOUNDS,
    ...(DEBUG ? {canvasContextAttributes: {preserveDrawingBuffer: true}} : {}),
    pitch: 0, bearing: 0, maxPitch: 0, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    attributionControl: false,
    // Map controls in Russian (M-5).
    locale: {'NavigationControl.ZoomIn': 'Приблизить', 'NavigationControl.ZoomOut': 'Отдалить', 'NavigationControl.ResetBearing': 'Север вверх'},
  });
  if (DEBUG) window.__map = map;
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
  // A pan or zoom by the dispatcher (an event with a DOM origin) stops following the selection.
  map.on('movestart', event => { if (event.originalEvent && follow) { follow = false; followSelected(); } });
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
// Overview lines of the run on screen only; the selected vehicle's own line is its route context.
const overviewRoutes = () => (routesFeed.data && (routesFeed.data.run_id ?? null) === (currentRun()?.run_id ?? null)
  && Array.isArray(routesFeed.data.routes) ? routesFeed.data.routes : []);

function renderRouteLayers() {
  const ready = mapStatus === 'ready';
  const data = ready ? shownRoute() : null;
  const rows = routeRows(data);
  const chosen = findRow(selected);
  const vehicle = chosen && locationOk(chosen) ? [Number(chosen.lon), Number(chosen.lat)] : null;
  routeLayers?.renderOverview(ready ? overviewRoutes() : [], selected);
  const layers = routeLayers?.render(data, rows, {keep: labelledStops(rows).next, target: chosen ? targetPoint(chosen) : null, vehicle}) ?? [];
  $('map-pane').dataset.routeLayers = layers.join(',');
  renderOffRouteLabel(chosen, data, vehicle, layers);
}

// «вне маршрута ~N км» at the middle of the leader from the vehicle to the nearest point of its route.
function renderOffRouteLabel(vehicle, data, from, layers) {
  const nearest = data?.route_line?.nearest;
  if (!layers.includes('offroute-leader')) { stopLabel('offroute', null); return; }
  const middle = [(from[0] + nearest[0]) / 2, (from[1] + nearest[1]) / 2];
  stopLabel('offroute', middle, `вне маршрута ${offsetText(data.route_line.route_offset_m ?? vehicle.route_offset_m) ?? ''}`.trim());
}

// /api/routes: 200 {status: online, run_id, routes: [{tr_id, line, …}]}; 503 offline keeps the last
// lines of this run on screen (they are the plan, not live data).
async function loadRoutes() {
  if (routesFeed.inFlight) return;
  routesFeed.inFlight = true;
  routesFeed.at = performance.now();
  try {
    const response = await fetch('/api/routes', {cache: 'no-store', signal: AbortSignal.timeout(4000)});
    const body = await response.json().catch(() => null);
    if (response.ok && body?.status === 'online' && Array.isArray(body.routes)) routesFeed = {...routesFeed, status: 'online', data: body};
    else routesFeed = {...routesFeed, status: 'offline'};
  } catch {
    routesFeed = {...routesFeed, status: 'offline'};
  }
  routesFeed.inFlight = false;
  renderRouteLayers();
}
const refreshRoutes = () => { if (!routesFeed.at || performance.now() - routesFeed.at >= ROUTES_MS) loadRoutes(); };

const vehicleSymbol = (vehicle, assessment) => {
  const id = String(vehicle.tr_id);
  return {lon: Number(vehicle.lon), lat: Number(vehicle.lat),
    look: vehicleLook(assessment.level, {gpsValid: gpsValid(vehicle), selected: id === selected, hovered: id === hovered, offRoute: vehicle.off_route})};
};
// Direction of movement: Backend `heading` (degrees clockwise from north); none when null.
const headingOk = v => v.heading !== null && v.heading !== undefined && v.heading !== '' && Number.isFinite(Number(v.heading));
const headingSymbol = vehicle => ({lon: Number(vehicle.lon), lat: Number(vehicle.lat), rotation: Number(vehicle.heading),
  look: headingLook({selected: String(vehicle.tr_id) === selected})});

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
  for (const {vehicle, assessment} of ordered) {
    if (headingOk(vehicle)) symbols.push(headingSymbol(vehicle));
    symbols.push(vehicleSymbol(vehicle, assessment));
  }
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
    const expected = shiftedText(vehicle.target_time_begin, assessment.level !== 'nodata' ? vehicle.prediction_s : null, {seconds: true});
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
    // Without a current prediction the label is the ID only (M-3, H-2): a map full of «нет прогноза»
    // reads as a failure and hides the warnings. The reason stays in the tooltip, list and card.
    const nodata = assessment.level === 'nodata';
    element.textContent = nodata ? id : `${id} · ${shortValue(vehicle, assessment, {short: true})}`;
    element.title = nodata ? `${id} · ${runOver(currentRun()) ? 'прогон завершён' : shortValue(vehicle, assessment, {short: true})}` : '';
    marker.setLngLat([Number(vehicle.lon), Number(vehicle.lat)]);
  }
  for (const [id, marker] of labels) if (!keep.has(id)) { marker.remove(); labels.delete(id); }
}

// Each label takes a free side of its point (see map-labels.js); redone on every camera move because
// label sizes are fixed in pixels while the distances between points change with zoom. Vehicle and
// stop time labels are placed together (selected vehicle, then target, then next stop, then the
// others); the panels drawn over the map (legend, banner, buttons, toasts) are obstacles.
const STOP_LABEL_PRIORITY = {target: 3, offroute: 2, next: 1};
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
// The map area not covered by panels drawn over it (banner, legend, buttons, toasts), in pane pixels.
const OVERLAYS = '#map-pane .attention:not([hidden]), #map-pane .legend, #map-pane .overview:not([hidden]), #map-pane .toast, #map-pane .maplibregl-ctrl-bottom-right';
function overlayRects() {
  const pane = $('map-pane').getBoundingClientRect();
  return [...document.querySelectorAll(OVERLAYS)].map(e => e.getBoundingClientRect()).filter(r => r.width && r.height)
    .map(r => ({x: r.x - pane.x, y: r.y - pane.y, width: r.width, height: r.height}));
}
function inSafeZone(point, margin = 16) {
  const canvas = map.getCanvas();
  if (point.x < margin || point.y < margin || point.x > canvas.clientWidth - margin || point.y > canvas.clientHeight - margin) return false;
  return !overlayRects().some(r => point.x > r.x - margin && point.x < r.x + r.width + margin && point.y > r.y - margin && point.y < r.y + r.height + margin);
}

// Show the selected vehicle together with its target; the padding clears the panels over the map.
function focusSelected() {
  const v = findRow(selected);
  if (!map || mapStatus !== 'ready' || !v || !locationOk(v)) return;
  lastFollowAt = performance.now();
  const here = [Number(v.lon), Number(v.lat)];
  const target = targetPoint(v);
  const pane = $('map-pane').getBoundingClientRect();
  const attention = $('attention').hidden ? null : $('attention').getBoundingClientRect();
  const legend = document.querySelector('#map-pane .legend')?.getBoundingClientRect();
  const padding = {top: Math.max(60, attention ? attention.bottom - pane.top + 40 : 60),
    bottom: Math.max(60, legend ? pane.bottom - legend.top + 40 : 60), left: 100, right: 100};
  if (!target) { map.easeTo({center: here, zoom: Math.max(13, map.getZoom()), padding, duration: 600}); return; }
  const bounds = new maplibregl.LngLatBounds(here, here).extend(target);
  map.fitBounds(bounds, {padding, maxZoom: 15, duration: 600});
}

// Follow the selected vehicle (L-3): when it or its target leaves the safe zone, the camera eases
// back, at most every FOLLOW_EVERY_MS. A manual pan or zoom stops following; «Следить за …» resumes.
const FOLLOW_EVERY_MS = 3000;
function followSelected() {
  const v = findRow(selected);
  $('follow').hidden = !(v && locationOk(v) && !follow && mapStatus === 'ready');
  $('follow').textContent = v ? `Следить за ${v.tr_id}` : '';
  if (!follow || !v || !locationOk(v) || mapStatus !== 'ready' || map.isMoving()) return;
  if (performance.now() - lastFollowAt < FOLLOW_EVERY_MS) return;
  const points = [[Number(v.lon), Number(v.lat)], targetPoint(v)].filter(Boolean).map(p => map.project(p));
  if (points.every(p => inSafeZone(p))) return;
  focusSelected();
}

// ---- Selection ---------------------------------------------------------------------------
function choose(id, focus) {
  const next = id == null ? null : String(id);
  const changed = next !== selected;
  selected = next;
  // Choosing an object is reading its event; it is not taking it into work.
  const incident = selected ? incidentForVehicle(incidents, selected) : null;
  if (incident?.unread) { markRead(incidents, incident.id); renderEvents(); }
  if (changed) { clearRoute(); if (selected) loadRoute(); follow = Boolean(selected); }
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
// The delay of a row: full in the list, whole minutes on map labels (F-1).
function shortValue(vehicle, assessment, {short = false} = {}) {
  if (assessment.level !== 'nodata') return delayText(vehicle.prediction_s, {short});
  if (runOver(currentRun())) return 'прогон завершён';
  return assessment.hasPrediction ? `${delayText(vehicle.prediction_s, {short})} · устарел` : 'нет прогноза';
}

const capital = value => value ? value[0].toUpperCase() + value.slice(1) : value;
const updatingText = v => `обновляется · возраст ${durationText(v.prediction_age_s) ?? 'неизвестен'} (время данных)`;

function rowNote(vehicle, assessment) {
  let note = LEVEL[assessment.level].label;
  const incident = incidentForVehicle(incidents, vehicle.tr_id);
  if (incident?.unread && incident.state !== 'resolved' && assessment.level !== 'nodata') note = `Новое · ${note.toLowerCase()}`;
  if (assessment.level === 'nodata') {
    note = capital(!isFresh() ? 'Backend недоступен' : runOver(currentRun()) ? 'прогон завершён'
      : reasonText(vehicle.reason) || (assessment.hasPrediction ? 'прогноз устарел' : 'нет прогноза'));
  } else if (vehicle.prediction_updating === true) {
    note = `${note} · обновляется`;
  }
  if (vehicle.route_not_started === true) note = 'Наряд ещё не начался';
  // An invalid-GPS reason already says it; the position note is not repeated.
  const where = assessment.level === 'nodata' && vehicle.reason === 'invalid_gps' && locationOk(vehicle) ? '' : positionNote(vehicle);
  const off = vehicle.off_route === true ? `вне маршрута ${offsetText(vehicle.route_offset_m) ?? ''}`.trim() : '';
  return [note, where, off].filter(Boolean).join(' · ');
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

let listHeld = false;
let listOrder = [];
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
  // Rows keep their places while the pointer is over the list: a live reorder must not move the row
  // being pressed away from under the cursor (the list re-sorts once the pointer leaves).
  let rows = visible;
  if (listHeld && listOrder.length) {
    const place = new Map(listOrder.map((id, index) => [id, index]));
    rows = [...visible].sort((a, b) => (place.get(String(a.vehicle.tr_id)) ?? 1e9) - (place.get(String(b.vehicle.tr_id)) ?? 1e9));
  }
  listOrder = rows.map(({vehicle}) => String(vehicle.tr_id));
  patchChildren(list, rows.map(({vehicle, assessment}) => {
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

const runOver = run => run?.state === 'completed';

// Card order (UI review L-1): a sticky top (ID, level, the forecast and its target), then the stops,
// facts, the event, and «Технические подробности» collapsed. Only the card scrolls.
function renderCard() {
  const card = $('card');
  const v = findRow(selected);
  if (!v) {
    const empty = document.createElement('p');
    empty.className = 'card-empty';
    empty.textContent = snapshotRows().length
      ? 'Выберите машину на карте или в списке — появятся маршрут, остановки и цель с прогнозом.'
      : 'Карточка появится, когда в снимке будут машины прогона.';
    empty.title = empty.textContent;
    patchChildren(card, [empty]);
    card.dataset.level = 'none';
    cardFor = null;
    return;
  }
  const fresh = isFresh();
  const assessment = assess(v, fresh);
  const run = currentRun();
  const top = el('div', {className: 'card-top', 'data-key': 'top'});
  const close = el('button', {type: 'button', id: 'card-close', className: 'card-close', 'aria-label': 'Закрыть карточку', dataset: {action: 'close-card'}}, '×');
  const head = el('header', {},
    el('span', {className: 'card-kind'}, 'Автобус'),
    el('h2', {}, text(v.tr_id)),
    el('span', {className: 'level-chip', dataset: {level: assessment.level}},
      assessment.level === 'nodata' && assessment.hasPrediction ? 'Прогноз устарел' : LEVEL[assessment.level].label),
    close);

  // Headline (C-2): the value, one line about the target, one line about the source.
  const outsideRun = v.target_time_begin && run?.dataset_end && String(v.target_time_begin) > String(run.dataset_end);
  const prediction = assessment.level !== 'nodata' ? v.prediction_s : null;
  const expected = shiftedText(v.target_time_begin, prediction, {seconds: true});
  const value = el('strong');
  const targetLine = el('small', {id: 'headline-target'});
  const source = el('small', {className: 'headline-source'});
  if (assessment.level !== 'nodata') {
    value.textContent = delayText(v.prediction_s);
    targetLine.textContent = `Цель — плановая остановка ${planText(v.target_time_begin) ?? '?'}, ожидаем ≈ ${expected ?? '?'}`;
    source.append(`${BASIS.model} · обновлён ${ageText(v.prediction_age_s)}`);
    if (v.prediction_updating === true) {
      source.append(' ', el('span', {id: 'prediction-updating', className: 'pulse',
        title: `Пришли новые кадры той же цели; прогноз по ним ещё считается. Показан последний прогноз для этой цели (возраст ${durationText(v.prediction_age_s) ?? 'неизвестен'}, время данных).`}, 'обновляется'));
    }
  } else if (assessment.hasPrediction) {
    value.textContent = `${delayText(v.prediction_s)} · устарел`;
    targetLine.textContent = outsideRun ? 'Цель за пределами окна данных прогона' : `Цель — плановая остановка ${planText(v.target_time_begin) ?? '?'}`;
    source.textContent = !fresh ? 'Последний известный: Backend недоступен'
      : runOver(run) ? 'Последний прогноз прогона — прогон завершён, новых не будет.'
      : `Последний известный: ${reasonText(v.reason) || STATUS[v.status] || text(v.status)}`;
  } else if (runOver(run)) {
    value.textContent = 'Прогон завершён';
    source.textContent = 'Данных прогона больше нет — прогнозов не будет до нового прогона.';
  } else if (v.route_not_started === true && fresh) {
    value.textContent = 'Наряд ещё не начался';
    source.textContent = 'Плановых остановок наряда рядом с текущим временем нет — прогнозировать нечего.';
  } else {
    value.textContent = 'Нет прогноза';
    if (outsideRun) targetLine.textContent = 'Цель за пределами окна данных прогона';
    source.textContent = `Прогноза нет: ${fresh ? reasonText(v.reason) || 'источник не передал прогноз' : 'Backend недоступен'}`;
  }
  const headline = el('div', {className: 'headline'}, el('span', {}, 'Прогноз задержки у цели'), value,
    targetLine.textContent ? targetLine : null, source);
  top.append(head, headline);
  const off = v.off_route === true ? el('p', {id: 'off-route', className: 'off-route', 'data-key': 'off-route'},
    `Вне маршрута ${offsetText(v.route_offset_m) ?? ''} — координаты не совпадают с маршрутом наряда${assessment.level !== 'nodata' ? '; прогноз может быть неверен' : ''}.`) : null;

  const facts = document.createElement('dl');
  facts.dataset.key = 'facts';
  field(facts, 'Текущее опоздание', currentDelayText(v.cur_dev_s),
    v.cur_dev_s == null ? reasonText(v.reason) ?? 'факт не определён' : 'на последней пройденной остановке; это факт, не прогноз');
  field(facts, 'Цель прогноза', !v.target_stop_id ? 'цель не определена'
    : outsideRun ? 'Цель за пределами окна данных прогона'
    : `план ${planText(v.target_time_begin) ?? '?'}${expected ? ` → ${expected} (${BASIS.model})` : assessment.hasPrediction ? ' · прогноз устарел' : ' · прогноза нет'}`,
  v.target_stop_id ? `первая плановая остановка через 10–15 мин${targetPoint(v) ? '' : ' · координаты нет — на карте не показана'}` : null);

  // Technical details (C-1): identifiers and revisions for engineers, collapsed by default.
  const tech = el('details', {id: 'card-tech', className: 'card-tech', 'data-key': `tech:${v.tr_id}`}, el('summary', {}, 'Технические подробности'));
  if (techOpen) tech.setAttribute('open', '');
  const details = document.createElement('dl');
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
  field(details, 'Цель · запись расписания', text(v.target_stop_id));
  field(details, 'Причина задержки', 'источника нет', 'причина не угадывается');
  const shownData = shownRoute();
  field(details, 'Ревизия строки ТС', `снимок rev ${text(v.revision)}${shownData ? ` · маршрутный контекст rev ${text(shownData.vehicle_revision)}` : ''}`,
    'маршрут и снимок берут цель и прогноз из одной строки Backend; ревизия связывает их');
  tech.append(details);

  const incident = incidentForVehicle(incidents, v.tr_id);
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  if (incident && incident.state !== 'resolved') {
    actions.append(el('button', {type: 'button', id: 'incident-action', className: 'primary', 'data-key': incident.id,
      dataset: {workflow: incident.workflow, action: 'incident-workflow', id: incident.id}},
    incident.workflow === 'in_work' ? 'Снять с работы' : 'Взять в работу'));
  }
  const show = el('button', {type: 'button', id: 'card-show', className: !incident || incident.state === 'resolved' ? 'primary' : null,
    disabled: !(locationOk(v) && mapStatus === 'ready'), dataset: {action: 'focus'}}, 'Показать на карте');
  actions.append(show);
  if (!locationOk(v) || !gpsValid(v)) {
    actions.append(el('p', {className: 'card-note'}, locationOk(v) ? 'Последний кадр без валидного GPS: на карте — последняя валидная позиция, серая иконка с «?».'
      : positionNote(v) === 'вне карты' ? 'Позиция вне области карты — объект на карте не показан.' : 'Валидной позиции нет — объект не показан на карте.'));
  }
  const parts = [top, off, routeBlock(v), facts, incident ? incidentBlock(incident, v) : null, tech, actions].filter(Boolean);
  // Another vehicle gets a fresh card; the same vehicle is patched in place, so focus, typing, the
  // scroll and a button being pressed all survive the poll.
  if (cardFor !== selected) { card.replaceChildren(...parts); cardFor = selected; card.scrollTop = 0; } else patchChildren(card, parts);
  card.dataset.level = assessment.level;
}

// The selected vehicle's stops (C-3), in groups instead of a label on every row: passed (plan
// only, the last PASSED_SHOWN), before the target (the current delay carried forward — a fact),
// the target (the model), after it (the same shift as an explicit assumption, behind a toggle).
const PASSED_SHOWN = 2;
function stopGroups(rows, {cur, modelUsable, staleModel, hasPrediction}) {
  const title = {
    passed: 'Пройдено — только план',
    before_target: rows.some(r => r.role === 'before_target' && r.basis === 'fact')
      ? `До цели — текущее опоздание ${delayText(cur)} переносится вперёд (${BASIS.fact})` : 'До цели — план',
    target: `Цель — ${modelUsable && hasPrediction ? BASIS.model : staleModel ? 'прогноз устарел' : 'прогноза нет'}`,
    after_target: rows.some(r => r.role === 'after_target' && r.basis === 'assumption') ? `После цели — ${BASIS.assumption}`
      : staleModel ? 'После цели — план · прогноз устарел' : modelUsable && hasPrediction && !shiftAfterTarget ? 'После цели — план · сдвиг скрыт' : 'После цели — план',
    planned: 'По плану',
  };
  const groups = [];
  for (const row of rows) {
    if (groups.at(-1)?.role !== row.role) groups.push({role: row.role, title: title[row.role] ?? row.role, rows: []});
    groups.at(-1).rows.push(row);
  }
  return groups;
}

function routeBlock(vehicle) {
  const box = el('section', {className: 'route', id: 'route', 'data-key': 'route', dataset: {status: route.status}});
  const check = el('input', {type: 'checkbox', id: 'shift-after-target', checked: shiftAfterTarget, dataset: {action: 'shift-after-target'}});
  box.append(el('div', {className: 'route-head'}, el('b', {}, 'Остановки'), el('label', {className: 'route-toggle'}, check, ' Сдвиг после цели')));
  const note = (content, kind = 'info') => box.append(el('p', {className: 'route-note', dataset: {kind}}, content));
  const data = shownRoute();
  if (!data) {
    if (route.status === 'loading') note('Загрузка маршрутного контекста…');
    else if (route.status === 'missing') note(`Маршрутного контекста нет: ${route.reason}.`, 'warn');
    else if (route.status === 'offline') note(`Маршрутный контекст недоступен: ${route.reason}. Маршрут и остановки не показаны.`, 'warn');
    return box;
  }
  if (route.status === 'offline') note(`Backend не отвечает (${route.reason}) — показан последний полученный контекст, он не обновляется.`, 'warn');
  // Same row revision but other values would break the Backend contract: say so rather than mix values.
  // A different revision is only a newer/older calculation; refreshRoute catches up.
  if (routeKey(data) !== rowKey(vehicle) && data.vehicle_revision === vehicle.revision) {
    note('Маршрутный контекст расходится со снимком при той же ревизии строки ТС; значения остановок — из маршрутного контекста.', 'warn');
  }
  const {modelUsable, factUsable} = usability(vehicle);
  const staleModel = !modelUsable && data.prediction_s != null;
  const rows = routeRows(data);
  const windowText = data.window_start && data.window_end ? `${planText(data.window_start)}–${planText(data.window_end)}` : '«сейчас − 5 мин … цель + 15 мин»';
  if (!rows.length) note(`В окне ${windowText} плановых остановок нет.`);
  const list = el('ol', {className: 'stops'});
  const groups = stopGroups(rows, {cur: factUsable ? data.cur_dev_s : null, modelUsable, staleModel, hasPrediction: data.prediction_s != null});
  for (const group of groups) {
    const shown = group.role === 'passed' ? group.rows.slice(-PASSED_SHOWN) : group.rows;
    list.append(el('li', {className: 'stop-group', dataset: {group: group.role}}, group.role === 'passed' && group.rows.length > shown.length
      ? `${group.title} · ещё ${group.rows.length - shown.length} выше не показаны` : group.title));
    for (const row of shown) {
      list.append(el('li', {dataset: {role: row.role, stop: row.stop_id ?? '', ...(row.basis ? {basis: row.basis} : {})},
        title: row.onMap ? null : 'Координаты нет — на карте не показана'},
      el('span', {className: 'stop-no'}, `ост. ${row.no}`),
      el('span', {className: 'stop-time'}, row.expected ? `${row.plan} → ${row.expected}` : row.plan ?? '—'),
      el('span', {className: 'stop-delta'}, row.delay != null ? delayText(row.delay) : '')));
    }
  }
  box.append(list);
  const bad = undrawnCount(data);
  const dropped = Number(data.stops_dropped) || 0;
  const truncated = Number(data.stops_truncated) || 0;
  const missing = [dropped ? `${dropped} остановок без координат исключены Backend` : null,
    truncated ? `${truncated} самых ранних остановок окна не показаны (не больше 40)` : null,
    bad.stops ? `${bad.stops} остановок без координат на карте не показаны` : null].filter(Boolean);
  if (missing.length) note(`${missing.join(' · ')}.`);
  box.append(el('small', {className: 'route-caption'}, `Окно остановок ${windowText}. Линия на карте — плановый маршрут наряда между остановками, не GPS-трек: впереди ТС — ярко со стрелками, пройденное — тускло; если ТС не на маршруте, линия тусклая целиком.`));
  return box;
}

// An episode is one vehicle (incidents.js); its line is the vehicle as last seen.
const incidentTitle = incident => `ТС ${incident.tr_id}`;
const vehicleStateText = incident => (incident.vehicle_state === 'nodata' ? 'нет данных'
  : incident.vehicle_state === 'normal' ? 'задержка закончилась' : `прогноз ${delayText(incident.last_s)}`);

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
  const current = assess(vehicle, isFresh());
  const forecast = current.level !== 'nodata' ? delayText(vehicle.prediction_s)
    : current.hasPrediction ? `последний прогноз (устарел): ${delayText(vehicle.prediction_s)}` : 'нет';
  message.value = `${vehicle.tr_id}: прогноз задержки ${target}${forecast}. Сообщите диспетчеру обстановку на линии.`;
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

// One line over the map (L-5, H-2): the end of the run, else the first delay the dispatcher has not
// opened and not taken into work; never a repeat of the card that is already open.
function renderAttention() {
  const box = $('attention');
  if (!feed?.snapshot || !snapshotRows().length) { box.hidden = true; return; }
  box.hidden = false;
  if (!isFresh()) {
    box.dataset.level = 'nodata';
    patchText(box, 'Backend недоступен: показан последний снимок, предупреждения не оцениваются.');
    return;
  }
  const run = currentRun();
  if (runOver(run)) {
    const minutesShown = run.speedup ? Math.round((Date.parse(run.dataset_end) - Date.parse(run.dataset_start)) / 60000 / Number(run.speedup)) : null;
    box.dataset.level = 'normal';
    patchText(box, `Прогон завершён: показано окно ${planText(run.dataset_start) ?? '?'}–${planText(run.dataset_end) ?? '?'}${Number.isFinite(minutesShown) ? ` за ${minutesShown} мин` : ''}. `
      + 'Прогнозов больше нет — это конец данных, не сбой. Новый прогон — командой перезапуска (README).');
    return;
  }
  if (run?.state === 'failed' || run?.state === 'stalled') {
    box.dataset.level = 'severe';
    patchText(box, `Прогон ${runStateText(run)}. Прогнозы не обновляются — перезапустите прогон (README).`);
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
  const open = warnings.filter(({vehicle}) => String(vehicle.tr_id) !== selected
    && incidentForVehicle(incidents, vehicle.tr_id)?.workflow !== 'in_work');
  if (!open.length) {
    box.dataset.level = 'normal';
    patchText(box, `Все предупреждения открыты или в работе (${warnings.length}).`);
    return;
  }
  const [{vehicle, assessment}] = open;
  box.dataset.level = assessment.level;
  const title = el('span', {className: 'attention-title'}, incidentForVehicle(incidents, vehicle.tr_id)?.unread ? 'Новая задержка' : 'Задержка у цели');
  const body = el('span', {}, `${vehicle.tr_id} · прогноз ${delayText(vehicle.prediction_s)}${open.length > 1 ? ` · ещё ${open.length - 1}` : ''}`);
  const button = el('button', {type: 'button', 'data-key': 'attention-open', dataset: {action: 'choose', id: String(vehicle.tr_id)}}, 'Открыть');
  patchChildren(box, [title, body, button]);
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
    meta.textContent = [`№${incident.number}`, `с ${clockText(incident.opened_at)}`, `пик ${delayText(incident.peak_s)}`, WORKFLOW[incident.workflow],
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
  toasts = toasts.slice(-TOAST_MAX);
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
  // Only while the delay is current: not for the vehicle whose card is open, not once it ended or
  // lost its data, and none after the run (E-1, H-2) — the banner and the event centre keep them.
  const live = !runOver(currentRun());
  patchChildren($('toasts'), toasts.map(({id}) => findIncident(incidents, id))
    .filter(incident => live && incident && incident.tr_id !== selected && ['warning', 'severe'].includes(incident.vehicle_state)).map(incident => {
    const {id} = incident;
    const box = document.createElement('div');
    box.className = 'toast';
    box.dataset.id = id;
    box.dataset.key = id;
    box.setAttribute('role', 'status');
    const title = document.createElement('b'); title.textContent = 'Новая задержка';
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
  // A toast only for a vehicle the dispatcher is not looking at (E-1).
  if (known) for (const id of opened) if (findIncident(incidents, id)?.tr_id !== selected) showToast(id);
}

// Header: where the data comes from and how fast it runs — all from `snapshot.run`.
function renderStatus() {
  const run = currentRun();
  const box = $('run');
  box.dataset.state = run?.state ?? 'unknown';
  const snap = feed?.snapshot;
  // Outside SOURCE_CLOCK=simulation Backend has no run (snapshot.run = null): say which clock it runs on.
  $('run-source').title = $('run-source').textContent = !snap ? 'Источник неизвестен' : run ? `${sourceText(run.source)} → ML` : `Backend без прогона · часы ${text(snap.source_clock)} → ML`;
  const runId = $('run-id');
  runId.textContent = run?.run_id ? `прогон ${shortRunId(run.run_id)}` : !snap ? 'прогон неизвестен' : run ? 'прогон не зарегистрирован' : 'прогона нет';
  runId.title = run?.run_id ?? '';
  runId.dataset.runId = run?.run_id ?? '';
  const speed = $('run-speed');
  speed.textContent = speedupText(run?.speedup);
  speed.dataset.speedup = run?.speedup ?? '';
  speed.dataset.short = Number(run?.speedup) > 0 ? `×${run.speedup}` : '×?';
  speed.title = `${speed.textContent}. Время данных идёт в N раз быстрее времени показа (значение прогона Backend).`;
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
  renderRouteLayers(); // the leader and the overview follow the vehicles
  renderMapObjects();
  followSelected();
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
  routesFeed = {status: 'idle', data: null, at: 0, inFlight: false}; // the next poll loads the new run's routes
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
  refreshRoutes();
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
$('vehicles').addEventListener('mouseenter', () => { listHeld = true; });
$('vehicles').addEventListener('mouseleave', () => { listHeld = false; setHovered(null); renderList(); });
$('card').addEventListener('change', event => {
  if (event.target.id !== 'shift-after-target') return;
  shiftAfterTarget = event.target.checked;
  renderRouteLayers(); renderMapObjects(); renderCard();
});
$('card').addEventListener('toggle', event => { if (event.target.id === 'card-tech') techOpen = event.target.open; }, true);
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
$('overview').addEventListener('click', () => { follow = false; overview(true); followSelected(); });
$('follow').addEventListener('click', () => { follow = true; lastFollowAt = 0; focusSelected(); followSelected(); });
// «События» and «Диагностика» never open together (L-4).
$('events-toggle').addEventListener('click', () => { eventsOpen = !eventsOpen; if (eventsOpen) $('diagnostics').open = false; renderEvents(); });
$('diagnostics').addEventListener('toggle', () => { if ($('diagnostics').open && eventsOpen) { eventsOpen = false; renderEvents(); } });
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
