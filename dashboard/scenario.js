// Explicit demo source for the dispatcher screen. Every value below is authored by hand:
// positions, delays, targets, ages and the route scheme are scenario inputs, not telemetry,
// model output or real route geometry. The row shape mirrors Backend `/v1/vehicles` (plus
// route/direction fields the live source does not send) so the UI renders both sources alike.
//
// One versioned scenario: the same 8 objects pass through 5 fixed phases. A run
// (`scenario_run_id`) is one pass through these phases; Start/Pause/Next/Reset only move a
// run, they never change the authored values. Change any value → bump SCENARIO_VERSION.

export const SCENARIO_ID = 'moscow-center-demo';
export const SCENARIO_VERSION = 'd03.v1';

// ---- Route catalog -------------------------------------------------------------------------
// One demo line with two directions. Each direction has its own ordered scenario points; the
// line drawn through them is a sequence scheme, not a road trace, and «Демо-линия» is not an
// official route number. Points sit in the centre of Moscow, inside the PMTiles bbox
// 37.25,55.50–38.00,56.00.
export const DEMO_ROUTE_ID = 'demo-line';
const STOP_POINTS = {
  'А1': [37.5790, 55.7712], 'А2': [37.5955, 55.7688], 'А3': [37.6120, 55.7658],
  'А4': [37.6290, 55.7622], 'А5': [37.6460, 55.7578], 'А6': [37.6625, 55.7528],
  'Б1': [37.6625, 55.7514], 'Б2': [37.6460, 55.7564], 'Б3': [37.6290, 55.7608],
  'Б4': [37.6120, 55.7644], 'Б5': [37.5955, 55.7674], 'Б6': [37.5790, 55.7698],
};
const DIRECTION_STOPS = {a: ['А1', 'А2', 'А3', 'А4', 'А5', 'А6'], b: ['Б1', 'Б2', 'Б3', 'Б4', 'Б5', 'Б6']};
const DIRECTION_LABEL = {a: 'направление А', b: 'направление Б'};

// The shared route/stop catalog: the only source of route keys and target coordinates in demo mode.
export const ROUTE_CATALOG = {
  routes: {[DEMO_ROUTE_ID]: {label: 'Демо-линия'}},
  directions: Object.keys(DIRECTION_STOPS).map(direction_id => ({
    route_key: `${DEMO_ROUTE_ID}:${direction_id}`,
    route_id: DEMO_ROUTE_ID,
    direction_id,
    label: `Демо-линия · ${DIRECTION_LABEL[direction_id]}`,
    short: DIRECTION_LABEL[direction_id].split(' ').pop(),
    stops: DIRECTION_STOPS[direction_id].map(id => ({id, lon: STOP_POINTS[id][0], lat: STOP_POINTS[id][1]})),
  })),
};
export const catalogStop = id => {
  const point = STOP_POINTS[id];
  return point ? {id, lon: point[0], lat: point[1], label: `Точка сценария ${id}`} : null;
};

// ---- Objects ---------------------------------------------------------------------------------
// `dir`/`seg`: the object runs between stops[seg] and stops[seg + 1] of its direction and its
// target is stops[seg + 1]; `t` is its authored share of that segment in each phase.
// `planned` = planned HH:MM at the target. Д-108 has no route mapping and no valid GPS.
const VEHICLES = [
  {tr_id: 'Д-101', dir: 'a', seg: 0, t: [0.35, 0.45, 0.55, 0.65, 0.75], planned: '12:46'},
  {tr_id: 'Д-102', dir: 'b', seg: 2, t: [0.25, 0.30, 0.35, 0.42, 0.55], planned: '12:47'},
  {tr_id: 'Д-103', dir: 'a', seg: 1, t: [0.30, 0.36, 0.42, 0.42, 0.70], planned: '12:45'},
  {tr_id: 'Д-104', dir: 'b', seg: 0, t: [0.20, 0.28, 0.36, 0.46, 0.62], planned: '12:48'},
  {tr_id: 'Д-105', dir: 'b', seg: 4, t: [0.30, 0.40, 0.50, 0.60, 0.70], planned: '12:44'},
  {tr_id: 'Д-106', dir: 'a', seg: 3, t: [0.20, 0.30, 0.40, 0.50, 0.60], noTarget: true, status: 'unavailable', reason: 'no_target_in_horizon'},
  {tr_id: 'Д-107', dir: 'a', seg: 4, t: [0.20, 0.30, 0.40, 0.50, 0.60], planned: '12:49'},
  {tr_id: 'Д-108', location_valid: false, status: 'degraded', reason: 'invalid_gps'},
];

// Per phase, only what differs from VEHICLES. `p` = prediction_s, `dev` = cur_dev_s.
// Covered states: no prediction (Д-106 always), updating (Д-104 in phase 2), a new warning on
// direction Б (Д-104 and Д-102 in phase 3, grouped as one event, while Д-103 keeps the older
// event on direction А), data unavailable (Д-108 always, Д-103 in phase 4 → its event loses
// monitoring), and return to normal (phase 5 → both events end).
export const PHASES = [
  {id: 'overview', title: 'Обзор', clock: '12:40:00',
    description: 'Одна задержка уже есть: Д-103 на направлении А выше 2 минут. Остальные — в норме или без прогноза.',
    rows: {
      'Д-101': {p: 45, dev: 30}, 'Д-102': {p: 70, dev: 40}, 'Д-103': {p: 170, dev: 110}, 'Д-104': {p: 60, dev: 30},
      'Д-105': {p: 20, dev: 0}, 'Д-107': {p: 95, dev: 60},
    }},
  {id: 'updating', title: 'Прогноз обновляется', clock: '12:41:00',
    description: 'Д-104 на направлении Б отстаёт сильнее; новый прогноз для него ещё рассчитывается.',
    rows: {
      'Д-101': {p: 50, dev: 35}, 'Д-102': {p: 95, dev: 60}, 'Д-103': {p: 150, dev: 105},
      'Д-104': {p: null, dev: 95, status: 'unavailable', reason: 'prediction_pending'},
      'Д-105': {p: 25, dev: 5}, 'Д-107': {p: 90, dev: 55},
    }},
  {id: 'new-warning', title: 'Новое предупреждение', clock: '12:42:00',
    description: 'Направление Б: Д-104 — 6.5 мин у цели Б2, Д-102 — 3.2 мин. Это одно новое событие; Д-103 остаётся в событии направления А.',
    rows: {
      'Д-101': {p: 40, dev: 30}, 'Д-102': {p: 190, dev: 120}, 'Д-103': {p: 140, dev: 100},
      'Д-104': {p: 390, dev: 200},
      'Д-105': {p: 20, dev: 5}, 'Д-107': {p: 90, dev: 55},
    }},
  {id: 'data-loss', title: 'Данные недоступны', clock: '12:43:00',
    description: 'Д-103 отключился: показан последний известный прогноз, он устарел. Событие направления А не закрыто — мониторинг потерян.',
    rows: {
      'Д-101': {p: 35, dev: 25}, 'Д-102': {p: 150, dev: 110},
      'Д-103': {p: 140, dev: 100, status: 'degraded', reason: 'disconnected', age: 70},
      'Д-104': {p: 420, dev: 230},
      'Д-105': {p: 15, dev: 0}, 'Д-107': {p: 60, dev: 40},
    }},
  {id: 'recovery', title: 'Возврат в норму', clock: '12:45:00',
    description: 'Д-103 снова на связи, Д-104 и Д-102 нагоняют: все прогнозы ≤ 2 мин. Оба события закончились.',
    rows: {
      'Д-101': {p: 30, dev: 20}, 'Д-102': {p: 80, dev: 60}, 'Д-103': {p: 90, dev: 60},
      'Д-104': {p: 100, dev: 80},
      'Д-105': {p: 10, dev: 0}, 'Д-107': {p: 60, dev: 40},
    }},
];

const SCENARIO_DAY = '2026-09-27';
const round = value => Math.round(value * 1e5) / 1e5;

function row(spec, phaseIndex, index) {
  const change = PHASES[phaseIndex].rows[spec.tr_id] ?? {};
  const direction = spec.dir ? ROUTE_CATALOG.directions.find(d => d.direction_id === spec.dir) : null;
  const located = spec.location_valid !== false;
  let lon = null, lat = null, target = null;
  if (direction) {
    const from = direction.stops[spec.seg], to = direction.stops[spec.seg + 1], t = spec.t[phaseIndex];
    if (located) { lon = round(from.lon + (to.lon - from.lon) * t); lat = round(from.lat + (to.lat - from.lat) * t); }
    if (!spec.noTarget) target = catalogStop(to.id);
  }
  const prediction = change.p ?? null;
  return {
    tr_id: spec.tr_id,
    unit_id: null,
    lon,
    lat,
    location_valid: located,
    gps_age_s: located ? 4 + index : null,
    status: change.status ?? spec.status ?? 'normal',
    reason: change.reason ?? spec.reason ?? null,
    route_id: direction ? direction.route_id : null,
    direction_id: direction ? direction.direction_id : null,
    route_label: direction ? direction.label : null,
    target_stop_id: target ? target.id : null,
    target_label: target ? target.label : null,
    target_lon: target ? target.lon : null,
    target_lat: target ? target.lat : null,
    target_time_begin: target ? `${SCENARIO_DAY}T${spec.planned}:00` : null,
    prediction_s: prediction,
    prediction_age_s: prediction == null ? null : change.age ?? 10 + index,
    prediction_source: 'scenario',
    cur_dev_s: change.dev ?? null,
    model_version: null,
    alert: null,
  };
}

// A fresh copy per call, so a caller can never mutate the authored scenario.
export const phaseRows = index => VEHICLES.map((spec, i) => row(spec, index, i));

// ---- Runs ----------------------------------------------------------------------------------
// A run is plain data. `history` is the run's own local log of shown phases; a new run starts
// with a new ID and an empty log, so nothing from a previous run carries over.
export function createRun(sequence, nonce) {
  return {
    scenario_run_id: `${SCENARIO_ID}.${SCENARIO_VERSION}.r${sequence}-${nonce}`,
    sequence,
    phase: 0,
    started: false,
    playing: false,
    history: [PHASES[0].id],
  };
}

const LAST = PHASES.length - 1;
export const isFinished = run => run.phase === LAST;
export const start = run => ({...run, started: true, playing: !isFinished(run)});
export const pause = run => ({...run, playing: false});
export function next(run) {
  if (isFinished(run)) return pause(run);
  const phase = run.phase + 1;
  return {...run, phase, started: true, playing: run.playing && phase < LAST, history: [...run.history, PHASES[phase].id]};
}

// The snapshot the ordinary UI components render; same envelope as the live source.
export function scenarioSnapshot(run) {
  const phase = PHASES[run.phase];
  return {
    schema_version: 'transport.demo-scenario.v3',
    scenario_id: SCENARIO_ID,
    scenario_version: SCENARIO_VERSION,
    scenario_run_id: run.scenario_run_id,
    phase: {index: run.phase, count: PHASES.length, id: phase.id, title: phase.title, description: phase.description},
    revision: run.history.length,
    source_clock: 'scenario',
    clock_time: `${SCENARIO_DAY}T${phase.clock}`,
    vehicles: phaseRows(run.phase),
  };
}
