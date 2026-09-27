// Dispatcher classification of vehicle rows (which row is a warning, which has no usable
// prediction, which rows a filter/search shows) and the local incident store (events, their
// lifecycle and the dispatcher's actions). The warning threshold matches the Backend alert rule
// (transport_backend/orchestration.py alerts only above 120 s).

export const WARNING_S = 120;
export const SEVERE_S = 300;
export const FILTERS = ['all', 'warning', 'nodata'];
export const UNMAPPED = 'unmapped';

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

// A route key always includes the direction; a row without both is «без привязки» (null).
export function routeKeyOf(vehicle) {
  const route = vehicle?.route_id, direction = vehicle?.direction_id;
  return route != null && route !== '' && direction != null && direction !== '' ? `${route}:${direction}` : null;
}

export function matchesFilter(assessment, filter) {
  if (filter === 'warning') return isWarning(assessment);
  if (filter === 'nodata') return assessment.level === 'nodata';
  return true;
}

// `route` is 'all', UNMAPPED or one route key.
export const matchesRoute = (vehicle, route) => route === 'all' || (routeKeyOf(vehicle) ?? UNMAPPED) === route;

export function countByFilter(rows, fresh) {
  const counts = {all: 0, warning: 0, nodata: 0};
  for (const vehicle of rows) {
    const assessment = assess(vehicle, fresh);
    for (const filter of FILTERS) if (matchesFilter(assessment, filter)) counts[filter] += 1;
  }
  return counts;
}

// Route keys present in `rows` with their object counts, unmapped last.
export function countByRoute(rows) {
  const counts = new Map();
  for (const vehicle of rows) {
    const key = routeKeyOf(vehicle) ?? UNMAPPED;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => (a === UNMAPPED) - (b === UNMAPPED) || a.localeCompare(b));
}

// IDs that are a warning in `rows` but were not one in `previousRows` (both current data).
export function newWarningIds(previousRows, rows) {
  const before = new Set(previousRows.filter(v => isWarning(assess(v, true))).map(v => String(v.tr_id)));
  return new Set(rows.filter(v => isWarning(assess(v, true)) && !before.has(String(v.tr_id))).map(v => String(v.tr_id)));
}

// Rows for the list and map, most urgent first; search matches the displayed ID only.
export function visibleRows(rows, {filter = 'all', route = 'all', query = '', fresh}) {
  const needle = query.trim().toLowerCase();
  return rows
    .map(vehicle => ({vehicle, assessment: assess(vehicle, fresh)}))
    .filter(({vehicle, assessment}) => matchesFilter(assessment, filter) && matchesRoute(vehicle, route)
      && (!needle || String(vehicle.tr_id ?? '').toLowerCase().includes(needle)))
    .sort((a, b) => RANK[a.assessment.level] - RANK[b.assessment.level]
      || (finite(b.vehicle.prediction_s) ? Number(b.vehicle.prediction_s) : -Infinity)
        - (finite(a.vehicle.prediction_s) ? Number(a.vehicle.prediction_s) : -Infinity)
      || String(a.vehicle.tr_id).localeCompare(String(b.vehicle.tr_id)));
}

// ---- Incidents -----------------------------------------------------------------------------
// An incident is one episode of warnings for one group: (source mode, route key with direction).
// Objects of one direction share an episode; the opposite direction is a separate group; an
// object without a route mapping is its own group. Lifecycle: `active` while a member is a
// current warning; `monitoring_lost` when no member is a current warning but a member has no
// current data (offline source, degraded row, row gone) — this is never a resolution;
// `resolved` only when every member is current and ≤ 120 s. A new warning after `resolved`
// opens a new episode with a new ID. Repeating the same snapshot changes nothing.
//
// The store is local to one browser page and one run (demo) or mode visit (live); the caller
// creates a new store on reset or mode change, so no action history carries over.

export const NOTE_MAX = 280;

export function createIncidentStore(source) {
  return {source, observed: 0, sequence: 0, perGroup: {}, incidents: []};
}

export const groupKey = (source, vehicle) => `${source}|${routeKeyOf(vehicle) ?? `${UNMAPPED}:${vehicle.tr_id}`}`;

const log = (incident, at, kind, text) => { incident.history.push({at, kind, text}); };
const minutesText = seconds => `${(seconds / 60).toFixed(1)} мин`;
const openFor = (store, key) => store.incidents.find(i => i.key === key && i.state !== 'resolved');

function openIncident(store, key, vehicle, clock) {
  store.sequence += 1;
  store.perGroup[key] = (store.perGroup[key] ?? 0) + 1;
  const incident = {
    id: `${key}#${store.perGroup[key]}`,
    number: store.sequence,
    key,
    source: store.source,
    route_key: routeKeyOf(vehicle),
    route_label: routeKeyOf(vehicle) ? vehicle.route_label ?? routeKeyOf(vehicle) : null,
    state: 'active',
    workflow: 'new',
    unread: true,
    opened_at: clock,
    updated_at: clock,
    resolved_at: null,
    peak_s: 0,
    members: [],
    notes: [],
    history: [],
  };
  store.incidents.push(incident);
  return incident;
}

// Feed one snapshot into the store. Returns the IDs of episodes opened by this snapshot.
export function observeSnapshot(store, rows, {fresh, clock = null}) {
  const opened = [];
  const byId = new Map(rows.map(v => [String(v.tr_id), v]));
  const warnings = new Map();
  for (const vehicle of rows) {
    if (!isWarning(assess(vehicle, fresh))) continue;
    const key = groupKey(store.source, vehicle);
    if (!warnings.has(key)) warnings.set(key, []);
    warnings.get(key).push(vehicle);
  }
  for (const [key, list] of warnings) {
    let incident = openFor(store, key);
    const created = !incident;
    if (created) {
      incident = openIncident(store, key, list[0], clock);
      opened.push(incident.id);
    } else if (incident.state === 'monitoring_lost') {
      incident.state = 'active';
      incident.unread = true;
      log(incident, clock, 'lifecycle', 'Данные вернулись, задержка сохраняется');
    }
    for (const vehicle of list) {
      const id = String(vehicle.tr_id);
      if (!incident.members.some(m => m.tr_id === id)) {
        incident.members.push({tr_id: id, state: 'warning', last_s: null, peak_s: 0});
        if (!created) {
          incident.unread = true;
          log(incident, clock, 'lifecycle', `Добавлен ${id}: прогноз ${minutesText(Number(vehicle.prediction_s))}`);
        }
      }
    }
    if (created) {
      const who = list.map(v => `${v.tr_id} ${minutesText(Number(v.prediction_s))}`).join(', ');
      log(incident, clock, 'lifecycle', `Событие открыто: ${who}`);
    }
  }
  for (const incident of store.incidents) {
    if (incident.state === 'resolved') continue;
    const lost = [];
    for (const member of incident.members) {
      const vehicle = byId.get(member.tr_id);
      const assessment = vehicle ? assess(vehicle, fresh) : {level: 'nodata'};
      if (assessment.level === 'nodata') { member.state = 'nodata'; lost.push(member.tr_id); continue; }
      member.state = isWarning(assessment) ? 'warning' : 'normal';
      member.last_s = Number(vehicle.prediction_s);
      member.peak_s = Math.max(member.peak_s, member.last_s);
      incident.peak_s = Math.max(incident.peak_s, member.last_s);
    }
    incident.updated_at = warnings.has(incident.key) ? clock : incident.updated_at;
    if (warnings.has(incident.key)) continue;
    if (lost.length) {
      if (incident.state !== 'monitoring_lost') {
        incident.state = 'monitoring_lost';
        incident.updated_at = clock;
        log(incident, clock, 'lifecycle', `Мониторинг потерян: нет актуальных данных по ${lost.join(', ')} — событие не закрыто`);
      }
    } else {
      incident.state = 'resolved';
      incident.resolved_at = clock;
      incident.updated_at = clock;
      log(incident, clock, 'lifecycle', `Задержка закончилась: прогноз ≤ 2 мин у ${incident.members.map(m => m.tr_id).join(', ')}`);
    }
  }
  store.observed += 1;
  return opened;
}

export const findIncident = (store, id) => store.incidents.find(i => i.id === id) ?? null;

// The episode shown for an object: its open one, else its latest resolved one.
export function incidentForVehicle(store, trId) {
  const mine = store.incidents.filter(i => i.members.some(m => m.tr_id === String(trId)));
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

// «Вернуть в новые»: undo the dispatcher mark.
export function reopen(store, id, clock) {
  const incident = findIncident(store, id);
  if (!incident || incident.state === 'resolved' || incident.workflow !== 'in_work') return false;
  incident.workflow = 'new';
  log(incident, clock, 'action', 'Возвращено в новые');
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
