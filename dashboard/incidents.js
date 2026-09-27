import {delayText} from './route-context.js';

// Dispatcher classification of vehicle rows (which row is a warning, which has no usable
// prediction, which rows a filter/search shows) and the local incident store (events, their
// lifecycle and the dispatcher's actions). The warning threshold matches the Backend alert rule
// (transport_backend/orchestration.py alerts only above 120 s).

export const WARNING_S = 120;
export const SEVERE_S = 300;
export const FILTERS = ['all', 'warning', 'nodata'];

const RANK = {severe: 0, warning: 1, normal: 2, nodata: 3};

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

// `fresh` is false when the source is offline: a last-known prediction is never a current warning.
export function assess(vehicle, fresh) {
  const hasPrediction = finite(vehicle?.prediction_s);
  if (!fresh || vehicle.status !== 'normal' || !hasPrediction) return {level: 'nodata', hasPrediction};
  const seconds = Number(vehicle.prediction_s);
  return {level: seconds >= SEVERE_S ? 'severe' : seconds > WARNING_S ? 'warning' : 'normal', hasPrediction};
}

export const isWarning = assessment => assessment.level === 'severe' || assessment.level === 'warning';

export function matchesFilter(assessment, filter) {
  if (filter === 'warning') return isWarning(assessment);
  if (filter === 'nodata') return assessment.level === 'nodata';
  return true;
}

export function countByFilter(rows, fresh) {
  const counts = {all: 0, warning: 0, nodata: 0};
  for (const vehicle of rows) {
    const assessment = assess(vehicle, fresh);
    for (const filter of FILTERS) if (matchesFilter(assessment, filter)) counts[filter] += 1;
  }
  return counts;
}

// Rows for the list and map, most urgent first; search matches the displayed ID only.
export function visibleRows(rows, {filter = 'all', query = '', fresh}) {
  const needle = query.trim().toLowerCase();
  return rows
    .map(vehicle => ({vehicle, assessment: assess(vehicle, fresh)}))
    .filter(({vehicle, assessment}) => matchesFilter(assessment, filter)
      && (!needle || String(vehicle.tr_id ?? '').toLowerCase().includes(needle)))
    .sort((a, b) => RANK[a.assessment.level] - RANK[b.assessment.level]
      || (finite(b.vehicle.prediction_s) ? Number(b.vehicle.prediction_s) : -Infinity)
        - (finite(a.vehicle.prediction_s) ? Number(a.vehicle.prediction_s) : -Infinity)
      || String(a.vehicle.tr_id).localeCompare(String(b.vehicle.tr_id)));
}

// ---- Incidents -----------------------------------------------------------------------------
// An incident is one episode of warnings of one vehicle (tr_id): the live stream carries no route
// or direction to group by. Lifecycle: `active` while the vehicle is a current warning;
// `monitoring_lost` when it is not a current warning and has had no current data (offline source,
// degraded row, row gone) for at least LOST_AFTER_S seconds of wall time — this is never a
// resolution; `resolved` only when it is current and ≤ 120 s. A shorter gap (a new target's
// prediction being computed, one missed poll) changes nothing: no state change, no history line,
// no unread mark. A new warning after `resolved` opens a new episode with a new ID. Repeating the
// same snapshot changes nothing.
//
// The store is local to one browser page and one emulator run; the caller creates a new store
// when the run ID changes, so no action history carries over.

export const NOTE_MAX = 280;
// Wall seconds a vehicle may have no current data before its episode becomes `monitoring_lost`.
// About one target change of the live stream at ×5 (a new target every ~12 s of wall time).
export const LOST_AFTER_S = 15;

export function createIncidentStore(source) {
  return {source, observed: 0, sequence: 0, perVehicle: {}, incidents: []};
}

const log = (incident, at, kind, text) => { incident.history.push({at, kind, text}); };

const openFor = (store, trId) => store.incidents.find(i => i.tr_id === trId && i.state !== 'resolved');

function openIncident(store, vehicle, clock) {
  const trId = String(vehicle.tr_id);
  store.sequence += 1;
  store.perVehicle[trId] = (store.perVehicle[trId] ?? 0) + 1;
  const incident = {
    id: `${store.source}|${trId}#${store.perVehicle[trId]}`,
    number: store.sequence,
    tr_id: trId,
    state: 'active',
    vehicle_state: 'warning', // warning | normal | nodata — the vehicle as last seen
    workflow: 'new',
    unread: true,
    opened_at: clock,
    updated_at: clock,
    resolved_at: null,
    last_s: Number(vehicle.prediction_s),
    peak_s: Number(vehicle.prediction_s),
    nodata_since: null,
    notes: [],
    history: [],
  };
  log(incident, clock, 'lifecycle', `Событие открыто: ${trId} ${delayText(incident.last_s)}`);
  store.incidents.push(incident);
  return incident;
}

// Feed one snapshot into the store. Returns the IDs of episodes opened by this snapshot.
// `wallS` is the browser's monotonic time in seconds (performance.now() / 1000); `clock` is the
// source time written into the history.
export function observeSnapshot(store, rows, {fresh, clock = null, wallS}) {
  if (!Number.isFinite(wallS)) throw new TypeError('observeSnapshot needs wallS (monotonic seconds)');
  const opened = [];
  const byId = new Map(rows.map(v => [String(v.tr_id), v]));
  for (const vehicle of rows) {
    if (!isWarning(assess(vehicle, fresh))) continue;
    const incident = openFor(store, String(vehicle.tr_id));
    if (!incident) opened.push(openIncident(store, vehicle, clock).id);
    else if (incident.state === 'monitoring_lost') {
      incident.state = 'active';
      incident.unread = true;
      log(incident, clock, 'lifecycle', 'Данные вернулись, задержка сохраняется');
    }
  }
  for (const incident of store.incidents) {
    if (incident.state === 'resolved') continue;
    const vehicle = byId.get(incident.tr_id);
    const assessment = vehicle ? assess(vehicle, fresh) : {level: 'nodata'};
    if (assessment.level === 'nodata') {
      incident.vehicle_state = 'nodata';
      incident.nodata_since ??= wallS;
      // A short gap is neither a loss nor a resolution: the episode stays as it was.
      if (wallS - incident.nodata_since >= LOST_AFTER_S && incident.state !== 'monitoring_lost') {
        incident.state = 'monitoring_lost';
        incident.updated_at = clock;
        log(incident, clock, 'lifecycle', `Мониторинг потерян: нет актуальных данных по ${incident.tr_id} — событие не закрыто`);
      }
      continue;
    }
    incident.nodata_since = null;
    incident.last_s = Number(vehicle.prediction_s);
    incident.peak_s = Math.max(incident.peak_s, incident.last_s);
    if (isWarning(assessment)) {
      incident.vehicle_state = 'warning';
      incident.updated_at = clock;
      continue;
    }
    incident.vehicle_state = 'normal';
    incident.state = 'resolved';
    incident.resolved_at = clock;
    incident.updated_at = clock;
    log(incident, clock, 'lifecycle', `Задержка закончилась: прогноз ≤ 2 мин у ${incident.tr_id}`);
  }
  store.observed += 1;
  return opened;
}

export const findIncident = (store, id) => store.incidents.find(i => i.id === id) ?? null;

// The episode shown for a vehicle: its open one, else its latest resolved one.
export function incidentForVehicle(store, trId) {
  const mine = store.incidents.filter(i => i.tr_id === String(trId));
  return mine.find(i => i.state !== 'resolved') ?? mine.at(-1) ?? null;
}

// Open episodes first (most recent first), then ended ones.
export const orderedIncidents = store => [...store.incidents]
  .sort((a, b) => (a.state === 'resolved') - (b.state === 'resolved') || b.number - a.number);

export function incidentCounts(store) {
  const counts = {active: 0, monitoring_lost: 0, resolved: 0, unread: 0};
  for (const incident of store.incidents) {
    counts[incident.state] += 1;
    if (incident.unread) counts.unread += 1;
  }
  return counts;
}

export function markRead(store, id) {
  const incident = findIncident(store, id);
  if (incident) incident.unread = false;
  return incident;
}

// «Взять в работу»: a dispatcher mark, not a claim that the delay ended.
export function acknowledge(store, id, clock) {
  const incident = findIncident(store, id);
  if (!incident || incident.state === 'resolved' || incident.workflow === 'in_work') return false;
  incident.workflow = 'in_work';
  incident.unread = false;
  log(incident, clock, 'action', 'Взято в работу');
  return true;
}

// «Снять с работы»: undo the dispatcher mark.
export function reopen(store, id, clock) {
  const incident = findIncident(store, id);
  if (!incident || incident.state === 'resolved' || incident.workflow !== 'in_work') return false;
  incident.workflow = 'new';
  log(incident, clock, 'action', 'Снято с работы');
  return true;
}

// Notes are plain text: control characters dropped, whitespace collapsed, length capped.
// Rendering must use textContent; the store never produces markup.
export function normalizeNote(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
}

export function addNote(store, id, value, clock) {
  const incident = findIncident(store, id);
  const note = normalizeNote(value);
  if (!incident || !note) return false;
  incident.notes.push({at: clock, text: note});
  log(incident, clock, 'note', note);
  return true;
}
