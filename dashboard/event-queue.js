import {SEVERE_S, createIncidentStore, normalizeNote, observeSnapshot} from './incidents.js';

// Dispatcher event queue (UI v2 «Диспетчерская карта v2»): the incident episodes of incidents.js
// sorted into reaction groups, with a reaction SLA, snooze, close with a reason, a reaction
// checklist, bulk selection, J/K order, the attention bar and toasts. DOM-free and pure: every
// exported function returns a new state and never mutates its argument, so the state is a plain
// serialisable value that survives polling and a page reload (serialize/deserialize).
//
// Time. Two clocks, on purpose:
// - The reaction SLA is human reaction time, so it runs on WALL seconds (`wallS`, the caller's
//   clock): «на реакцию 1:30» is 90 s on the dispatcher's screen whatever the demo speed-up (×5).
//   Pass `wallS = Date.now() / 1000` (epoch seconds) so the countdown survives a page reload with
//   sessionStorage; performance.now() restarts at 0 after a reload. Selectors take `wallS` (default:
//   the last polled one); pass the current wall time for a smooth per-second countdown.
// - Snooze runs on DATA time — the run clock of the snapshot (`snapshot.clock_time`, naive ISO, or
//   seconds): «отложить 5 мин» is 5 min of the bus's world, shown as the data clock «напомнить в
//   07:04 (время данных)», and it expires on the first poll whose data time reaches it (a paused run
//   pauses it). Every badge says which clock it counts (`badge.clock_text`).
// Actions take `dataNow` (history time, snooze deadline) and optional `wallS` (SLA restart).
//
// Episode lifecycle (active / monitoring_lost / resolved, one episode per vehicle) is owned by
// incidents.js `observeSnapshot`; this module only layers the dispatcher workflow over it.

export const SLA_S = 90; // prototype `slaSeconds` default: reaction deadline, WALL seconds
export const SLA_LOW_S = 30; // below this the SLA badge turns amber (prototype)
export const SNOOZE_MIN = [2, 5, 10, 15]; // data minutes
export const SNOOZE_DEFAULT_MIN = 5; // hotkey S
export const TOASTS_MAX = 3;
export const CLOSE_REASONS = ['Водитель уведомлён — нагонит график', 'Ложное: ошибка GPS или прогноза',
  'Сход с рейса / замена ТС', 'Пробка — повлиять нельзя', 'Другое (см. заметку)'];
// Offered first only for an episode whose delay has already ended.
export const RESOLVED_CLOSE_REASON = 'Задержка закончилась — вмешательство не нужно';
export const GROUPS = ['needs', 'work', 'snoozed', 'ended'];
export const GROUP_TITLES = {needs: 'Требуют реакции', work: 'В работе', snoozed: 'Отложены', ended: 'Завершены'};
// Queue filter chips «Все · Новые · В работе · Отложены»; «Завершены» shows under «Все» only.
export const QUEUE_FILTERS = [{key: 'all', title: 'Все'}, {key: 'needs', title: 'Новые'}, {key: 'work', title: 'В работе'}, {key: 'snoozed', title: 'Отложены'}];
// The clock a badge counts in: the reaction SLA in real (screen) seconds, the snooze in data time.
export const CLOCK_TEXT = {wall: 'реальное время', data: 'время данных'};
// «Шаги реакции». The last step is shown only for a severe episode (peak ≥ 5 min), as in v2.
export const STEPS = [
  {key: 'gps', title: 'Проверить позицию и GPS', hint: 'Позиция и GPS обновляются, ТС на маршруте'},
  {key: 'driver', title: 'Связаться с водителем', hint: 'Причина задержки, может ли нагнать'},
  {key: 'gap', title: 'Проверить интервал с соседними ТС', hint: 'Не догоняет ли следующий рейс'},
  {key: 'lead', title: 'Сообщить старшему смены', hint: 'Задержка ≥ 5 мин', severeOnly: true},
];

const FORMAT = 'event-queue/2';

// ---- Data time ------------------------------------------------------------------------------

const ISO = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(\.\d+)?/;

// Data time in seconds: a number is taken as is; an ISO string is read by its own digits (the
// run clock is naive local time; any zone suffix is ignored), so formatting gives the same digits.
export function dataSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const m = typeof value === 'string' ? ISO.exec(value) : null;
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 + (m[7] ? Number(m[7]) : 0);
}

const pad = n => String(n).padStart(2, '0');
export const hms = seconds => {
  const s = Math.floor(seconds);
  return `${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}:${pad(((s % 60) + 60) % 60)}`;
};
// «07:08»: the data clock to the minute, as the header shows it.
export const hm = seconds => hms(seconds).slice(0, 5);
// «1:30»: minutes without padding, seconds padded; never negative.
export const dur = seconds => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
};
// History `at`: the ISO string as given, else the ISO digits of a numeric data time.
const clockOf = (dataNow, now) => (typeof dataNow === 'string' ? dataNow
  : now === null ? null : new Date(now * 1000).toISOString().slice(0, 19));

// ---- State ----------------------------------------------------------------------------------

// `source` names the run (see incidents.js createIncidentStore); create a new queue per run.
export function createQueue(source, {slaS = SLA_S} = {}) {
  return {format: FORMAT, sla_s: slaS, now_s: null, wall_s: null, store: createIncidentStore(source), events: {}, toasts: [], selection: []};
}

const clone = state => structuredClone(state);
const incidentOf = (state, id) => state.store.incidents.find(i => i.id === id) ?? null;
const overlay = () => ({wf: 'new', sla_from_wall_s: null, snooze_until_s: null, snooze_min: null, close_reason: null, steps: {}, toasted: false});
const isOpen = (incident, ev) => incident.state !== 'resolved' && ev.wf !== 'closed';
const groupOf = (incident, ev) => (!isOpen(incident, ev) ? 'ended' : ev.wf === 'work' ? 'work' : ev.wf === 'snoozed' ? 'snoozed' : 'needs');
const log = (incident, at, text) => { incident.history.push({at, kind: 'action', text}); };
const nowOf = (state, dataNow) => dataSeconds(dataNow) ?? state.now_s;
const wallOf = (state, wallS) => (Number.isFinite(wallS) ? wallS : state.wall_s);

function pushToast(state, toast) {
  state.toasts = [toast, ...state.toasts.filter(t => t.key !== toast.key)].slice(0, TOASTS_MAX);
}
const dropToasts = (state, ids) => { state.toasts = state.toasts.filter(t => !ids.includes(t.id)); };

function enterNeeds(ev, wall) {
  ev.wf = 'new';
  ev.sla_from_wall_s = wall;
  ev.snooze_until_s = null;
  ev.snooze_min = null;
}

// ---- Reducer: one poll ----------------------------------------------------------------------

// Feed one snapshot. `dataNow` is the run clock of the snapshot (ISO or seconds); `wallS` is the
// caller's wall clock (Date.now() / 1000) for the SLA; `fresh` and `wallS` also go to incidents.js
// observeSnapshot (its LOST_AFTER_S gap only needs differences, so epoch seconds work). Repeating
// the same snapshot with the same times changes nothing the dispatcher sees.
export function observe(state, rows, {dataNow, fresh = true, wallS}) {
  const next = clone(state);
  const now = nowOf(next, dataNow);
  const at = clockOf(dataNow, now);
  next.now_s = now;
  const wall = wallOf(next, wallS);
  next.wall_s = wall;
  const before = new Map(next.store.incidents.map(i => [i.id, i.state]));
  const opened = new Set(observeSnapshot(next.store, rows, {fresh, clock: at, wallS}));
  for (const incident of next.store.incidents) {
    let ev = next.events[incident.id];
    if (!ev) {
      ev = next.events[incident.id] = overlay();
      ev.sla_from_wall_s = wall;
    }
    if (opened.has(incident.id) && !ev.toasted) {
      ev.toasted = true;
      pushToast(next, {key: `new|${incident.id}`, kind: 'new', id: incident.id, at_s: now});
    }
    if (incident.state === 'monitoring_lost' && before.get(incident.id) !== 'monitoring_lost' && isOpen(incident, ev)) {
      pushToast(next, {key: `lost|${incident.id}|${now}`, kind: 'lost', id: incident.id, at_s: now});
    }
    if (incident.state === 'resolved') {
      if (before.get(incident.id) !== undefined && before.get(incident.id) !== 'resolved') {
        incident.unread = true; // the delay ended: tell the dispatcher once
        dropToasts(next, [incident.id]);
      }
      continue;
    }
    if (ev.wf === 'snoozed' && now !== null && ev.snooze_until_s !== null && now >= ev.snooze_until_s) {
      const until = ev.snooze_until_s;
      enterNeeds(ev, wall);
      incident.unread = true;
      log(incident, at, 'Напоминание: событие вернулось в новые');
      pushToast(next, {key: `remind|${incident.id}|${until}`, kind: 'remind', id: incident.id, at_s: now});
    }
  }
  const open = new Set(next.store.incidents.filter(i => isOpen(i, next.events[i.id])).map(i => i.id));
  next.selection = next.selection.filter(id => open.has(id));
  return next;
}

// ---- Actions --------------------------------------------------------------------------------

// Apply `fn(incident, ev)` to every id; `fn` returns true when it changed the event. Acted ids
// leave the selection and lose their toasts (v2 behaviour).
function act(state, ids, dataNow, fn, wallS) {
  const next = clone(state);
  const now = nowOf(next, dataNow);
  const wall = wallOf(next, wallS);
  const at = clockOf(dataNow, now);
  const done = [];
  for (const id of [ids].flat()) {
    const incident = incidentOf(next, id);
    const ev = next.events[id];
    if (incident && ev && fn(incident, ev, at, now, wall)) done.push(id);
  }
  if (!done.length) return state;
  dropToasts(next, done);
  next.selection = next.selection.filter(id => !done.includes(id));
  return next;
}

const mirror = (incident, ev) => { incident.workflow = ev.wf === 'work' ? 'in_work' : 'new'; };

// «Взять в работу» (W): from «Требует реакции» or «Отложены».
export const take = (state, ids, dataNow) => act(state, ids, dataNow, (incident, ev, at) => {
  if (!isOpen(incident, ev) || ev.wf === 'work') return false;
  ev.wf = 'work';
  ev.snooze_until_s = null;
  ev.snooze_min = null;
  incident.unread = false;
  mirror(incident, ev);
  log(incident, at, 'Взято в работу');
  return true;
});

// «Вернуть в новые»: the SLA restarts from `wallS` (default: the last polled wall time).
export const untake = (state, ids, dataNow, wallS) => act(state, ids, dataNow, (incident, ev, at, now, wall) => {
  if (!isOpen(incident, ev) || ev.wf !== 'work') return false;
  enterNeeds(ev, wall);
  mirror(incident, ev);
  log(incident, at, 'Возвращено в новые');
  return true;
}, wallS);

// «Отложить» (S = 5 мин): until now + minutes of data time; then back to «Требует реакции».
export const snooze = (state, ids, minutes, dataNow) => act(state, ids, dataNow, (incident, ev, at, now) => {
  if (!isOpen(incident, ev) || now === null || !(minutes > 0)) return false;
  ev.wf = 'snoozed';
  ev.snooze_min = minutes;
  ev.snooze_until_s = now + minutes * 60;
  incident.unread = false;
  mirror(incident, ev);
  log(incident, at, `Отложено на ${minutes} мин данных: ${snoozeNote(ev.snooze_until_s)}`);
  return true;
});

// «напомнить в 07:08 (время данных)»: the card line and the history entry of a snooze.
const snoozeNote = until => `напомнить в ${hm(until)} (${CLOCK_TEXT.data})`;

// «Снять напоминание»: a snoozed event goes to «В работе».
export const unsnooze = (state, ids, dataNow) => act(state, ids, dataNow, (incident, ev, at) => {
  if (!isOpen(incident, ev) || ev.wf !== 'snoozed') return false;
  ev.wf = 'work';
  ev.snooze_until_s = null;
  ev.snooze_min = null;
  mirror(incident, ev);
  log(incident, at, 'Напоминание снято, взято в работу');
  return true;
});

// «Закрыть» (C) with a reason: open or already ended episodes. A closed episode whose delay goes on
// stays the vehicle's episode (incidents.js opens a new one only after the delay ends).
export const close = (state, ids, reason, dataNow) => {
  const text = normalizeNote(reason);
  if (!text) return state;
  return act(state, ids, dataNow, (incident, ev, at) => {
    if (ev.wf === 'closed') return false;
    ev.wf = 'closed';
    ev.close_reason = text;
    ev.snooze_until_s = null;
    incident.unread = false;
    mirror(incident, ev);
    log(incident, at, `Закрыто: ${text}`);
    return true;
  });
};

// Toggle one «Шаги реакции» item of an open event.
export const toggleStep = (state, id, key, dataNow) => act(state, id, dataNow, (incident, ev, at) => {
  const step = stepsFor(incident).find(s => s.key === key);
  if (!step || !isOpen(incident, ev)) return false;
  ev.steps[key] = !ev.steps[key];
  log(incident, at, `${ev.steps[key] ? 'Шаг' : 'Шаг отменён'}: ${step.title}`);
  return true;
});

// Free-text note (plain text, see incidents.js normalizeNote); does not touch toasts or selection.
export function addNote(state, id, value, dataNow) {
  const note = normalizeNote(value);
  const next = clone(state);
  const incident = incidentOf(next, id);
  if (!incident || !note) return state;
  const at = clockOf(dataNow, nowOf(next, dataNow));
  incident.notes.push({at, text: note});
  incident.history.push({at, kind: 'note', text: note});
  return next;
}

export function markRead(state, ids) {
  const list = [ids].flat();
  if (!state.store.incidents.some(i => list.includes(i.id) && i.unread)) return state;
  const next = clone(state);
  for (const incident of next.store.incidents) if (list.includes(incident.id)) incident.unread = false;
  return next;
}

// «Прочитать все» in «Завершены».
export const markEndedRead = state => markRead(state, groupIds(state, 'ended'));

export function dismissToast(state, key) {
  return dismissToasts(state, [key]);
}

export function dismissToasts(state, keys) {
  if (!state.toasts.some(t => keys.includes(t.key))) return state;
  return {...clone(state), toasts: state.toasts.filter(t => !keys.includes(t.key)).map(t => ({...t}))};
}

// Opening an event (row, toast, J/K, map, search) reads it and hides its toasts (Q2).
export function markOpened(state, id) {
  const read = markRead(state, id);
  const keys = read.toasts.filter(t => t.id === id).map(t => t.key);
  return keys.length ? dismissToasts(read, keys) : read;
}

// ---- Selection (group actions) -------------------------------------------------------------

// Only open events (needs / work / snoozed) can be selected.
export function toggleSelected(state, id) {
  const incident = incidentOf(state, id);
  const ev = state.events[id];
  if (!incident || !ev || !isOpen(incident, ev)) return state;
  const selection = state.selection.includes(id) ? state.selection.filter(x => x !== id) : [...state.selection, id];
  return {...clone(state), selection};
}

// Select every event of an open group; if all of them are already selected, unselect them.
export function selectGroup(state, group, wallS) {
  if (group === 'ended') return state;
  const ids = groupIds(state, group, wallS);
  const all = ids.length > 0 && ids.every(id => state.selection.includes(id));
  const selection = all ? state.selection.filter(id => !ids.includes(id)) : [...new Set([...state.selection, ...ids])];
  return {...clone(state), selection};
}

export const clearSelection = state => (state.selection.length ? {...clone(state), selection: []} : state);

// ---- Selectors ------------------------------------------------------------------------------

export function stepsFor(incident) {
  return STEPS.filter(s => !s.severeOnly || Number(incident.peak_s) >= SEVERE_S);
}

// SLA of an event in «Требует реакции» on wall seconds; null otherwise. A wall clock that went
// backwards (performance.now() after a reload) counts as no time elapsed, never as extra time.
function slaOf(state, ev, wall) {
  if (ev.wf !== 'new') return null;
  const elapsed = wall === null || ev.sla_from_wall_s === null ? 0 : Math.max(0, wall - ev.sla_from_wall_s);
  const left = state.sla_s - elapsed;
  return {left_s: left, over: left < 0, pct: left < 0 ? 100 : Math.max(0, Math.min(100, (100 * left) / state.sla_s))};
}

// `clock_text` names the clock of a timed badge («реальное время» / «время данных»): shown next to
// the badge in the card and as its tooltip in the queue (Q7).
function badgeOf(incident, ev, sla) {
  const timed = (text, tone, clock) => ({text, tone, clock, clock_text: CLOCK_TEXT[clock]});
  if (ev.wf === 'closed') return {text: 'Закрыто', tone: 'closed', clock: null, clock_text: null};
  if (incident.state === 'resolved') return {text: 'Задержка закончилась', tone: 'ended', clock: null, clock_text: null};
  if (ev.wf === 'work') return {text: 'в работе', tone: 'work', clock: null, clock_text: null};
  if (ev.wf === 'snoozed') return timed(`напомнить в ${hm(ev.snooze_until_s)}`, 'snoozed', 'data');
  if (sla.over) return timed(`просрочено ${dur(-sla.left_s)}`, 'overdue', 'wall');
  return timed(`реакция ${dur(sla.left_s)}`, sla.left_s < SLA_LOW_S ? 'sla_low' : 'sla', 'wall');
}

// Everything the list row, card, attention bar and toast need for one event.
export function eventView(state, id, wallS) {
  const incident = incidentOf(state, id);
  const ev = state.events[id];
  if (!incident || !ev) return null;
  const open = isOpen(incident, ev);
  const sla = open ? slaOf(state, ev, wallOf(state, wallS)) : null;
  const steps = open ? stepsFor(incident).map(s => ({key: s.key, title: s.title, hint: s.hint, done: !!ev.steps[s.key]})) : [];
  return {
    id,
    number: incident.number,
    tr_id: incident.tr_id,
    group: groupOf(incident, ev),
    wf: ev.wf, // new | work | snoozed | closed
    lifecycle: incident.state, // active | monitoring_lost | resolved (incidents.js)
    lost: incident.state === 'monitoring_lost',
    vehicle_state: incident.vehicle_state, // warning | normal | nodata: the vehicle as last seen
    unread: incident.unread,
    selected: state.selection.includes(id),
    badge: badgeOf(incident, ev, sla),
    sla,
    last_s: incident.last_s,
    peak_s: incident.peak_s,
    severe: Number(incident.last_s) >= SEVERE_S,
    opened_at: incident.opened_at,
    resolved_at: incident.resolved_at,
    snooze_until_s: ev.snooze_until_s,
    snooze_until_text: ev.snooze_until_s === null ? null : hm(ev.snooze_until_s),
    snooze_note: ev.snooze_until_s === null ? null : snoozeNote(ev.snooze_until_s),
    close_reason: ev.close_reason,
    steps,
    steps_progress: `${steps.filter(s => s.done).length}/${steps.length}`,
    can: {take: open && ev.wf !== 'work', untake: open && ev.wf === 'work', snooze: open && ev.wf !== 'snoozed',
      unsnooze: open && ev.wf === 'snoozed', close: ev.wf !== 'closed', steps: open},
    close_reasons: incident.state === 'resolved' ? [RESOLVED_CLOSE_REASON, ...CLOSE_REASONS] : CLOSE_REASONS,
    history: incident.history,
    notes: incident.notes,
  };
}

const byNumberDesc = (a, b) => b.number - a.number;
const SORT = {
  // Least SLA left first (overdue at the top), then the larger delay, then the older episode.
  needs: (a, b) => a.sla.left_s - b.sla.left_s || b.last_s - a.last_s || a.number - b.number,
  work: (a, b) => b.last_s - a.last_s || a.number - b.number,
  snoozed: (a, b) => a.snooze_until_s - b.snooze_until_s || a.number - b.number,
  ended: byNumberDesc,
};

// Four groups of event views plus counts for the tab badges and «Завершены (непрочитано N)».
export function groups(state, wallS) {
  const out = {needs: [], work: [], snoozed: [], ended: []};
  for (const incident of state.store.incidents) {
    const view = eventView(state, incident.id, wallS);
    if (view) out[view.group].push(view);
  }
  for (const g of GROUPS) out[g].sort(SORT[g]);
  const counts = {
    needs: out.needs.length, work: out.work.length, snoozed: out.snoozed.length, ended: out.ended.length,
    open: out.needs.length + out.work.length + out.snoozed.length,
    overdue: out.needs.filter(v => v.sla.over).length,
    unread: state.store.incidents.filter(i => i.unread).length,
    ended_unread: out.ended.filter(v => v.unread).length,
    selected: state.selection.length,
  };
  return {...out, counts};
}

export const groupIds = (state, group, wallS) => (groups(state, wallS)[group] ?? []).map(v => v.id);

// J/K order: «Требует реакции» (overdue first, then by SLA left), then «В работе», then «Отложены».
export function navOrder(state, wallS) {
  const g = groups(state, wallS);
  return [...g.needs, ...g.work, ...g.snoozed].map(v => v.id);
}

// J = +1, K = −1, wrapping; from nothing (or an ended event) J goes to the first, K to the last.
export function nextEvent(state, currentId, step, wallS) {
  const order = navOrder(state, wallS);
  if (!order.length) return null;
  const idx = order.indexOf(currentId);
  if (idx < 0) return step < 0 ? order.at(-1) : order[0];
  return order[(idx + (step < 0 ? -1 : 1) + order.length) % order.length];
}

// The vehicle's event for the card: its open one, else its latest.
export function eventForVehicle(state, trId) {
  const mine = state.store.incidents.filter(i => i.tr_id === String(trId));
  const open = mine.find(i => isOpen(i, state.events[i.id] ?? overlay()));
  return (open ?? mine.at(-1))?.id ?? null;
}

// ---- Stable queue (Q6): the open event keeps its row -----------------------------------------

// Where event `id` sits now: its group and index in it. The caller takes it once, when the event is
// opened, and passes it to queueLayout as `pin` while the event stays open.
export function pinFor(state, id, wallS) {
  const g = groups(state, wallS);
  for (const group of GROUPS) {
    const index = g[group].findIndex(v => v.id === id);
    if (index >= 0) return {id, group, index};
  }
  return null;
}

// The queue as displayed. `pin` ({id, group, index} from pinFor) keeps the open event at the place
// it was opened, even after an action moved it to another group: its badge shows the new state and
// `pinned` is true while it is displaced; it regroups when the caller drops the pin (the event is
// no longer open, or J/K opened another). `filter` is a QUEUE_FILTERS key: other groups are
// emptied, and «Завершены» shows under «Все» only. `order` is the J/K order of the displayed open
// rows. Counts stay the real ones.
export function queueLayout(state, wallS, {pin = null, filter = 'all'} = {}) {
  const g = groups(state, wallS);
  const out = {needs: [...g.needs], work: [...g.work], snoozed: [...g.snoozed], ended: [...g.ended]};
  const view = pin && GROUPS.includes(pin.group) ? GROUPS.map(k => out[k].find(v => v.id === pin.id)).find(Boolean) : null;
  if (view) {
    out[view.group] = out[view.group].filter(v => v !== view);
    const list = out[pin.group];
    list.splice(Math.min(Math.max(0, pin.index), list.length), 0, {...view, pinned: view.group !== pin.group});
  }
  if (filter !== 'all') for (const key of GROUPS) if (key !== filter) out[key] = [];
  const order = [...out.needs, ...out.work, ...out.snoozed].map(v => v.id);
  return {...out, counts: g.counts, order};
}

// J (+1) / K (−1) over the displayed queue, wrapping. After an action moved the open event out of
// its pinned group (e.g. «Взять в работу»), J/K go to the next «Требует реакции» event; when there
// is none, to the next row. From nothing J opens the first row, K the last.
export function nextQueueEvent(state, currentId, step, wallS, view = {}) {
  const {order} = queueLayout(state, wallS, view);
  if (!order.length) return null;
  const dir = step < 0 ? -1 : 1;
  const idx = order.indexOf(currentId);
  if (idx < 0) return dir < 0 ? order.at(-1) : order[0];
  const current = eventView(state, currentId, wallS);
  const acted = view.pin?.id === currentId && current?.group !== view.pin.group;
  const needs = acted ? new Set(order.filter(id => id !== currentId && eventView(state, id, wallS).group === 'needs')) : new Set();
  for (let k = 1; k < order.length; k += 1) {
    const id = order[(((idx + dir * k) % order.length) + order.length) % order.length];
    if (!needs.size || needs.has(id)) return id;
  }
  return currentId;
}

// ---- Attention bar (Q1): a summary, never a copy of the queue's actions ---------------------

// «ещё 1 требует реакции», «ещё 2 требуют реакции».
const needVerb = n => (n % 10 === 1 && n % 100 !== 11 ? 'требует' : 'требуют');
const deadlineText = left => (left < 0 ? `просрочено ${dur(-left)}` : `ближайший срок ${dur(left)}`);

// `openId`: the event whose card is open (null when none). Returns {kind, level, title, detail,
// next}: kind «needs» — «Требуют реакции: 2 · ближайший срок 0:37»; «open» — «Открыто: ТС 134040 ·
// ещё 1 требует реакции»; «calm» — «Предупреждений нет · в работе 1 · …». `next` offers
// «Следующее J» (another event needs a reaction). The deadline counts real (screen) seconds.
// Only events whose vehicle is a current warning count: a vehicle that lost its forecast is calm
// here (user decision, T-7 W14); the queue still lists its event.
export function attentionSummary(state, wallS, openId = null) {
  const g = groups(state, wallS);
  const open = openId ? eventView(state, openId, wallS) : null;
  const needs = g.needs.filter(v => v.vehicle_state === 'warning');
  const others = needs.filter(v => v.id !== openId);
  const level = others.some(v => v.sla.over || v.severe) ? 'severe' : others.length ? 'warning' : 'normal';
  if (open) {
    return {kind: 'open', level, title: `Открыто: ТС ${open.tr_id}`,
      detail: others.length ? `ещё ${others.length} ${needVerb(others.length)} реакции` : 'других событий, требующих реакции, нет',
      next: others.length > 0};
  }
  if (needs.length) {
    return {kind: 'needs', level, title: `${GROUP_TITLES.needs}: ${needs.length}`, detail: deadlineText(needs[0].sla.left_s), next: true};
  }
  const reminder = g.snoozed[0]?.snooze_until_text ?? null;
  const calm = [g.counts.work ? `в работе ${g.counts.work}` : null, g.counts.snoozed ? `отложено ${g.counts.snoozed}` : null,
    reminder ? `напоминание в ${reminder} (${CLOCK_TEXT.data})` : null].filter(Boolean);
  return {kind: 'calm', level: 'normal', title: 'Предупреждений нет', detail: calm.join(' · '), next: false};
}

// Pending toasts, newest first, with their event views; the caller dismisses them by key.
export function toastViews(state, wallS) {
  return state.toasts.map(t => ({...t, event: eventView(state, t.id, wallS)})).filter(t => t.event);
}

// Toasts report state transitions only — new event, back from snooze, monitoring lost (Q2) — and
// never an event the dispatcher already sees. Returns {show, drop}: `drop` are keys the caller
// dismisses for good (the event ended, its card is open, or its row is visible in the queue — seen
// once is seen), `show` the toasts to draw, newest first, at most `max`. A new/remind toast waits
// while the vehicle has no current warning; a «lost» one goes once data is back. Nothing shows
// while `live` is false (Backend offline, run over).
export function toastPlan(state, wallS, {live = true, openTrId = null, visibleIds = [], max = TOASTS_MAX} = {}) {
  const show = [];
  const drop = [];
  for (const toast of toastViews(state, wallS)) {
    const {event} = toast;
    if (event.group === 'ended' || event.tr_id === openTrId || visibleIds.includes(event.id)
      || (toast.kind === 'lost' && !event.lost)) drop.push(toast.key);
    else if (live && (toast.kind === 'lost' || event.vehicle_state === 'warning')) show.push(toast);
  }
  return {show: show.slice(0, max), drop};
}

// ---- Persistence (the caller wraps sessionStorage in try/catch) -----------------------------

export const serialize = state => JSON.stringify(state);

// Returns null for anything that is not a queue of this format (old version, garbage, wrong run).
export function deserialize(text, {source} = {}) {
  try {
    const state = JSON.parse(text);
    const ok = state && state.format === FORMAT && Array.isArray(state.store?.incidents) && state.events
      && Array.isArray(state.toasts) && Array.isArray(state.selection) && Number.isFinite(state.sla_s);
    if (!ok || (source !== undefined && state.store.source !== source)) return null;
    return state;
  } catch {
    return null;
  }
}
