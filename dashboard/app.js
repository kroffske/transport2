import * as maplibregl from 'maplibre-gl';
import {PMTiles, Protocol} from 'pmtiles';
import * as THREE from 'three';
import {NOTE_MAX, UNMAPPED, acknowledge, addNote, assess, countByFilter, countByRoute, createIncidentStore, findIncident, incidentCounts,
  incidentForVehicle, markRead, newWarningIds, observeSnapshot, orderedIncidents, reopen, routeKeyOf, visibleRows} from './incidents.js';
import {PHASES, ROUTE_CATALOG, createRun, isFinished, next, pause, phaseRows, scenarioSnapshot, start} from './scenario.js';
import {placeLabels} from './map-labels.js';
import './style.css';

const $ = id => document.getElementById(id);
const text = value => value === null || value === undefined || value === '' ? 'неизвестно' : String(value);
const minutes = seconds => seconds == null || !Number.isFinite(Number(seconds)) ? 'неизвестно' : `${(Number(seconds) / 60).toFixed(1)} мин`;
const ageText = seconds => seconds == null || !Number.isFinite(Number(seconds)) ? 'неизвестно' : `${Number(seconds).toFixed(0)} с назад`;
const clockText = iso => typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : text(iso);
const locationOk = v => v.location_valid === true && v.lon != null && v.lat != null
  && Number.isFinite(Number(v.lon)) && Number.isFinite(Number(v.lat)) && Math.abs(Number(v.lat)) <= 90 && Math.abs(Number(v.lon)) <= 180;
const targetOk = v => v.target_lon != null && v.target_lat != null && Number.isFinite(Number(v.target_lon)) && Number.isFinite(Number(v.target_lat));

const MODES = {
  demo: {badge: 'Демо-сценарий · значения заданы', title: 'Позиции, прогнозы и цели заданы локальным сценарием; это не телеметрия и не результат модели.'},
  live: {badge: 'Поток Backend · телеметрия NDTP', title: 'Значения из consumer /api/snapshot. При ошибке Backend показан последний снимок; сценарий не подставляется.'},
};
const LEVEL = {
  severe: {color: '#c8412f', halo: '#f2c4bc', label: 'Сильная задержка'},
  warning: {color: '#e39a2d', halo: '#f7deb0', label: 'Предупреждение'},
  normal: {color: '#23845f', label: 'В пределах нормы'},
  nodata: {color: '#ffffff', label: 'Нет данных'},
};
const FILTER_LABEL = {all: 'Все', warning: 'С предупреждениями', nodata: 'Нет данных'};
const STATUS = {normal: 'данные в норме', degraded: 'данные частично устарели', unavailable: 'прогноз недоступен'};
const REASON = {
  no_target_in_horizon: 'нет целевой остановки в горизонте прогноза',
  disconnected: 'устройство отключено',
  invalid_gps: 'последняя позиция GPS недостоверна',
  invalid_latest_gps: 'последняя позиция GPS недостоверна',
  stale_gps: 'GPS устарел',
  no_available_gps: 'нет позиции GPS',
  no_confident_observed_stop: 'не определена пройденная остановка',
  prediction_waiting_new_telemetry: 'ожидается новая телеметрия',
  prediction_pending: 'прогноз рассчитывается',
  prediction_behind_input: 'прогноз отстаёт от телеметрии',
  prediction_aging: 'прогноз стареет',
  unsupported_day: 'день не поддерживается моделью',
  ml_timeout: 'модель не ответила вовремя',
  insufficient_stop_data: 'недостаточно данных об остановках',
};
const DEFAULT_VIEW = {center: [37.6173, 55.7558], zoom: 11};
const SCENARIO_STEP_MS = 8000; // Start advances one phase per step until the last phase.
const TOAST_MS = 15000;
const INCIDENT_STATE = {active: 'Активно', monitoring_lost: 'Мониторинг потерян', resolved: 'Задержка закончилась'};
const WORKFLOW = {new: 'Новое', in_work: 'В работе'};
// Colours of the two demo directions: distinct from the delay colours on purpose.
const DIRECTION_COLOR = {'demo-line:a': '#2f6f9f', 'demo-line:b': '#7a4fa3'};
const EXTRACT_BOUNDS = [[37.25, 55.5], [38.0, 56.0]];

// ---- Page state -------------------------------------------------------------------------
let mode = new URLSearchParams(location.search).get('mode') === 'live' ? 'live' : 'demo';
let feed = null; // {status: scenario|loading|online|offline, snapshot, reason, age_s, fetched_at, checked_at}
let receivedAt = performance.now();
let filter = 'all';
let query = '';
let selected = null;
let hovered = null;
let visible = [];
let pendingOverview = true;
let pollTimer = null;
let pollGeneration = 0;
let mapStatus = 'loading'; // loading | ready | unavailable
let mapReason = '';
let manifest = null;
let run = null; // current scenario run (demo mode only); see scenario.js
let runSequence = 0;
let stepTimer = null;
let newWarnings = new Set();
let routeFilter = 'all'; // 'all', UNMAPPED or one route key (always includes the direction)
let incidents = createIncidentStore(mode); // local events and dispatcher actions of this run / mode visit
let eventsOpen = false;
let toasts = []; // [{id, timer}] — one per newly opened episode
let noteDraft = {id: null, text: ''};
let contact = {id: null, result: null}; // driver-contact preview: open incident and last copy outcome
let build = null; // consumer /api/build: hashes of the served screen files

const snapshotRows = () => Array.isArray(feed?.snapshot?.vehicles) ? feed.snapshot.vehicles : [];
// Scenario values are always "current" for the scenario; live values only while Backend answers.
const isFresh = () => mode === 'demo' || feed?.status === 'online';
const findRow = id => snapshotRows().find(v => String(v.tr_id) === id);
const sourceClock = () => feed?.snapshot?.clock_time ?? null;
// Directions drawn on the map: only the demo catalog; live rows carry no route mapping.
const catalogDirections = () => mode === 'demo' ? ROUTE_CATALOG.directions : [];
const directionOf = key => ROUTE_CATALOG.directions.find(d => d.route_key === key) ?? null;

// ---- Map: MapLibre base, locked top-down view, local PMTiles ------------------------------
maplibregl.setWorkerUrl('/static/map-worker.js');
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
const tiles = new PMTiles(`${location.origin}/map/moscow.pmtiles`);
protocol.add(tiles);

const roadWidth = (base, top) => ['interpolate', ['exponential', 1.6], ['zoom'], 9, base, 16, top];
const baseStyle = {
  version: 8,
  sources: {osm: {type: 'vector', url: `pmtiles://${location.origin}/map/moscow.pmtiles`, attribution: '© OpenStreetMap contributors (ODbL)'}},
  layers: [
    {id: 'land', type: 'background', paint: {'background-color': '#eef1ee'}},
    {id: 'green', type: 'fill', source: 'osm', 'source-layer': 'landuse',
      filter: ['in', ['get', 'kind'], ['literal', ['park', 'forest', 'wood', 'grass', 'garden', 'cemetery', 'nature_reserve', 'meadow']]],
      paint: {'fill-color': '#dde8da'}},
    {id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water',
      filter: ['==', ['geometry-type'], 'Polygon'], paint: {'fill-color': '#c3dbe6'}},
    {id: 'buildings', type: 'fill', source: 'osm', 'source-layer': 'buildings', minzoom: 13, paint: {'fill-color': '#e6e7e2'}},
    {id: 'roads-minor', type: 'line', source: 'osm', 'source-layer': 'roads',
      filter: ['in', ['get', 'kind'], ['literal', ['minor_road', 'other']]],
      paint: {'line-color': '#ffffff', 'line-width': roadWidth(0.3, 5)}},
    {id: 'roads-major', type: 'line', source: 'osm', 'source-layer': 'roads',
      filter: ['==', ['get', 'kind'], 'major_road'],
      paint: {'line-color': '#fbfbf8', 'line-width': roadWidth(0.8, 9)}},
    {id: 'roads-highway', type: 'line', source: 'osm', 'source-layer': 'roads',
      filter: ['==', ['get', 'kind'], 'highway'],
      paint: {'line-color': '#f3e3bd', 'line-width': roadWidth(1.2, 11)}},
    {id: 'rail', type: 'line', source: 'osm', 'source-layer': 'roads',
      filter: ['==', ['get', 'kind'], 'rail'], minzoom: 11,
      paint: {'line-color': '#c9cdd0', 'line-width': 1, 'line-dasharray': [3, 2]}},
    {id: 'boundaries', type: 'line', source: 'osm', 'source-layer': 'boundaries',
      paint: {'line-color': '#b9bfc4', 'line-width': 0.8, 'line-dasharray': [2, 2]}},
  ],
};

let map = null;
try {
  map = new maplibregl.Map({
    container: 'map', style: baseStyle, ...DEFAULT_VIEW, minZoom: 9, maxZoom: 16,
    maxBounds: [[37.1, 55.42], [38.15, 56.08]],
    pitch: 0, bearing: 0, maxPitch: 0, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    attributionControl: false,
  });
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
  renderDiagnostics();
}

let tileErrorSeen = false;
if (map) {
  map.on('error', event => {
    tileErrorSeen = true;
    const message = event.error?.message || 'ошибка плиток';
    if (mapStatus !== 'ready') markMapUnavailable(`плитки Москвы не загрузились (${message})`);
    else $('map-state').textContent = `Часть плиток не загрузилась: ${message}`;
  });
  map.on('load', () => { addRouteLayers(); map.addLayer(transportLayer); renderMapObjects(); });
  map.on('idle', () => {
    if (mapStatus !== 'loading' || tileErrorSeen || !map.isSourceLoaded('osm')) return;
    mapStatus = 'ready';
    renderMapState();
    renderMapObjects();
    if (pendingOverview && snapshotRows().length) overview(false);
  });
  map.on('move', layoutLabels);
  map.on('resize', layoutLabels);
  map.on('click', event => { const hit = hitTest(event.point); if (hit) choose(hit, false); });
  map.on('mousemove', event => {
    const hit = hitTest(event.point);
    map.getCanvas().style.cursor = hit ? 'pointer' : '';
    setHovered(hit);
  });
  map.on('mouseout', () => setHovered(null));
}
// A missing or unreadable archive fails here deterministically, before any tile request.
tiles.getHeader().catch(error => markMapUnavailable(`нет локального архива плиток (${error.message || error})`));
fetch('/map/manifest.json').then(r => { if (!r.ok) throw Error(`HTTP ${r.status}`); return r.json(); })
  .then(body => { manifest = body; renderDiagnostics(); })
  .catch(error => markMapUnavailable(`нет описания геоосновы manifest.json (${error.message})`));

// ---- Transport layer: the only renderer of vehicle and target symbols ----------------------
// Three.js draws flat symbols inside a MapLibre custom layer, sharing its camera and WebGL
// context. Positions are MercatorCoordinate scaled to world pixels, so a radius in world
// pixels is a radius in screen pixels at every zoom.
const shapesGeometry = {circle: new THREE.CircleGeometry(1, 40), diamond: new THREE.CircleGeometry(1, 4)};
const materials = new Map();
const material = color => {
  if (!materials.has(color)) {
    materials.set(color, new THREE.MeshBasicMaterial({color, depthTest: false, depthWrite: false, side: THREE.DoubleSide}));
  }
  return materials.get(color);
};
const transportLayer = {
  id: 'transport-three', type: 'custom', renderingMode: '3d',
  onAdd(mapInstance, gl) {
    this.map = mapInstance;
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.renderer = new THREE.WebGLRenderer({canvas: mapInstance.getCanvas(), context: gl, antialias: true});
    this.renderer.autoClear = false;
    this.meshes = [];
  },
  setShapes(shapes) {
    if (!this.scene) return;
    for (const mesh of this.meshes) this.scene.remove(mesh);
    this.meshes = shapes.map((shape, index) => {
      const mesh = new THREE.Mesh(shapesGeometry[shape.geometry || 'circle'], material(shape.color));
      mesh.userData = {coord: maplibregl.MercatorCoordinate.fromLngLat([shape.lon, shape.lat], 0), radius: shape.radius};
      mesh.renderOrder = index;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      return mesh;
    });
    this.map.triggerRepaint();
  },
  render(gl, options) {
    const worldSize = 512 * 2 ** this.map.getZoom();
    for (const mesh of this.meshes) {
      const {coord, radius} = mesh.userData;
      mesh.position.set(coord.x * worldSize, coord.y * worldSize, 0);
      mesh.scale.setScalar(radius);
    }
    this.camera.projectionMatrix.fromArray(options.modelViewProjectionMatrix);
    this.renderer.resetState();
    this.renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.renderer.render(this.scene, this.camera);
  },
  onRemove() { for (const geometry of Object.values(shapesGeometry)) geometry.dispose(); for (const m of materials.values()) m.dispose(); this.renderer.dispose(); },
};

// ---- Route scheme: ordinary MapLibre layers under the transport layer ------------------------
// A dashed line joins the ordered scenario points of each direction. It is a sequence scheme,
// not a road trace; live rows have no route mapping, so nothing is drawn for them.
const emptyCollection = {type: 'FeatureCollection', features: []};
function addRouteLayers() {
  map.addSource('route-scheme', {type: 'geojson', data: emptyCollection});
  map.addSource('route-points', {type: 'geojson', data: emptyCollection});
  const byEmphasis = (focus, base, dim) => ['match', ['get', 'emphasis'], 'focus', focus, 'dim', dim, base];
  map.addLayer({id: 'route-scheme', type: 'line', source: 'route-scheme',
    layout: {'line-cap': 'round', 'line-join': 'round'},
    paint: {'line-color': ['get', 'color'], 'line-width': byEmphasis(4, 2.5, 1.5),
      'line-opacity': byEmphasis(0.95, 0.7, 0.3), 'line-dasharray': [1.5, 1.5]}});
  map.addLayer({id: 'route-points', type: 'circle', source: 'route-points',
    paint: {'circle-radius': byEmphasis(5, 3.5, 2.5), 'circle-color': '#ffffff',
      'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': byEmphasis(2.5, 1.5, 1),
      'circle-opacity': byEmphasis(1, 0.9, 0.4), 'circle-stroke-opacity': byEmphasis(1, 0.9, 0.4)}});
}

// The direction to emphasise: the selected object's, else the chosen direction filter.
function focusRoute() {
  const chosen = findRow(selected);
  if (chosen) return routeKeyOf(chosen);
  return routeFilter !== 'all' && routeFilter !== UNMAPPED ? routeFilter : null;
}

const directionChips = new Map();
function renderRoutes() {
  const drawable = mapStatus === 'ready' && map?.getSource('route-scheme');
  const directions = drawable ? catalogDirections() : [];
  const focus = focusRoute();
  const emphasis = key => focus == null ? 'base' : key === focus ? 'focus' : 'dim';
  if (drawable) {
    map.getSource('route-scheme').setData({type: 'FeatureCollection', features: directions.map(d => ({type: 'Feature',
      properties: {key: d.route_key, color: DIRECTION_COLOR[d.route_key] ?? '#5a6975', emphasis: emphasis(d.route_key)},
      geometry: {type: 'LineString', coordinates: d.stops.map(s => [s.lon, s.lat])}}))});
    map.getSource('route-points').setData({type: 'FeatureCollection', features: directions.flatMap(d => d.stops.map(s => ({type: 'Feature',
      properties: {id: s.id, color: DIRECTION_COLOR[d.route_key] ?? '#5a6975', emphasis: emphasis(d.route_key)},
      geometry: {type: 'Point', coordinates: [s.lon, s.lat]}})))});
  }
  // One chip at the first point of each direction names it and its order of points.
  const keep = new Set();
  for (const d of directions) {
    keep.add(d.route_key);
    let marker = directionChips.get(d.route_key);
    if (!marker) {
      const element = document.createElement('div');
      element.className = 'direction-chip';
      element.dataset.route = d.route_key;
      element.style.setProperty('--route', DIRECTION_COLOR[d.route_key] ?? '#5a6975');
      element.textContent = `${d.short}: ${d.stops[0].id} → ${d.stops.at(-1).id}`;
      element.title = `${d.label} · схема последовательности точек сценария, не трасса`;
      marker = new maplibregl.Marker({element, anchor: 'right', offset: [-8, 0]}).setLngLat([d.stops[0].lon, d.stops[0].lat]).addTo(map);
      directionChips.set(d.route_key, marker);
    }
    marker.getElement().dataset.emphasis = emphasis(d.route_key);
  }
  for (const [key, marker] of directionChips) if (!keep.has(key)) { marker.remove(); directionChips.delete(key); }
}

function vehicleShapes(vehicle, assessment) {
  const lon = Number(vehicle.lon), lat = Number(vehicle.lat);
  const id = String(vehicle.tr_id);
  const shapes = [];
  const level = LEVEL[assessment.level];
  if (id === selected) shapes.push({lon, lat, radius: 16, color: '#10202e'}, {lon, lat, radius: 13, color: '#ffffff'});
  else if (id === hovered) shapes.push({lon, lat, radius: 13, color: '#2f6f9f'});
  else if (level.halo) shapes.push({lon, lat, radius: 13, color: level.halo});
  const big = id === selected ? 1.5 : 0;
  if (assessment.level === 'nodata') {
    // Hollow ring: "no usable prediction" differs by shape, not only by color.
    shapes.push({lon, lat, radius: 8 + big, color: '#5d6b76'}, {lon, lat, radius: 5.5 + big, color: '#ffffff'});
  } else {
    shapes.push({lon, lat, radius: 8.5 + big, color: '#1b2a36'}, {lon, lat, radius: 6.5 + big, color: level.color});
  }
  return shapes;
}

function renderMapObjects() {
  const drawable = mapStatus === 'ready' && map;
  const located = drawable ? visible.filter(({vehicle}) => locationOk(vehicle)) : [];
  const chosen = findRow(selected);
  const shapes = [];
  if (drawable && chosen && targetOk(chosen)) {
    const lon = Number(chosen.target_lon), lat = Number(chosen.target_lat);
    shapes.push({lon, lat, radius: 12, color: '#1b2a36', geometry: 'diamond'},
      {lon, lat, radius: 9, color: '#ffffff', geometry: 'diamond'},
      {lon, lat, radius: 3.5, color: '#1b2a36', geometry: 'diamond'});
  }
  const ordered = [...located].sort((a, b) => (String(a.vehicle.tr_id) === selected) - (String(b.vehicle.tr_id) === selected)
    || (String(a.vehicle.tr_id) === hovered) - (String(b.vehicle.tr_id) === hovered));
  // A selected object hidden by the filter stays on the map, drawn on top.
  if (drawable && chosen && locationOk(chosen) && !located.some(({vehicle}) => vehicle === chosen)) {
    ordered.push({vehicle: chosen, assessment: assess(chosen, isFresh())});
  }
  for (const {vehicle, assessment} of ordered) shapes.push(...vehicleShapes(vehicle, assessment));
  transportLayer.setShapes(shapes);
  renderLabels(ordered);
  renderTargetLabel(drawable && chosen && targetOk(chosen) ? chosen : null);
  renderRoutes();
  layoutLabels();
}

// The selected object's target, named by its diamond; only for a coordinate from the source.
// The name goes on the side away from the object (the map never rotates), so it does not
// cover the object's own label, which sits above the object.
let targetLabel = null;
let targetSide = null;
function renderTargetLabel(vehicle) {
  const side = vehicle && Number(vehicle.lat) < Number(vehicle.target_lat) ? 'above' : 'below';
  if (!vehicle || side !== targetSide) { targetLabel?.remove(); targetLabel = null; targetSide = null; }
  if (!vehicle) return;
  if (!targetLabel) {
    const element = document.createElement('div');
    element.className = 'target-label';
    targetSide = side;
    targetLabel = new maplibregl.Marker({element, anchor: side === 'above' ? 'bottom' : 'top', offset: [0, side === 'above' ? -12 : 12]})
      .setLngLat([Number(vehicle.target_lon), Number(vehicle.target_lat)]).addTo(map);
  }
  targetLabel.getElement().textContent = `Цель ${vehicle.target_stop_id ?? ''} · план ${clockText(vehicle.target_time_begin)}`;
  targetLabel.setLngLat([Number(vehicle.target_lon), Number(vehicle.target_lat)]);
}

// Editable DOM labels for the few demo/live objects; the dot itself stays in the Three.js layer.
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
    element.classList.toggle('is-selected', id === selected);
    element.classList.toggle('is-hovered', id === hovered);
    element.textContent = `${id} · ${shortValue(vehicle, assessment)}`;
    marker.setLngLat([Number(vehicle.lon), Number(vehicle.lat)]);
  }
  for (const [id, marker] of labels) if (!keep.has(id)) { marker.remove(); labels.delete(id); }
}

// Each label takes a free side of its dot (see map-labels.js); redone on every camera move because
// label sizes are fixed in pixels while the distances between dots change with zoom.
function layoutLabels() {
  if (!map || !labels.size) return;
  const box = (lngLat, element, [ax, ay], [ox, oy]) => { // ax/ay: anchor point as a fraction of the element
    const p = map.project(lngLat);
    const width = element.offsetWidth, height = element.offsetHeight;
    return {x: p.x + ox - ax * width, y: p.y + oy - ay * height, width, height};
  };
  const obstacles = [...directionChips.values()].map(m => box(m.getLngLat(), m.getElement(), [1, 0.5], [-8, 0]));
  if (targetLabel) obstacles.push(box(targetLabel.getLngLat(), targetLabel.getElement(), [0.5, targetSide === 'above' ? 1 : 0], [0, targetSide === 'above' ? -12 : 12]));
  const canvas = map.getCanvas();
  const placement = placeLabels([...labels].map(([id, marker]) => {
    const p = map.project(marker.getLngLat());
    const element = marker.getElement();
    return {id, x: p.x, y: p.y, width: element.offsetWidth, height: element.offsetHeight, selected: id === selected};
  }), {obstacles, area: {x: 0, y: 0, width: canvas.clientWidth, height: canvas.clientHeight}});
  for (const [id, {placement: side, offset}] of placement) {
    const marker = labels.get(id);
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
  // The shown direction schemes belong to the overview too.
  for (const d of catalogDirections()) {
    if (routeFilter === 'all' || routeFilter === d.route_key) points.push(...d.stops.map(p => [p.lon, p.lat]));
  }
  const duration = animate ? 600 : 0;
  if (!points.length) { map.easeTo({...DEFAULT_VIEW, duration}); return; }
  const bounds = points.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
  map.fitBounds(bounds, {padding: {top: 150, bottom: 110, left: 110, right: 110}, maxZoom: 14, duration});
}

function focusSelected() {
  const v = findRow(selected);
  if (map && mapStatus === 'ready' && v && locationOk(v)) {
    map.easeTo({center: [Number(v.lon), Number(v.lat)], zoom: Math.max(13, map.getZoom()), duration: 600});
  }
}

// ---- Selection ---------------------------------------------------------------------------
function choose(id, focus) {
  selected = id == null ? null : String(id);
  // Choosing an object is reading its event; it is not taking it into work.
  const incident = selected ? incidentForVehicle(incidents, selected) : null;
  if (incident?.unread) { markRead(incidents, incident.id); renderEvents(); }
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

// ---- Panels ------------------------------------------------------------------------------
function shortValue(vehicle, assessment) {
  if (assessment.level !== 'nodata') return minutes(vehicle.prediction_s);
  return assessment.hasPrediction ? `${minutes(vehicle.prediction_s)} · устарел` : 'нет данных';
}

function rowNote(vehicle, assessment) {
  let note = LEVEL[assessment.level].label;
  if (newWarnings.has(String(vehicle.tr_id))) note = `Новое · ${note.toLowerCase()}`;
  if (assessment.level === 'nodata') {
    note = !isFresh() ? 'Backend недоступен' : REASON[vehicle.reason] || vehicle.reason || (assessment.hasPrediction ? 'прогноз устарел' : 'нет прогноза');
    note = note[0].toUpperCase() + note.slice(1);
  }
  const direction = directionOf(routeKeyOf(vehicle));
  if (direction) note = `${note} · напр. ${direction.short}`;
  return locationOk(vehicle) ? note : `${note} · без позиции`;
}

function renderFilters() {
  const counts = countByFilter(snapshotRows(), isFresh());
  for (const button of document.querySelectorAll('[data-filter]')) {
    const key = button.dataset.filter;
    button.setAttribute('aria-pressed', String(key === filter));
    button.querySelector('b').textContent = String(counts[key]);
  }
  renderRouteFilters();
}

// Direction filter: the route keys present in the snapshot, plus «Без привязки».
function renderRouteFilters() {
  const box = $('routes');
  const counts = countByRoute(snapshotRows());
  const options = [['all', 'Все направления', snapshotRows().length], ...counts.map(([key, count]) => [key,
    key === UNMAPPED ? 'Без привязки' : directionOf(key)?.short ? `Напр. ${directionOf(key).short}` : key, count])];
  box.replaceChildren(...options.map(([key, label, count]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.route = key;
    button.setAttribute('aria-pressed', String(key === routeFilter));
    button.title = key === UNMAPPED ? 'Маршрут и направление не сопоставлены' : key === 'all' ? '' : directionOf(key)?.label ?? key;
    if (DIRECTION_COLOR[key]) button.style.setProperty('--route', DIRECTION_COLOR[key]);
    const badge = document.createElement('b'); badge.textContent = String(count);
    button.append(`${label} `, badge);
    button.addEventListener('click', () => { routeFilter = key; render(); if (key !== 'all') overview(true); });
    return button;
  }));
}

function renderList() {
  const list = $('vehicles');
  list.replaceChildren();
  if (mode === 'live' && feed?.status === 'loading') { list.textContent = 'Загрузка снимка Backend…'; return; }
  if (!feed?.snapshot) { list.textContent = 'Backend недоступен, снимков ещё не было. Данные не подставляются.'; return; }
  if (!snapshotRows().length) { list.textContent = 'В снимке нет машин.'; return; }
  if (!visible.length) {
    list.textContent = query.trim() ? `Ничего не найдено по «${query.trim()}».` : `Нет машин для выбранных фильтров («${FILTER_LABEL[filter]}»${routeFilter === 'all' ? '' : ', направление'}).`;
    return;
  }
  for (const {vehicle, assessment} of visible) {
    const id = String(vehicle.tr_id);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'vehicle';
    button.dataset.id = id;
    button.dataset.level = assessment.level;
    if (id === selected) button.setAttribute('aria-current', 'true');
    if (id === hovered) button.classList.add('is-hovered');
    const name = document.createElement('span'); name.className = 'vehicle-id'; name.textContent = id;
    const value = document.createElement('span'); value.className = 'vehicle-value'; value.textContent = shortValue(vehicle, assessment);
    const note = document.createElement('span'); note.className = 'vehicle-note';
    note.textContent = rowNote(vehicle, assessment);
    button.append(name, value, note);
    button.addEventListener('click', () => choose(id, true));
    button.addEventListener('mouseenter', () => setHovered(id));
    button.addEventListener('mouseleave', () => setHovered(null));
    list.append(button);
  }
}

function field(dl, label, value, hint) {
  const dt = document.createElement('dt'); dt.textContent = label;
  const dd = document.createElement('dd'); dd.textContent = value;
  if (hint) { const small = document.createElement('small'); small.textContent = hint; dd.append(small); }
  dl.append(dt, dd);
  return dd;
}

function renderCard() {
  const card = $('card');
  const v = findRow(selected);
  if (!v) {
    const empty = document.createElement('p');
    empty.className = 'card-empty';
    empty.textContent = snapshotRows().length
      ? 'Выберите машину на карте или в списке. Сначала — объекты с предупреждением.'
      : 'Карточка появится, когда в снимке будут машины.';
    card.replaceChildren(empty);
    card.dataset.level = 'none';
    return;
  }
  const fresh = isFresh();
  const assessment = assess(v, fresh);
  const scenario = mode === 'demo';
  const head = document.createElement('header');
  const kind = document.createElement('span'); kind.className = 'card-kind'; kind.textContent = scenario ? 'Автобус · объект сценария' : 'Автобус';
  const title = document.createElement('h2'); title.textContent = text(v.tr_id);
  const chip = document.createElement('span'); chip.className = 'level-chip'; chip.dataset.level = assessment.level; chip.textContent = assessment.level === 'nodata' && assessment.hasPrediction ? 'Прогноз устарел' : LEVEL[assessment.level].label;
  const close = document.createElement('button');
  close.type = 'button';
  close.id = 'card-close';
  close.className = 'card-close';
  close.setAttribute('aria-label', 'Закрыть карточку');
  close.textContent = '×';
  close.addEventListener('click', () => choose(null, false));
  head.append(kind, title, chip, close);

  const headline = document.createElement('div');
  headline.className = 'headline';
  const label = document.createElement('span'); label.textContent = 'Прогноз задержки у цели';
  const value = document.createElement('strong');
  const source = document.createElement('small');
  if (assessment.level !== 'nodata') {
    value.textContent = minutes(v.prediction_s);
    source.textContent = scenario ? 'Значение задано сценарием' : `Прогноз Backend${v.model_version ? ` · модель ${v.model_version}` : ''}`;
  } else if (assessment.hasPrediction) {
    value.textContent = `${minutes(v.prediction_s)} · устарел`;
    source.textContent = fresh ? `Последний известный: ${STATUS[v.status] || text(v.status)}` : 'Последний известный: Backend недоступен';
  } else {
    value.textContent = 'Нет прогноза';
    source.textContent = REASON[v.reason] || (v.reason ? `Код Backend: ${v.reason}` : 'Источник не передал прогноз');
  }
  headline.append(label, value, source);

  const dl = document.createElement('dl');
  const routeKey = routeKeyOf(v);
  const direction = directionOf(routeKey);
  if (routeKey) {
    field(dl, 'Маршрут и направление', v.route_label || routeKey, direction
      ? `точки ${direction.stops.map(s => s.id).join(' → ')} · пунктир на карте — порядок точек сценария, не трасса`
      : 'направление передано источником; схемы в каталоге нет');
  } else {
    field(dl, 'Маршрут и направление', 'Без привязки', 'маршрут и направление не сопоставлены — объект не группируется с другими');
  }
  // A live target ID is a planned timetable item, not a physical stop code; only a verified
  // coordinate from the source is drawn.
  const target = v.target_label || (v.target_stop_id ? `Плановая точка ${v.target_stop_id}` : null);
  const targetHint = scenario ? 'точка схемы сценария, не реальная остановка'
    : target ? `ID плановой записи расписания, не код остановки${targetOk(v) ? '' : ' · координата не передана — на карте не показана'}` : '';
  field(dl, 'Цель и плановое время', target ? `${target} · план ${clockText(v.target_time_begin)}` : 'Цель не определена', targetHint);
  field(dl, 'Наблюдаемое отклонение', minutes(v.cur_dev_s), 'факт на последней пройденной точке, не прогноз');
  // Identity of the Backend's saved ML success: which received NDTP frame and context it used.
  if (!scenario && v.prediction_input_frame_id) {
    const sha = typeof v.artifact_sha256 === 'string' ? v.artifact_sha256.slice(0, 12) : 'неизвестно';
    const link = field(dl, 'Результат модели', `кадр NDTP ${v.prediction_input_frame_id} · контекст №${text(v.prediction_context_revision)}`,
      `модель ${text(v.model_version)} · артефакт ${sha} · расчёт на ${text(v.last_success_at)} (время источника)`);
    link.id = 'model-link';
    link.dataset.frame = String(v.prediction_input_frame_id);
    link.dataset.contextRevision = text(v.prediction_context_revision);
  }
  const freshness = [
    `прогноз ${ageText(v.prediction_age_s)}`,
    `GPS ${locationOk(v) ? ageText(v.gps_age_s) : 'недостоверен'}`,
  ].join(' · ');
  field(dl, 'Свежесть', freshness, scenario ? 'возраст задан сценарием'
    : fresh ? 'на момент снимка Backend' : 'на момент последнего снимка; Backend недоступен — снимок не обновляется');
  field(dl, 'Состояние данных', `${STATUS[v.status] || text(v.status)}${v.reason ? ` · ${REASON[v.reason] || v.reason}` : ''}`);
  field(dl, 'Причина задержки', 'не установлена', 'источника причин нет — причина не угадывается');

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
    act.addEventListener('click', () => {
      if (incident.workflow === 'in_work') reopen(incidents, incident.id, sourceClock());
      else acknowledge(incidents, incident.id, sourceClock());
      renderCard(); renderEvents();
    });
    actions.append(act);
  }
  const show = document.createElement('button');
  show.type = 'button';
  show.id = 'card-show';
  if (!incident || incident.state === 'resolved') show.className = 'primary';
  show.textContent = 'Показать на карте';
  show.disabled = !(locationOk(v) && mapStatus === 'ready');
  show.addEventListener('click', focusSelected);
  actions.append(show);
  if (!locationOk(v)) {
    const note = document.createElement('p'); note.className = 'card-note'; note.textContent = 'Позиция недостоверна — объект не показан на карте.';
    actions.append(note);
  }
  const noteFocused = document.activeElement?.id === 'note-input';
  card.replaceChildren(...[head, headline, incident ? incidentBlock(incident, v) : null, dl, actions].filter(Boolean));
  card.dataset.level = assessment.level;
  const input = noteFocused ? $('note-input') : null; // keep typing across polls and phase steps
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

// Current warnings first, the largest delay first; then the others in join order.
const sortedMembers = incident => [...incident.members].sort((a, b) => (b.state === 'warning') - (a.state === 'warning')
  || (a.state === 'warning' ? b.last_s - a.last_s : 0));
const memberText = m => `${m.tr_id} ${m.state === 'nodata' ? 'нет данных' : m.state === 'normal' ? 'в норме' : minutes(m.last_s)}`;
const incidentTitle = incident => incident.route_label || `Без привязки · ${incident.members[0]?.tr_id ?? ''}`;

// The object's event: lifecycle, dispatcher status, a plain-text note and the local history.
function incidentBlock(incident, vehicle) {
  const box = document.createElement('section');
  box.className = 'incident';
  box.dataset.state = incident.state;
  box.dataset.id = incident.id;
  const head = document.createElement('div');
  head.className = 'incident-head';
  const name = document.createElement('b'); name.textContent = `Событие №${incident.number}`;
  const state = document.createElement('span'); state.className = 'incident-state'; state.dataset.state = incident.state; state.textContent = INCIDENT_STATE[incident.state];
  const flow = document.createElement('span'); flow.className = 'incident-flow'; flow.dataset.workflow = incident.workflow; flow.textContent = WORKFLOW[incident.workflow];
  head.append(name, state, flow);
  const who = document.createElement('p');
  who.className = 'incident-members';
  who.textContent = `${incidentTitle(incident)} · ${sortedMembers(incident).map(memberText).join(' · ')}`;

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
  input.addEventListener('input', () => { noteDraft = {id: incident.id, text: input.value}; });
  const add = document.createElement('button'); add.type = 'submit'; add.textContent = 'Добавить';
  form.append(input, add);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!addNote(incidents, incident.id, input.value, sourceClock())) { input.focus(); return; }
    noteDraft = {id: null, text: ''};
    renderCard(); renderEvents();
    $('note-input')?.focus();
  });

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
  scope.textContent = `Действия и заметки хранятся только в этом браузере и ${mode === 'demo' ? 'этом запуске сценария' : 'этом сеансе потока'}; время — по часам источника.`;
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
    open.addEventListener('click', () => { contact = {id: incident.id, result: null}; renderCard(); $('contact-copy')?.focus(); });
    return open;
  }
  const box = document.createElement('section');
  box.className = 'contact';
  box.setAttribute('aria-label', 'Связь с водителем, прототип');
  const title = document.createElement('b'); title.textContent = 'Прототип · отправка не подключена';
  const hint = document.createElement('small');
  hint.textContent = 'Экран только готовит текст. Отправьте его водителю по штатному каналу связи.';
  const message = document.createElement('textarea');
  message.id = 'contact-text';
  message.readOnly = true;
  message.rows = 3;
  message.setAttribute('aria-label', 'Текст для водителя');
  const target = vehicle.target_label || (vehicle.target_stop_id ? `плановой точки ${vehicle.target_stop_id}` : null);
  message.value = `${vehicle.tr_id}, ${incidentTitle(incident)}: прогноз задержки ${target ? `у ${target.replace(/^Точка сценария/, 'точки')} ` : ''}`
    + `${minutes(vehicle.prediction_s)}. Сообщите диспетчеру обстановку на линии.`;
  const copy = document.createElement('button'); copy.type = 'button'; copy.id = 'contact-copy'; copy.textContent = 'Скопировать текст';
  const close = document.createElement('button'); close.type = 'button'; close.id = 'contact-close'; close.textContent = 'Закрыть';
  const result = document.createElement('p');
  result.id = 'contact-result';
  result.setAttribute('role', 'status');
  result.dataset.result = contact.result || 'none';
  result.textContent = contact.result === 'copied' ? 'Текст скопирован. Он ещё не отправлен — отправьте его вручную.'
    : contact.result === 'manual' ? 'Буфер обмена недоступен: текст выделен — скопируйте его вручную (Ctrl+C / ⌘C). Ничего не отправлено.' : '';
  copy.addEventListener('click', async () => {
    const id = incident.id;
    let outcome = 'manual';
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(message.value);
      outcome = 'copied';
    } catch { /* reported below as manual copy, never as success */ }
    if (contact.id !== id) return;
    contact = {id, result: outcome};
    renderCard();
    if (outcome === 'manual') { const text = $('contact-text'); text?.focus(); text?.select(); }
  });
  close.addEventListener('click', () => { contact = {id: null, result: null}; renderCard(); $('contact-open')?.focus(); });
  const buttons = document.createElement('div'); buttons.className = 'contact-buttons'; buttons.append(copy, close);
  box.append(title, hint, result, message, buttons);
  return box;
}

function renderAttention() {
  const box = $('attention');
  if (!feed?.snapshot || !snapshotRows().length) { box.hidden = true; return; }
  box.hidden = false;
  box.replaceChildren();
  if (!isFresh()) {
    box.dataset.level = 'nodata';
    box.textContent = 'Backend недоступен: показан последний снимок, предупреждения не оцениваются.';
    return;
  }
  const warnings = visibleRows(snapshotRows(), {filter: 'warning', fresh: true});
  if (!warnings.length) {
    const {all, nodata} = countByFilter(snapshotRows(), true);
    box.dataset.level = nodata ? 'nodata' : 'normal';
    box.textContent = nodata === all
      ? `Нет актуальных прогнозов (${all} машин): предупреждения сейчас не оцениваются.`
      : `Предупреждений нет${nodata ? ` · ${nodata} машин без актуального прогноза` : ''}.`;
    return;
  }
  const [{vehicle, assessment}] = warnings;
  box.dataset.level = assessment.level;
  const title = document.createElement('span'); title.className = 'attention-title';
  title.textContent = newWarnings.has(String(vehicle.tr_id)) ? 'Новое предупреждение' : 'Требует внимания';
  const body = document.createElement('span');
  body.textContent = `${vehicle.tr_id} · прогноз задержки ${minutes(vehicle.prediction_s)}${warnings.length > 1 ? ` · ещё ${warnings.length - 1}` : ''}`;
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = 'Открыть карточку';
  open.addEventListener('click', () => choose(String(vehicle.tr_id), true));
  box.append(title, body, open);
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
    empty.textContent = `Событий нет. Событие открывается, когда прогноз задержки больше 2 мин${mode === 'live' && !isFresh() ? '; сейчас Backend недоступен и предупреждения не оцениваются' : ''}.`;
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...all.map(incident => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'event';
    item.dataset.id = incident.id;
    item.dataset.state = incident.state;
    item.dataset.unread = String(incident.unread);
    if (DIRECTION_COLOR[incident.route_key]) item.style.setProperty('--route', DIRECTION_COLOR[incident.route_key]);
    const title = document.createElement('span'); title.className = 'event-title'; title.textContent = incidentTitle(incident);
    const state = document.createElement('span'); state.className = 'incident-state'; state.dataset.state = incident.state; state.textContent = INCIDENT_STATE[incident.state];
    const who = document.createElement('span'); who.className = 'event-members'; who.textContent = sortedMembers(incident).map(memberText).join(' · ');
    const meta = document.createElement('span'); meta.className = 'event-meta';
    meta.textContent = [`№${incident.number}`, `с ${clockText(incident.opened_at)}`, `пик ${minutes(incident.peak_s)}`, WORKFLOW[incident.workflow],
      incident.notes.length ? `заметок ${incident.notes.length}` : null, incident.unread ? 'не прочитано' : null].filter(Boolean).join(' · ');
    item.append(title, state, who, meta);
    item.addEventListener('click', () => openEvent(incident.id));
    return item;
  }));
}

// Go from an event to its direction and its most urgent object.
function openEvent(id) {
  const incident = markRead(incidents, id);
  if (!incident) return;
  eventsOpen = false;
  dismissToast(id);
  routeFilter = incident.route_key ?? 'all';
  filter = 'all'; query = ''; $('search').value = '';
  const member = sortedMembers(incident)[0]?.tr_id ?? null;
  selected = member && findRow(member) ? member : null;
  render();
  focusSelected();
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
  $('toasts').replaceChildren(...toasts.map(({id}) => {
    const incident = findIncident(incidents, id);
    const box = document.createElement('div');
    box.className = 'toast';
    box.dataset.id = id;
    box.setAttribute('role', 'status');
    if (DIRECTION_COLOR[incident.route_key]) box.style.setProperty('--route', DIRECTION_COLOR[incident.route_key]);
    const title = document.createElement('b'); title.textContent = `Новое событие №${incident.number}`;
    const body = document.createElement('span');
    body.textContent = `${incidentTitle(incident)} · ${sortedMembers(incident).map(memberText).join(' · ')}`;
    const open = document.createElement('button'); open.type = 'button'; open.className = 'toast-open'; open.textContent = 'Открыть';
    open.addEventListener('click', () => openEvent(id));
    const close = document.createElement('button'); close.type = 'button'; close.className = 'toast-close'; close.textContent = '×';
    close.setAttribute('aria-label', 'Скрыть уведомление');
    close.addEventListener('click', () => dismissToast(id));
    box.append(title, body, open, close);
    return box;
  }));
}

// Feed a newly received snapshot into the local event store. The first snapshot of a store
// only records what already exists; later new episodes get one toast each.
function ingest() {
  if (!feed?.snapshot) return;
  const known = incidents.observed > 0;
  const opened = observeSnapshot(incidents, snapshotRows(), {fresh: isFresh(), clock: sourceClock()});
  if (known) for (const id of opened) showToast(id);
}

function renderStatus() {
  $('legend-route').hidden = mode !== 'demo';
  $('legend-note').textContent = mode === 'demo'
    ? 'Цвет — прогноз задержки, не вероятность. Пунктир — порядок точек сценария, не трасса по дорогам.'
    : 'Цвет — прогноз задержки, не вероятность. Маршруты не сопоставлены — линии не показаны.';
  const badge = $('mode-badge');
  badge.textContent = MODES[mode].badge;
  badge.title = MODES[mode].title;
  badge.dataset.mode = mode;
  for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  const status = $('data-status');
  status.dataset.status = mode === 'demo' ? 'scenario' : feed?.status || 'loading';
  if (mode === 'demo') status.textContent = `Сценарий · фаза ${run.phase + 1} из ${PHASES.length} · ${runState()}`;
  else if (feed?.status === 'loading') status.textContent = 'Ожидание ответа Backend…';
  else if (feed?.status === 'online') status.textContent = `Backend online · снимок ${liveAge()}`;
  else if (feed?.snapshot) status.textContent = `Backend недоступен · последний снимок ${liveAge()}`;
  else status.textContent = 'Backend недоступен · данных нет';
}

function runState() {
  if (run.playing) return 'идёт';
  if (isFinished(run)) return 'завершён';
  return run.started ? 'пауза' : 'ожидает запуска';
}

function liveAge() {
  const age = feed?.age_s;
  return age == null ? 'возраст неизвестен' : ageText(Math.max(0, Number(age) + (performance.now() - receivedAt) / 1000));
}

function renderDiagnostics() {
  const snap = feed?.snapshot;
  const rows = [['Режим', MODES[mode].badge]];
  if (mode === 'demo') {
    rows.push(['Сценарий', `${text(snap?.scenario_id)} · ${text(snap?.scenario_version)}`], ['Запуск', text(snap?.scenario_run_id)],
      ['Фаза', `${snap.phase.index + 1} из ${snap.phase.count} · ${snap.phase.id}`], ['История запуска', run.history.join(' → ')],
      ['Время сценария', text(snap?.clock_time)]);
  } else {
    rows.push(['Источник', 'consumer /api/snapshot → Backend /v1/vehicles'], ['Состояние', text(feed?.status)],
      ['Ошибка', text(feed?.reason)], ['Часы источника', text(snap?.source_clock)], ['Время источника', text(snap?.clock_time)],
      ['Последний успешный ответ', text(feed?.fetched_at)], ['Последняя проверка', text(feed?.checked_at)], ['Возраст снимка', liveAge()]);
    if (snap?.ingest) rows.push(['Ingest NDTP', `принято ${text(snap.ingest.accepted)} · отброшено ${text(snap.ingest.dropped)} · ошибок ${text(snap.ingest.errors)}`]);
    if (snap?.processing) rows.push(['Вызовы ML', `успешно ${text(snap.processing.ml_succeeded)} · ошибок ${text(snap.processing.ml_failed)} · недоступно ${text(snap.processing.ml_unavailable)}`]);
  }
  const events = incidentCounts(incidents);
  rows.push(['События (локально)', `активных ${events.active} · мониторинг потерян ${events.monitoring_lost} · закончились ${events.resolved}`]);
  rows.push(['Revision', text(snap?.revision)], ['Объектов в снимке', String(snapshotRows().length)],
    ['Геооснова', mapStatus === 'unavailable' ? `недоступна: ${mapReason}` : manifest ? `OSM · ${manifest.date} · ${manifest.coverage}` : 'загрузка…']);
  if (manifest?.sha256) rows.push(['PMTiles sha256', manifest.sha256]);
  rows.push(['Сборка интерфейса · app.js sha256', build ? text(build['static/app.js']) : 'неизвестно'],
    ['Сборка интерфейса · app.css sha256', build ? text(build['static/app.css']) : 'неизвестно']);
  const dl = $('diag-list');
  dl.replaceChildren();
  for (const [label, value] of rows) field(dl, label, value);
}

function renderMapState() {
  $('map-pane').dataset.state = mapStatus;
  const box = $('map-state');
  if (mapStatus === 'loading') box.textContent = 'Загрузка геоосновы…';
  else if (mapStatus === 'ready') box.textContent = '';
  else box.textContent = `Карта недоступна: ${mapReason}. Позиции на карте не показываются; список и карточка справа работают.`;
  box.hidden = mapStatus === 'ready';
  const card = findRow(selected);
  if (card) renderCard();
}

function renderScenario() {
  const box = $('scenario');
  box.hidden = mode !== 'demo';
  if (box.hidden) return;
  const {phase} = feed.snapshot;
  $('scenario-run').textContent = `Запуск ${run.scenario_run_id.split('.').pop()}`;
  $('scenario-run').title = run.scenario_run_id;
  $('scenario-phase').textContent = `Фаза ${phase.index + 1} из ${phase.count} · ${phase.title}`;
  $('scenario-description').textContent = phase.description;
  $('scenario-state').textContent = runState();
  const startButton = $('scenario-start');
  startButton.textContent = run.started ? 'Продолжить' : 'Начать демо';
  startButton.disabled = run.playing || isFinished(run);
  $('scenario-pause').disabled = !run.playing;
  $('scenario-next').disabled = isFinished(run);
  const steps = $('scenario-steps');
  steps.replaceChildren(...PHASES.map((p, i) => {
    const step = document.createElement('li');
    step.title = `${i + 1}. ${p.title}`;
    step.dataset.state = i < phase.index ? 'done' : i === phase.index ? 'current' : 'next';
    return step;
  }));
}

function render() {
  if (selected && !findRow(selected)) selected = null;
  if (routeFilter !== 'all' && !countByRoute(snapshotRows()).some(([key]) => key === routeFilter)) routeFilter = 'all';
  newWarnings = mode === 'demo' && run.phase > 0 ? newWarningIds(phaseRows(run.phase - 1), snapshotRows()) : new Set();
  visible = visibleRows(snapshotRows(), {filter, route: routeFilter, query, fresh: isFresh()});
  renderStatus();
  renderScenario();
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

// ---- Sources ------------------------------------------------------------------------------
async function poll() {
  const generation = pollGeneration;
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
    // Keep the last snapshot we showed; never substitute scenario data.
    next = {...(feed?.snapshot ? feed : {snapshot: null, age_s: null, fetched_at: null}), status: 'offline', reason: String(error.message || error)};
  } finally {
    clearTimeout(timeout);
  }
  if (generation !== pollGeneration) return; // Mode changed while the request was in flight.
  feed = next;
  receivedAt = performance.now();
  ingest();
  render();
  pollTimer = setTimeout(poll, 1500);
}

// ---- Scenario runs ---------------------------------------------------------------------
// The scenario is entered only by an explicit mode choice; nothing on the live path calls these.
function showRun(nextRun) {
  run = nextRun;
  clearTimeout(stepTimer);
  feed = {status: 'scenario', snapshot: scenarioSnapshot(run), age_s: 0};
  ingest();
  if (run.playing) stepTimer = setTimeout(() => { if (mode === 'demo') showRun(next(run)); }, SCENARIO_STEP_MS);
  render();
}

// Reset without reload: a new run ID, phase 1, and none of the previous run's local state.
function newRun() {
  const nonce = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  resetView();
  showRun(createRun(++runSequence, nonce));
}

// Also drops this run's / mode visit's events, dispatcher actions and notes.
function resetView() {
  selected = null; hovered = null; filter = 'all'; routeFilter = 'all'; query = ''; $('search').value = '';
  pendingOverview = true;
  incidents = createIncidentStore(mode);
  eventsOpen = false;
  noteDraft = {id: null, text: ''};
  contact = {id: null, result: null};
  clearToasts();
}

function setMode(nextMode) {
  mode = nextMode;
  pollGeneration += 1;
  clearTimeout(pollTimer);
  clearTimeout(stepTimer);
  run = null;
  const url = new URL(location.href);
  url.searchParams.set('mode', nextMode);
  history.replaceState(null, '', url);
  if (mode === 'demo') { newRun(); return; }
  resetView();
  feed = {status: 'loading', snapshot: null};
  poll();
  render();
}

// ---- Controls -----------------------------------------------------------------------------
for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => { if (button.dataset.mode !== mode) setMode(button.dataset.mode); });
}
for (const button of document.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => { filter = button.dataset.filter; render(); });
}
$('scenario-start').addEventListener('click', () => showRun(start(run)));
$('scenario-pause').addEventListener('click', () => showRun(pause(run)));
$('scenario-next').addEventListener('click', () => showRun(next(run)));
$('scenario-reset').addEventListener('click', newRun);
$('search').addEventListener('input', event => { query = event.target.value; render(); });
$('clear-selection').addEventListener('click', () => choose(null, false));
$('overview').addEventListener('click', () => overview(true));
$('events-toggle').addEventListener('click', () => { eventsOpen = !eventsOpen; renderEvents(); });
$('events-close').addEventListener('click', () => { eventsOpen = false; renderEvents(); });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.target.closest?.('input, textarea')) return;
  if (eventsOpen) { eventsOpen = false; renderEvents(); } else if (selected) choose(null, false);
});
setInterval(() => { if (mode === 'live') { renderStatus(); if ($('diagnostics').open) renderDiagnostics(); } }, 1000);

// The served build is shown in diagnostics so a presenter can confirm the browser has the new bundle.
fetch('/api/build', {cache: 'no-store'}).then(r => r.ok ? r.json() : null).then(payload => { build = payload?.files ?? null; })
  .catch(() => { build = null; }).finally(() => { if ($('diagnostics').open) renderDiagnostics(); });

renderMapState();
setMode(mode);
