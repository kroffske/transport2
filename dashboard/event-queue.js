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
//   seconds): «отложить 5 мин» is 5 min of the bus's world, shown as the data clock «напомнить
//   07:04:52», and it expires on the first poll whose data time reaches it (a paused run pauses it).
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
  log(incident, at, `Отложено на ${minutes} мин: напомнить в ${hms(ev.snooze_until_s)}`);
  return true;
});

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
  if (!state.toasts.some(t => t.key === key)) return state;
  return {...clone(state), toasts: state.toasts.filter(t => t.key !== key).map(t => ({...t}))};
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

function badgeOf(incident, ev, sla) {
  if (ev.wf === 'closed') return {text: 'Закрыто', tone: 'closed'};
  if (incident.state === 'resolved') return {text: 'Задержка закончилась', tone: 'ended'};
  if (ev.wf === 'work') return {text: 'в работе', tone: 'work'};
  if (ev.wf === 'snoozed') return {text: `напомнить ${hms(ev.snooze_until_s)}`, tone: 'snoozed'};
  if (sla.over) return {text: `просрочено ${dur(-sla.left_s)}`, tone: 'overdue'};
  return {text: `на реакцию ${dur(sla.left_s)}`, tone: sla.left_s < SLA_LOW_S ? 'sla_low' : 'sla'};
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
    snooze_until_text: ev.snooze_until_s === null ? null : hms(ev.snooze_until_s),
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

// Attention bar: the most urgent «Требует реакции» event and how many more; else a calm summary.
export function attention(state, wallS) {
  const g = groups(state, wallS);
  const [top] = g.needs;
  const more = Math.max(0, g.needs.length - 1);
  const next = g.snoozed[0] ?? null;
  return {
    top: top ?? null,
    more,
    more_text: more ? `ещё ${more}` : '',
    calm: top ? null : {work: g.counts.work, snoozed: g.counts.snoozed, next_reminder_text: next ? next.snooze_until_text : null},
  };
}

// Pending toasts, newest first, with their event views; the caller dismisses them by key.
export function toastViews(state, wallS) {
  return state.toasts.map(t => ({...t, event: eventView(state, t.id, wallS)})).filter(t => t.event);
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
