import * as maplibregl from 'maplibre-gl';
import {PMTiles, Protocol} from 'pmtiles';
import * as THREE from 'three';
import './style.css';

maplibregl.setWorkerUrl('/static/map-worker.js');
const $ = id => document.getElementById(id);
const text = value => value === null || value === undefined || value === '' ? 'неизвестно' : String(value);
const minutes = seconds => seconds == null || !Number.isFinite(Number(seconds)) ? 'неизвестно' : `${(Number(seconds) / 60).toFixed(1)} мин`;
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
const tiles = new PMTiles(`${location.origin}/map/moscow.pmtiles`);
protocol.add(tiles);
const map = new maplibregl.Map({
  container: 'map', center: [37.6173, 55.7558], zoom: 10.5, minZoom: 8,
  style: {version: 8, sources: {osm: {type: 'vector', url: `pmtiles://${location.origin}/map/moscow.pmtiles`, attribution: '© OpenStreetMap contributors (ODbL)'}},
    layers: [
      {id: 'land', type: 'background', paint: {'background-color': '#e9eee9'}},
      {id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water', paint: {'fill-color': '#b5d9e4'}},
      {id: 'roads', type: 'line', source: 'osm', 'source-layer': 'roads', paint: {'line-color': '#a4acaa', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, .6, 14, 2.5]}},
    ]}, attributionControl: false,
});
map.addControl(new maplibregl.NavigationControl(), 'top-left');
map.addControl(new maplibregl.AttributionControl({compact: false}), 'bottom-left');
map.on('error', event => { $('map-state').textContent = `Геооснова недоступна: ${event.error?.message || 'ошибка плиток'}`; });

let vehicles = [];
let selected = null;
let state = null;
let receivedAt = performance.now();
const locationOk = v => v.location_valid === true && Number.isFinite(Number(v.lon)) && Number.isFinite(Number(v.lat)) && v.lon != null && v.lat != null && Math.abs(Number(v.lat)) <= 90 && Math.abs(Number(v.lon)) <= 180;
const risk = (v, offline) => {
  if (offline || v.status !== 'normal' || v.prediction_s == null) return '#82909b';
  if (Number(v.prediction_s) >= 300) return '#c84b39';
  if (Number(v.prediction_s) >= 120) return '#e89c36';
  return '#26876a';
};

// The only transport renderer. Its camera is the MapLibre custom layer projection;
// the DOM cards and hit test use map.project with the same map camera.
const layer = {
  id: 'transport-three', type: 'custom', renderingMode: '3d',
  onAdd(map, gl) {
    this.map = map;
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.renderer = new THREE.WebGLRenderer({canvas: map.getCanvas(), context: gl, antialias: true});
    this.renderer.autoClear = false;
    this.geometry = new THREE.SphereGeometry(1, 12, 8);
    this.meshes = [];
  },
  update(rows, offline) {
    if (!this.scene) return;
    for (const mesh of this.meshes) {this.scene.remove(mesh); mesh.material.dispose();}
    this.meshes = [];
    for (const v of rows.filter(locationOk)) {
      const coord = maplibregl.MercatorCoordinate.fromLngLat([Number(v.lon), Number(v.lat)], 0);
      const worldSize = 512 * 2 ** map.getZoom();
      const scale = coord.meterInMercatorCoordinateUnits() * worldSize;
      const mesh = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({color: risk(v, offline), depthTest: false}));
      mesh.position.set(coord.x * worldSize, coord.y * worldSize, coord.z * worldSize + scale * 16);
      mesh.scale.setScalar(scale * (String(v.tr_id) === selected ? 115 : 80));
      this.scene.add(mesh);
      this.meshes.push(mesh);
    }
    this.map.triggerRepaint();
  },
  render(gl, options) {
    this.camera.projectionMatrix.fromArray(options.modelViewProjectionMatrix);
    this.renderer.resetState();
    this.renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.renderer.render(this.scene, this.camera);
  },
  onRemove() {this.geometry.dispose(); for (const mesh of this.meshes) mesh.material.dispose(); this.renderer.dispose();},
};
map.on('load', () => {map.addLayer(layer); layer.update(vehicles, state?.status !== 'online');});
map.on('zoom', () => layer.update(vehicles, state?.status !== 'online'));
map.on('click', event => {
  const hit = vehicles.filter(locationOk).map(v => ({v, point: map.project([Number(v.lon), Number(v.lat)])}))
    .filter(({point}) => Math.hypot(point.x - event.point.x, point.y - event.point.y) < 18)
    .sort((a, b) => Math.hypot(a.point.x - event.point.x, a.point.y - event.point.y) - Math.hypot(b.point.x - event.point.x, b.point.y - event.point.y))[0];
  if (hit) choose(hit.v.tr_id);
});
function choose(id) {
  selected = String(id);
  layer.update(vehicles, state?.status !== 'online');
  renderCard();
  renderList();
}
function renderCard() {
  const v = vehicles.find(row => String(row.tr_id) === selected);
  if (!v) { $('card').textContent = 'Выберите автобус на карте или в списке.'; return; }
  const offline = state?.status !== 'online';
  const stale = offline || v.status !== 'normal';
  const fields = [
    ['Автобус / устройство', `${text(v.tr_id)} / ${text(v.unit_id)}`],
    ['Целевая остановка (не маршрут)', `${text(v.target_stop_id)} · ${text(v.target_time_begin)}`],
    ['Прогноз задержки', v.prediction_s == null ? 'Недостаточно данных для прогноза' : `${minutes(v.prediction_s)}${stale ? ' · последний известный, устарел' : ''}`],
    ['Наблюдаемое отклонение', minutes(v.cur_dev_s)],
    ['Причина задержки', 'неизвестна'],
    ['Состояние / пояснение', `${offline ? 'источник недоступен · ' : ''}${text(v.status)} · ${text(v.reason)}`],
    ['Последний успешный прогноз', text(v.last_success_at)],
    ['Возраст прогноза', v.prediction_age_s == null ? 'неизвестно' : `${Number(v.prediction_age_s).toFixed(1)} с`],
    ['GPS / возраст', `${locationOk(v) ? 'валиден' : 'последняя позиция недостоверна'} · ${v.gps_age_s == null ? 'возраст неизвестен' : `${Number(v.gps_age_s).toFixed(1)} с`}`],
    ['Событие / приём', `${text(v.event_time)} / ${text(v.receive_time)}`],
  ];
  const dl = document.createElement('dl');
  for (const [label, value] of fields) {
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value;
    dl.append(dt, dd);
  }
  $('card').replaceChildren(dl);
  $('card').dataset.status = stale ? 'unknown' : 'normal';
}
function renderList() {
  const list = $('vehicles'); list.replaceChildren();
  for (const v of [...vehicles].sort((a, b) => Number(b.prediction_s ?? -Infinity) - Number(a.prediction_s ?? -Infinity))) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'vehicle'; button.style.borderLeftColor = risk(v, state?.status !== 'online');
    if (String(v.tr_id) === selected) button.setAttribute('aria-current', 'true');
    button.textContent = `${text(v.tr_id)} · ${v.status === 'normal' && state?.status === 'online' && v.prediction_s != null ? minutes(v.prediction_s) : 'прогноз неизвестен'}${locationOk(v) ? '' : ' · GPS недостоверен'}`;
    button.addEventListener('click', () => {choose(v.tr_id); if (locationOk(v)) map.easeTo({center: [Number(v.lon), Number(v.lat)], zoom: Math.max(12, map.getZoom())});});
    list.append(button);
  }
  if (!vehicles.length) list.textContent = 'Нет машин в снимке.';
}
function render() {
  const snap = state?.snapshot;
  vehicles = Array.isArray(snap?.vehicles) ? snap.vehicles : [];
  $('connection').textContent = state?.status === 'online' ? 'Backend online' : `Источник недоступен · ${text(state?.reason)}`;
  $('connection').dataset.status = state?.status === 'online' ? 'online' : 'offline';
  $('revision').textContent = text(snap?.revision);
  $('scenario').textContent = snap?.scenario_label || (snap?.source_clock === 'simulation' ? 'синтетический сценарий на исторической модели' : `Часы: ${text(snap?.source_clock)}`);
  $('clock-time').textContent = text(snap?.clock_time);
  $('fetched-at').textContent = text(state?.fetched_at);
  if (!vehicles.some(v => String(v.tr_id) === selected)) selected = null;
  renderList(); renderCard(); layer.update(vehicles, state?.status !== 'online'); updateAge();
}
function updateAge() {
  const age = state?.age_s;
  $('snapshot-age').textContent = age == null ? 'неизвестно' : `${Math.max(0, Number(age) + (performance.now() - receivedAt) / 1000).toFixed(1)} с`;
}
let busy = false;
async function poll() {
  if (busy) return;
  busy = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch('/api/snapshot', {cache: 'no-store', signal: controller.signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!['online', 'offline'].includes(payload?.status)) throw new Error('Неверный формат snapshot');
    state = payload;
    receivedAt = performance.now();
  } catch (error) {
    state = {...(state || {snapshot: null, age_s: null}), status: 'offline', reason: String(error)};
  } finally {
    clearTimeout(timeout); busy = false; render();
  }
}
fetch('/map/manifest.json').then(r => {if (!r.ok) throw Error(`HTTP ${r.status}`); return r.json();})
  .then(manifest => { $('map-state').textContent = `OSM © contributors · extract ${manifest.date} · ${manifest.coverage}`; })
  .catch(() => { $('map-state').textContent = 'Геооснова Москвы отсутствует: установите локальный OSM extract; карта не подтверждена.'; });
poll(); setInterval(poll, 1500); setInterval(updateAge, 250);
