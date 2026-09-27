import test from 'node:test';
import assert from 'node:assert/strict';
import {FORECAST_STATES, forecastState, forecastView as view0} from './forecast.js';

// Texts compared with plain spaces; values and «ост. N» keep non-breaking ones (checked once below).
const plain = value => (typeof value === 'string' ? value.replaceAll('\u00a0', ' ')
  : Array.isArray(value) ? value.map(plain) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)])) : value);
const forecastView = (...args) => plain(view0(...args));

// Illustration of the spec: data time 08:30, plan 08:42, expected 08:45, +3 мин.
const row = (overrides = {}) => ({
  tr_id: '134040', status: 'normal', reason: null, prediction_state: 'fresh', prediction_updating: false,
  target_stop_id: 'S12', planned_target_stop_id: 'S12', prediction_held_from_target: null,
  target_time_begin: '2026-01-06T08:42:00', prediction_s: 180, prediction_age_s: 60,
  last_success_at: '2026-01-06T08:29:10', cur_dev_s: 60, ...overrides,
});
const ctx = (overrides = {}) => ({fresh: true, runOver: false, datasetEnd: '2026-01-06T09:30:00', dataTime: '2026-01-06T08:30:05',
  numbers: {target: 12, newTarget: null, fact: 4}, targetOnMap: true, ...overrides});
// Visible text of a view, with the non-breaking spaces of values as plain spaces.
const flat = view => [view.head, ...view.rows.flat(), view.big?.label, view.big?.value, ...view.lines.map(l => l.text), view.fact]
  .filter(Boolean).join(' | ').replaceAll('\u00a0', ' ');

test('main state (C2): target, plan, expected, the delay large, the fact and the age', () => {
  const view = forecastView(row(), ctx());
  assert.equal(view.state, 'current');
  assert.equal(view.head, 'Цель прогноза · ост. 12');
  assert.deepEqual(view.rows, [['По расписанию', '08:42'], ['Ожидается', '08:45 · прогноз модели']]);
  assert.deepEqual(view.big, {label: 'Опоздание по прогнозу', value: '+3 мин', size: 'large'});
  assert.equal(view.fact.replaceAll('\u00a0', ' '), 'Сейчас: опаздывает на 1 мин (факт, ост. 4)');
  assert.equal(view.lines[0].text.replaceAll('\u00a0', ' '), 'Прогноз от 08:29 — 1 мин назад');
  assert.equal(view.tone, 'live');
  assert.match(view.help, /первая остановка, до которой по расписанию 10–15 мин от времени данных/);
  assert.match(view.help, /а не время до начала задержки/);
  assert.match(view.help, /„ост\. 12“ — 12-я остановка в окне ±30 мин; названий в данных нет\./);
  assert.ok(!/\d\d:\d\d:\d\d/.test(flat(view)), 'no seconds in the card times (C4)');
});

test('values and stop numbers do not break across lines (NBSP, C4)', () => {
  const raw = view0(row({prediction_s: 109}), ctx());
  assert.equal(raw.big.value, '+1 мин 49 с');
  assert.equal(raw.head, 'Цель прогноза · ост. 12');
  assert.match(raw.fact, /\(факт, ост\. 4\)$/);
});

test('the fact: ahead, on time, unknown; without a route no stop number', () => {
  assert.match(forecastView(row({cur_dev_s: -40}), ctx()).fact, /^Сейчас: опережает на 40.с \(факт, ост\. 4\)$/);
  assert.equal(forecastView(row({cur_dev_s: 12}), ctx()).fact, 'Сейчас: идёт по графику (факт, ост. 4)');
  assert.equal(forecastView(row({cur_dev_s: null}), ctx()).fact, 'Факт опоздания пока не определён');
  const bare = forecastView(row(), ctx({numbers: {}}));
  assert.equal(bare.head, 'Цель прогноза');
  assert.equal(bare.fact.replaceAll('\u00a0', ' '), 'Сейчас: опаздывает на 1 мин (факт)');
  assert.match(bare.help, /„ост\. N“/);
});

test('updating the same target (C3): the same value, «обновляется» with the last result and its age', () => {
  const view = forecastView(row({prediction_updating: true, prediction_age_s: 18}), ctx());
  assert.equal(view.state, 'updating');
  assert.equal(view.big.value, '+3 мин');
  assert.equal(view.lines[0].kind, 'updating');
  assert.equal(view.lines[0].text.replaceAll('\u00a0', ' '), 'Прогноз обновляется · последний результат для этой цели: +3 мин · 18 с назад');
  assert.match(view.updating, /возраст 18 с, время данных/);
});

test('target change (C3): the new target and «считается»; the old value never next to the new target', () => {
  const held = row({status: 'degraded', reason: 'prediction_held_previous_target', prediction_state: 'updating',
    prediction_held_from_target: 'S12', planned_target_stop_id: 'S14', prediction_updating: true});
  const view = forecastView(held, ctx({numbers: {target: 12, newTarget: {no: 14, plan: '08:47', stop_id: 'S14'}, fact: 4}}));
  assert.equal(view.state, 'held');
  assert.equal(view.lines[0].text, 'Новая цель: ост. 14 · по расписанию 08:47. Прогноз для неё считается.');
  assert.equal(view.lines[1].text.replaceAll('\u00a0', ' '), 'Прошлый результат: ост. 12 · 08:42 · +3 мин. К новой цели не относится.');
  assert.equal(view.lines[1].kind, 'muted');
  assert.equal(view.big, null, 'no large number while the new target is being computed');
  assert.ok(view.lines.every(l => !(l.text.includes('ост. 14') && l.text.includes('+3'))), 'old value and new target never in one line');
  assert.ok(view.updating);
  const unknown = forecastView(held, ctx());
  assert.equal(unknown.lines[0].text, 'Новая цель выбрана по расписанию. Прогноз для неё считается.', 'new target not in the route window yet');
});

test('stale (C3): «Прогноз устарел» large, the last result grey with its age, the reason', () => {
  const view = forecastView(row({status: 'degraded', reason: 'ml_unreachable_or_timeout', prediction_age_s: 240}), ctx());
  assert.equal(view.state, 'stale');
  assert.equal(view.big.value, 'Прогноз устарел');
  assert.equal(view.tone, 'quiet');
  assert.equal(view.lines[0].text.replaceAll('\u00a0', ' '),
    'Последний результат для ост. 12: по расписанию 08:42 · ожидалось 08:45 · +3 мин. Получен 4 мин назад (время данных). Не использовать как текущий.');
  assert.equal(view.lines[1].text, 'Причина: модель недоступна (нет ответа или timeout).');
});

test('target without a forecast (C3): the stop, its plan time and the reason', () => {
  const view = forecastView(row({status: 'unavailable', reason: 'prediction_waiting_new_telemetry', prediction_s: null, prediction_state: 'none'}), ctx());
  assert.equal(view.state, 'no_forecast');
  assert.equal(view.big.value, 'Прогноза для цели пока нет');
  assert.deepEqual(view.lines.map(l => l.text), ['Ост. 12 · по расписанию 08:42', 'Причина: ожидается новая телеметрия для прогноза.']);
});

test('no target (C3): normal size, the horizon from the data time, the reason in words', () => {
  const none = {target_stop_id: null, target_time_begin: null, prediction_s: null, prediction_state: 'none', status: 'unavailable'};
  const view = forecastView(row({...none, reason: 'no_target_in_horizon'}), ctx());
  assert.equal(view.state, 'no_target');
  assert.deepEqual(view.big, {value: 'Цель прогноза не выбрана', size: 'medium'});
  assert.equal(view.lines[0].text, 'Нет остановки по расписанию в горизонте 10–15 мин от 08:30.');
  assert.match(view.lines[1].text, /^Причина: ТС не на маршруте наряда/);
  assert.match(forecastView(row({...none, reason: 'no_target_in_horizon', gps_suspect: 'no_plan'}), ctx()).lines[1].text, /нет наряда/);
  assert.match(forecastView(row({...none, reason: 'no_target_in_horizon', route_not_started: true}), ctx()).lines[1].text,
    /наряд ещё не начался\. Прогноз появится, когда ТС выйдет на маршрут/);
});

test('target after the end of the run, run over, Backend offline', () => {
  const late = forecastView(row({target_time_begin: '2026-01-06T09:40:00', prediction_s: null, prediction_state: 'none', status: 'unavailable', reason: 'prediction_pending'}), ctx());
  assert.equal(late.state, 'outside_run');
  assert.equal(late.lines[0].text, 'Прогноза не будет: цель по расписанию позже конца данных прогона.');
  const over = forecastView(row(), ctx({runOver: true}));
  assert.equal(over.state, 'run_over');
  assert.equal(over.big.value, 'Прогон завершён');
  assert.equal(over.lines[0].text, 'Новых прогнозов не будет до следующего прогона.');
  assert.match(over.lines[1].text, /^Последний результат для ост\. 12/);
  const offline = forecastView(row(), ctx({fresh: false}));
  assert.equal(offline.state, 'offline');
  assert.match(offline.lines[0].text, /^Backend недоступен/);
  assert.match(offline.fact, /^Последний факт:/, 'an offline fact is not «сейчас»');
});

test('one entry per state: every state forecastState returns has its texts', () => {
  const states = ['current', 'updating', 'held', 'stale', 'no_forecast', 'no_target', 'outside_run', 'run_over', 'offline'];
  assert.deepEqual(Object.keys(FORECAST_STATES).sort(), [...states].sort());
  assert.equal(forecastState(row(), {fresh: true}), 'current');
});
