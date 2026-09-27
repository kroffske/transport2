import test from 'node:test';
import assert from 'node:assert/strict';
import {CLOSE_REASONS, RESOLVED_CLOSE_REASON, SLA_S, addNote, attentionSummary, clearSelection, close, createQueue,
  dataSeconds, deserialize, dismissToast, dismissToasts, eventForVehicle, eventView, groupIds, groups, markEndedRead, markOpened, markRead,
  navOrder, nextEvent, nextQueueEvent, observe, pinFor, queueLayout, selectGroup, serialize, snooze, take, toastPlan, toastViews, toggleSelected, toggleStep,
  unsnooze, untake} from './event-queue.js';

const bus = (tr_id, prediction_s, status = 'normal') => ({tr_id, prediction_s, status});
// The demo runs ×5: `w` is the wall (screen) second, at(w) the run clock 06:58:52 + 5·w as ISO.
const T0 = dataSeconds('2026-01-06T06:58:52');
const at = w => new Date((T0 + 5 * w) * 1000).toISOString().slice(0, 19);
const poll = (q, rows, w) => observe(q, rows, {dataNow: at(w), wallS: w});
const only = (q, tr) => eventForVehicle(q, tr);
const badge = (q, tr, w) => eventView(q, only(q, tr), w).badge.text;

test('data time is read by its own digits; SLA default comes from the v2 prototype', () => {
  assert.equal(SLA_S, 90);
  assert.equal(dataSeconds('2026-01-06T06:58:52.5') - T0, 0.5);
  assert.equal(dataSeconds(123), 123);
  assert.equal(dataSeconds(null), null);
  assert.equal(dataSeconds('not a time'), null);
});

test('a new warning enters «Требует реакции» with an SLA badge counted in wall (screen) seconds', () => {
  let q = createQueue('run-1');
  q = poll(q, [bus('A', 60)], 0);
  assert.equal(groups(q).counts.needs, 0);
  q = poll(q, [bus('A', 200)], 10);
  const g = groups(q, 10);
  assert.deepEqual(g.needs.map(v => v.tr_id), ['A']);
  assert.equal(g.needs[0].unread, true);
  assert.equal(badge(q, 'A', 10), 'реакция 1:30');
  assert.equal(eventView(q, only(q, 'A'), 10).badge.tone, 'sla');
  assert.equal(eventView(q, only(q, 'A'), 10).badge.clock_text, 'реальное время', 'the SLA says it counts real time');
  assert.equal(badge(q, 'A', 80), 'реакция 0:20');
  assert.equal(eventView(q, only(q, 'A'), 80).badge.tone, 'sla_low');
  assert.equal(badge(q, 'A', 100), 'реакция 0:00');
  assert.equal(badge(q, 'A', 130), 'просрочено 0:30');
  assert.equal(eventView(q, only(q, 'A'), 130).badge.tone, 'overdue');
  assert.equal(groups(q, 130).counts.overdue, 1);
  // Without wallS the selectors use the last polled wall time.
  assert.equal(eventView(q, only(q, 'A')).badge.text, 'реакция 1:30');
  // ×5 data does not speed the SLA up: 30 wall s later (150 data s) 1:00 is left, not overdue.
  const later = poll(q, [bus('A', 200)], 40);
  assert.equal(later.now_s - q.now_s, 150);
  assert.equal(badge(later, 'A', 40), 'реакция 1:00');
  // A wall clock that went backwards (reload with performance.now()) never adds time.
  assert.equal(badge(q, 'A', 3), 'реакция 1:30');
  // A configurable SLA.
  let q2 = createQueue('run-1', {slaS: 120});
  q2 = poll(q2, [bus('A', 200)], 0);
  assert.equal(badge(q2, 'A', 0), 'реакция 2:00');
});

test('functions are pure: the argument is never mutated', () => {
  const q0 = poll(createQueue('run-1'), [bus('A', 200)], 0);
  const frozen = serialize(q0);
  const q1 = take(q0, only(q0, 'A'), at(5));
  poll(q1, [bus('A', 50)], 10);
  snooze(q0, only(q0, 'A'), 5, at(5));
  close(q0, only(q0, 'A'), CLOSE_REASONS[0], at(5));
  assert.equal(serialize(q0), frozen);
  assert.notEqual(q1, q0);
  // A no-op action returns the same object.
  assert.equal(take(q1, only(q1, 'A'), at(6)), q1);
  assert.equal(take(q1, 'nope', at(6)), q1);
});

test('take / untake / snooze / unsnooze move the event between groups with v2 badges and history', () => {
  let q = poll(createQueue('run-1'), [bus('A', 200)], 0);
  const id = only(q, 'A');
  q = take(q, id, at(20));
  assert.equal(eventView(q, id).group, 'work');
  assert.equal(badge(q, 'A', 20), 'в работе');
  assert.equal(eventView(q, id).unread, false);
  assert.equal(q.store.incidents[0].workflow, 'in_work');
  assert.equal(badge(untake(q, id, at(40)), 'A', 40), 'реакция 0:50', 'without wallS: the last polled wall time');
  q = untake(q, id, at(40), 40);
  assert.equal(eventView(q, id).group, 'needs');
  assert.equal(badge(q, 'A', 40), 'реакция 1:30', 'SLA restarts on return to new');
  q = snooze(q, id, 5, at(60)); // data 07:03:52 + 5 data min
  assert.equal(eventView(q, id).group, 'snoozed');
  assert.equal(badge(q, 'A', 60), 'напомнить в 07:08');
  assert.equal(eventView(q, id).badge.clock_text, 'время данных');
  assert.equal(eventView(q, id).snooze_note, 'напомнить в 07:08 (время данных)');
  q = unsnooze(q, id, at(70));
  assert.equal(eventView(q, id).group, 'work');
  assert.deepEqual(q.store.incidents[0].history.filter(h => h.kind === 'action').map(h => h.text), [
    'Взято в работу', 'Возвращено в новые', 'Отложено на 5 мин данных: напомнить в 07:08 (время данных)', 'Напоминание снято, взято в работу']);
  assert.equal(q.store.incidents[0].history.at(-1).at, at(70));
});

test('snooze runs on data time: 5 data min = 60 wall s at ×5, then back to «Требует реакции»', () => {
  let q = poll(createQueue('run-1'), [bus('A', 200)], 0);
  const id = only(q, 'A');
  q = dismissToast(q, `new|${id}`);
  q = snooze(q, id, 5, at(10)); // data 06:59:42 → remind at 07:04:42
  assert.equal(badge(q, 'A', 10), 'напомнить в 07:04');
  q = poll(q, [bus('A', 210)], 69);
  assert.equal(eventView(q, id).group, 'snoozed');
  assert.equal(toastViews(q).length, 0);
  q = poll(q, [bus('A', 210)], 70);
  const view = eventView(q, id, 70);
  assert.equal(view.group, 'needs');
  assert.equal(view.unread, true);
  assert.equal(view.badge.text, 'реакция 1:30');
  assert.equal(q.store.incidents[0].history.at(-1).text, 'Напоминание: событие вернулось в новые');
  const toasts = toastViews(q);
  assert.deepEqual(toasts.map(t => t.kind), ['remind']);
  assert.equal(toasts[0].event.id, id);
  // The next poll does not remind again.
  q = poll(q, [bus('A', 210)], 71);
  assert.equal(toastViews(q).length, 1);
  assert.equal(q.store.incidents[0].history.filter(h => h.text.startsWith('Напоминание:')).length, 1);
});

test('close with a reason ends the event; the ended delay adds its own reason first', () => {
  let q = poll(createQueue('run-1'), [bus('A', 200), bus('B', 200)], 0);
  const a = only(q, 'A');
  assert.deepEqual(eventView(q, a).close_reasons, CLOSE_REASONS);
  assert.equal(close(q, a, '   ', at(5)), q, 'an empty reason is a no-op');
  q = close(q, a, CLOSE_REASONS[1], at(5));
  const view = eventView(q, a);
  assert.equal(view.group, 'ended');
  assert.equal(view.badge.text, 'Закрыто');
  assert.equal(view.close_reason, 'Ложное: ошибка GPS или прогноза');
  assert.equal(view.unread, false);
  assert.equal(q.store.incidents[0].history.at(-1).text, 'Закрыто: Ложное: ошибка GPS или прогноза');
  assert.deepEqual(view.steps, [], 'no checklist on an ended event');
  // A closed episode whose delay goes on stays closed: no new event for A until it ends.
  q = poll(q, [bus('A', 220), bus('B', 200)], 10);
  assert.equal(groups(q).counts.ended, 1);
  assert.equal(q.store.incidents.length, 2);
  // B's delay ends: ended + unread, and it may still be closed with the «ended» reason.
  q = poll(q, [bus('A', 220), bus('B', 60)], 20);
  const b = only(q, 'B');
  assert.equal(eventView(q, b).badge.text, 'Задержка закончилась');
  assert.equal(eventView(q, b).unread, true);
  assert.equal(eventView(q, b).close_reasons[0], RESOLVED_CLOSE_REASON);
  q = close(q, b, RESOLVED_CLOSE_REASON, at(25));
  assert.equal(eventView(q, b).badge.text, 'Закрыто');
});

test('unread counts: new, resolved and reminded events are unread; «прочитать все» clears ended', () => {
  let q = poll(createQueue('run-1'), [bus('A', 200), bus('B', 200), bus('C', 200)], 0);
  assert.equal(groups(q).counts.unread, 3);
  q = take(q, only(q, 'A'), at(5));
  q = markRead(q, only(q, 'B'));
  assert.equal(groups(q).counts.unread, 1);
  assert.equal(markRead(q, only(q, 'B')), q, 'reading a read event is a no-op');
  q = poll(q, [bus('A', 60), bus('B', 60), bus('C', 200)], 10);
  const counts = groups(q).counts;
  assert.equal(counts.ended, 2);
  assert.equal(counts.ended_unread, 2);
  assert.equal(counts.unread, 3);
  q = markEndedRead(q);
  assert.equal(groups(q).counts.ended_unread, 0);
  assert.equal(groups(q).counts.unread, 1);
});

test('J/K order: overdue first, then by SLA left, then «В работе», then «Отложены»; wraps around', () => {
  let q = poll(createQueue('run-1'), [bus('A', 200)], 0); // A overdue at t=120
  q = poll(q, [bus('A', 200), bus('B', 150)], 60); // B 30 s left at t=120
  q = poll(q, [bus('A', 200), bus('B', 150), bus('C', 400)], 100); // C 70 s left
  q = poll(q, [bus('A', 200), bus('B', 150), bus('C', 400), bus('D', 250), bus('E', 180)], 110);
  q = take(q, only(q, 'D'), at(110));
  q = snooze(q, only(q, 'E'), 2, at(110));
  const tr = ids => ids.map(id => eventView(q, id).tr_id);
  assert.deepEqual(tr(navOrder(q, 120)), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(eventView(q, only(q, 'A'), 120).badge.text, 'просрочено 0:30');
  const [a, , , , e] = navOrder(q, 120);
  assert.equal(nextEvent(q, a, +1, 120), only(q, 'B'));
  assert.equal(nextEvent(q, a, -1, 120), e, 'K wraps to the last');
  assert.equal(nextEvent(q, e, +1, 120), a, 'J wraps to the first');
  assert.equal(nextEvent(q, null, +1, 120), a);
  assert.equal(nextEvent(q, null, -1, 120), e);
  assert.equal(nextEvent(createQueue('x'), null, 1), null);
});

test('attention bar is a summary: count and nearest deadline, or the open event and how many more (Q1)', () => {
  let q = poll(createQueue('run-1'), [bus('A', 200)], 0);
  q = poll(q, [bus('A', 200), bus('B', 250)], 30);
  const a = only(q, 'A');
  assert.deepEqual(attentionSummary(q, 53), {kind: 'needs', level: 'warning', title: 'Требуют реакции: 2', detail: 'ближайший срок 0:37', next: true});
  assert.equal(attentionSummary(q, 102).detail, 'просрочено 0:12', 'an overdue deadline is said in words');
  assert.equal(attentionSummary(q, 102).level, 'severe');
  assert.deepEqual(attentionSummary(q, 53, a), {kind: 'open', level: 'warning', title: 'Открыто: ТС A', detail: 'ещё 1 требует реакции', next: true});
  q = poll(q, [bus('A', 200), bus('B', 250), bus('C', 200), bus('D', 200)], 31);
  assert.equal(attentionSummary(q, 53, a).detail, 'ещё 3 требуют реакции');
  q = take(q, only(q, 'B'), at(40));
  q = close(q, [only(q, 'C'), only(q, 'D')], CLOSE_REASONS[0], at(40));
  assert.deepEqual(attentionSummary(q, 53, a), {kind: 'open', level: 'normal', title: 'Открыто: ТС A', detail: 'других событий, требующих реакции, нет', next: false});
  q = snooze(q, a, 10, at(40));
  assert.deepEqual(attentionSummary(q, 41), {kind: 'calm', level: 'normal', title: 'Предупреждений нет',
    detail: 'в работе 1 · отложено 1 · напоминание в 07:12 (время данных)', next: false}); // data 07:02:12 + 10 min
  assert.equal(attentionSummary(createQueue('x'), 0).detail, '', 'no events: «Предупреждений нет» alone');
  // A vehicle that lost its forecast is calm in the bar; the queue still lists its event.
  let n = poll(createQueue('run-2'), [bus('N', 200)], 0);
  n = poll(n, [bus('N', 200, 'degraded')], 1);
  assert.equal(groups(n).counts.needs, 1);
  assert.deepEqual([attentionSummary(n, 1).kind, attentionSummary(n, 1).title], ['calm', 'Предупреждений нет']);
});

test('stable queue: the open event keeps its row after an action and regroups when the pin goes (Q6)', () => {
  let q = poll(createQueue('run-1'), [bus('A', 200)], 0);
  q = poll(q, [bus('A', 200), bus('B', 200)], 10);
  q = poll(q, [bus('A', 200), bus('B', 200), bus('C', 200), bus('W', 200)], 20);
  q = take(q, only(q, 'W'), at(20));
  const tr = list => list.map(v => v.tr_id);
  const b = only(q, 'B');
  const pin = pinFor(q, b, 30);
  assert.deepEqual(pin, {id: b, group: 'needs', index: 1});
  q = take(q, b, at(30));
  const held = queueLayout(q, 30, {pin});
  assert.deepEqual(tr(held.needs), ['A', 'B', 'C'], 'B keeps its place in «Требуют реакции»');
  assert.deepEqual(tr(held.work), ['W']);
  assert.equal(held.needs[1].badge.text, 'в работе', 'its badge shows the new state');
  assert.equal(held.needs[1].pinned, true);
  assert.equal(held.counts.needs, 2, 'counts stay real');
  assert.deepEqual(held.order.map(id => eventView(q, id).tr_id), ['A', 'B', 'C', 'W']);
  const free = queueLayout(q, 30);
  assert.deepEqual([tr(free.needs), tr(free.work)], [['A', 'C'], ['B', 'W']], 'without the pin B regroups');
  assert.equal(queueLayout(q, 30, {pin: pinFor(q, b, 30)}).work.find(v => v.tr_id === 'B').pinned, false);
  // Filter chips: one group; «Завершены» under «Все» only.
  q = close(q, only(q, 'W'), CLOSE_REASONS[0], at(31));
  assert.deepEqual(tr(queueLayout(q, 30, {filter: 'work'}).work), ['B']);
  assert.deepEqual(tr(queueLayout(q, 30, {filter: 'work'}).needs), []);
  assert.deepEqual(tr(queueLayout(q, 30, {filter: 'needs', pin}).needs), ['A', 'B', 'C'], 'the pinned row stays under its chip');
  assert.deepEqual(tr(queueLayout(q, 30, {filter: 'needs'}).ended), []);
  assert.deepEqual(tr(queueLayout(q, 30).ended), ['W']);
  assert.equal(pinFor(q, 'nope', 30), null);
});

test('J after an action goes to the next «Требует реакции»; otherwise J/K walk the displayed rows (Q6)', () => {
  let q = poll(createQueue('run-1'), [bus('A', 200)], 0);
  q = poll(q, [bus('A', 200), bus('B', 200)], 10);
  q = poll(q, [bus('A', 200), bus('B', 200), bus('C', 200), bus('W', 200)], 20);
  q = take(q, only(q, 'W'), at(20));
  const [a, b, c, w] = ['A', 'B', 'C', 'W'].map(tr => only(q, tr));
  // Not acted: the displayed order A, B, C, W, wrapping.
  assert.equal(nextQueueEvent(q, c, +1, 30, {pin: pinFor(q, c, 30)}), w);
  assert.equal(nextQueueEvent(q, a, -1, 30, {pin: pinFor(q, a, 30)}), w);
  assert.equal(nextQueueEvent(q, null, +1, 30), a);
  assert.equal(nextQueueEvent(q, null, -1, 30), w);
  // C taken while open: J skips «В работе» and wraps to the first «Требует реакции».
  const pin = pinFor(q, c, 30);
  q = take(q, c, at(30));
  assert.equal(nextQueueEvent(q, c, +1, 30, {pin}), a);
  assert.equal(nextQueueEvent(q, c, -1, 30, {pin}), b, 'K: the previous «Требует реакции»');
  // Nothing else needs a reaction: the next row.
  q = take(q, [a, b], at(31));
  assert.deepEqual(queueLayout(q, 30, {pin}).order, [c, a, b, w], 'the pinned row stays first of its group');
  assert.equal(nextQueueEvent(q, c, +1, 30, {pin}), a);
  // The filter limits J/K to what is displayed.
  assert.equal(nextQueueEvent(q, null, +1, 30, {filter: 'snoozed'}), null);
  assert.equal(nextQueueEvent(createQueue('x'), null, 1), null);
});

test('toasts: once per new event, newest first, at most three, cleared by an action or dismiss', () => {
  let q = createQueue('run-1');
  for (const [i, tr] of ['A', 'B', 'C', 'D'].entries()) {
    q = poll(q, ['A', 'B', 'C', 'D'].slice(0, i + 1).map(x => bus(x, 200)), i);
  }
  assert.deepEqual(toastViews(q).map(t => t.event.tr_id), ['D', 'C', 'B']);
  for (let i = 0; i < 3; i += 1) q = poll(q, ['A', 'B', 'C', 'D'].map(x => bus(x, 200)), 3);
  assert.equal(toastViews(q).length, 3, 'polling does not re-toast');
  q = take(q, only(q, 'D'), at(4));
  assert.deepEqual(toastViews(q).map(t => t.event.tr_id), ['C', 'B']);
  q = dismissToast(q, `new|${only(q, 'C')}`);
  assert.deepEqual(toastViews(q).map(t => t.kind), ['new']);
  // Opening the event reads it and hides its toast.
  const opened = markOpened(q, only(q, 'B'));
  assert.equal(toastViews(opened).length, 0);
  assert.equal(eventView(opened, only(q, 'B')).unread, false);
  assert.equal(markOpened(opened, only(q, 'B')), opened, 'nothing to do: the same state');
  assert.equal(dismissToasts(q, ['nope']), q);
  // The delay ends: its toast goes.
  q = poll(q, [bus('A', 200), bus('B', 60), bus('C', 200), bus('D', 200)], 5);
  assert.equal(toastViews(q).length, 0);
});

test('toast plan: state transitions only, never for an event the dispatcher already sees (Q2)', () => {
  let q = poll(createQueue('run-1'), [bus('A', 200), bus('B', 200), bus('C', 200)], 0);
  const [a, b, c] = ['A', 'B', 'C'].map(tr => only(q, tr));
  const keys = plan => plan.show.map(t => t.event.tr_id);
  assert.deepEqual(keys(toastPlan(q, 0)), ['C', 'B', 'A']);
  assert.deepEqual(keys(toastPlan(q, 0, {max: 2})), ['C', 'B']);
  // Row visible in the queue, or the card open: dropped for good.
  const plan = toastPlan(q, 0, {visibleIds: [a], openTrId: 'B'});
  assert.deepEqual(keys(plan), ['C']);
  assert.deepEqual(plan.drop.sort(), [`new|${a}`, `new|${b}`].sort());
  // Not live (Backend offline, run over): nothing shows, nothing is lost.
  assert.deepEqual(toastPlan(q, 0, {live: false}), {show: [], drop: []});
  // A vehicle without a current warning (short gap) waits; an ended event drops its toast.
  q = poll(q, [bus('A', 200), bus('B', 200, 'degraded'), bus('C', 200)], 1);
  assert.deepEqual(keys(toastPlan(q, 1)), ['C', 'A']);
  q = close(q, c, CLOSE_REASONS[0], at(1));
  assert.equal(toastPlan(q, 1).drop.length, 0, 'close already removed the toast');
  // Monitoring lost on an open event: one «lost» toast; it goes when data is back.
  q = dismissToasts(q, q.toasts.map(t => t.key));
  q = poll(q, [bus('A', 200, 'degraded'), bus('C', 200)], 2);
  q = poll(q, [bus('A', 200, 'degraded'), bus('C', 200)], 20);
  assert.deepEqual(toastPlan(q, 20).show.map(t => [t.kind, t.event.tr_id]), [['lost', 'B'], ['lost', 'A']]);
  q = poll(q, [bus('A', 200, 'degraded'), bus('C', 200)], 21);
  assert.equal(toastViews(q).length, 2, 'polling does not re-toast «lost»');
  q = poll(q, [bus('A', 200), bus('C', 200)], 22);
  assert.deepEqual(toastPlan(q, 22).drop, [q.toasts.find(t => t.id === a).key]);
});

test('group actions: select all in a group, then take / snooze / close the selection', () => {
  let q = poll(createQueue('run-1'), [bus('A', 200), bus('B', 200), bus('C', 200)], 0);
  q = selectGroup(q, 'needs');
  assert.equal(groups(q).counts.selected, 3);
  assert.equal(selectGroup(q, 'ended'), q, 'ended cannot be selected');
  q = selectGroup(q, 'needs');
  assert.equal(groups(q).counts.selected, 0, 'select all again unselects');
  q = toggleSelected(q, only(q, 'A'));
  q = toggleSelected(q, only(q, 'B'));
  assert.deepEqual(groups(q).needs.filter(v => v.selected).map(v => v.tr_id), ['A', 'B']);
  q = snooze(q, q.selection, 5, at(10));
  assert.deepEqual(groupIds(q, 'snoozed').map(id => eventView(q, id).tr_id), ['A', 'B']);
  assert.deepEqual(q.selection, [], 'acted ids leave the selection');
  q = selectGroup(q, 'snoozed');
  q = take(q, q.selection, at(20));
  assert.equal(groups(q).counts.work, 2);
  q = selectGroup(q, 'work');
  q = toggleSelected(q, only(q, 'C'));
  q = close(q, q.selection, CLOSE_REASONS[3], at(30));
  assert.equal(groups(q).counts.ended, 3);
  assert.deepEqual(groups(q).ended.map(v => v.close_reason), Array(3).fill('Пробка — повлиять нельзя'));
  assert.equal(toggleSelected(q, only(q, 'A')), q, 'an ended event cannot be selected');
  assert.equal(clearSelection(q), q);
  // A selected event whose delay ends leaves the selection on the next poll.
  let r = poll(createQueue('run-2'), [bus('X', 200)], 0);
  r = toggleSelected(r, only(r, 'X'));
  r = poll(r, [bus('X', 60)], 5);
  assert.deepEqual(r.selection, []);
});

test('«Шаги реакции»: three steps, a fourth for a severe episode; progress text and history', () => {
  let q = poll(createQueue('run-1'), [bus('A', 200), bus('S', 320)], 0);
  const a = eventView(q, only(q, 'A'));
  assert.deepEqual(a.steps.map(s => s.key), ['gps', 'driver', 'gap']);
  assert.equal(a.steps_progress, '0/3');
  const sId = only(q, 'S');
  assert.equal(eventView(q, sId).steps_progress, '0/4');
  q = toggleStep(q, sId, 'driver', at(5));
  q = toggleStep(q, sId, 'lead', at(6));
  assert.equal(eventView(q, sId).steps_progress, '2/4');
  q = toggleStep(q, sId, 'driver', at(7));
  assert.equal(eventView(q, sId).steps_progress, '1/4');
  assert.deepEqual(q.store.incidents[1].history.slice(-3).map(h => h.text), [
    'Шаг: Связаться с водителем', 'Шаг: Сообщить старшему смены', 'Шаг отменён: Связаться с водителем']);
  assert.equal(toggleStep(q, only(q, 'A'), 'lead', at(8)), q, 'the severe step does not exist for a normal warning');
  assert.equal(toggleStep(q, sId, 'nope', at(8)), q);
});

test('polling the same snapshot is idempotent for everything the dispatcher sees', () => {
  const rows = [bus('A', 200), bus('B', 400), bus('C', null)];
  let q = poll(createQueue('run-1'), rows, 0);
  q = take(q, only(q, 'B'), at(1));
  const once = poll(q, rows, 2);
  let many = once;
  for (let i = 0; i < 5; i += 1) many = poll(many, rows, 2);
  assert.deepEqual(groups(many), groups(once));
  assert.deepEqual(many.toasts, once.toasts);
  assert.deepEqual(many.events, once.events);
  assert.deepEqual(many.store.incidents, once.store.incidents);
});

test('serialize / deserialize round-trips the queue and rejects anything else', () => {
  let q = poll(createQueue('run-1'), [bus('A', 200)], 0);
  q = snooze(q, only(q, 'A'), 2, at(5));
  q = addNote(q, only(q, 'A'), ' позвонил\nводителю ', at(6));
  const back = deserialize(serialize(q));
  assert.deepEqual(back, q);
  assert.deepEqual(groups(back, 6), groups(q, 6));
  assert.equal(eventView(back, only(back, 'A')).notes[0].text, 'позвонил водителю');
  // State keeps working after the round trip: the snooze still expires, no second «new» toast.
  const later = poll(back, [bus('A', 200)], 29); // 2 data min from w=5 expire at w=29
  assert.equal(eventView(later, only(later, 'A')).group, 'needs');
  assert.deepEqual(toastViews(later).map(t => t.kind), ['remind'], 'snooze dropped the «new» toast; it never comes back');
  assert.equal(deserialize(serialize(q), {source: 'run-2'}), null, 'another run');
  assert.equal(deserialize(serialize(q), {source: 'run-1'}).store.source, 'run-1');
  assert.equal(deserialize('{"format":"other"}'), null);
  assert.equal(deserialize('not json'), null);
  assert.equal(deserialize(null), null);
});

test('monitoring lost keeps the event in its group, flagged; a numeric data time works too', () => {
  let q = createQueue('run-1');
  q = observe(q, [bus('A', 200)], {dataNow: 1000, wallS: 0});
  q = take(q, only(q, 'A'), 1005);
  q = observe(q, [bus('A', 200, 'degraded')], {dataNow: 1010, wallS: 1});
  q = observe(q, [bus('A', 200, 'degraded')], {dataNow: 1100, wallS: 40});
  const view = eventView(q, only(q, 'A'));
  assert.equal(view.lifecycle, 'monitoring_lost');
  assert.equal(view.lost, true);
  assert.equal(view.group, 'work');
  assert.equal(q.store.incidents[0].history.find(h => h.text === 'Взято в работу').at, '1970-01-01T00:16:45');
});
