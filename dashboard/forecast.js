// The forecast block of the vehicle card (UX spec §C, C2–C3): which state the selected row is in,
// and the texts of that state. Pure data, no DOM: app.js renders it.
//
// What the numbers mean (transport_backend/schedule.py, orchestration.py):
//   target        — the first stop whose SCHEDULED time is in (data time + 10 min, + 15 min];
//   prediction_s  — the model's expected delay of the arrival at that stop, not a time until a delay;
//   cur_dev_s     — the fact at the last passed stop;
//   prediction_age_s — age of the model result, in data time.
// Stops have no names: «ост. N» is the position in the route window (route-context.js stopNumbers).
//
// One state per row, one entry per state in FORECAST_STATES. A new Backend state (e.g. a vehicle
// that started its route and has no forecast yet) is one more key in forecastState and one more
// entry in FORECAST_STATES; nothing else in the card changes.
import {assess, isHeld} from './incidents.js';
import {reasonText} from './reasons.js';
import {NBSP, agoText, delayText, delayWords, durationText, planText, shiftedText} from './route-context.js';

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

// ctx: {fresh, runOver, datasetEnd} — the source answers, the run ended, the run's last data time.
export function forecastState(v, {fresh, runOver = false, datasetEnd = null}) {
  const {level, hasPrediction} = assess(v, fresh);
  if (!fresh) return 'offline';
  if (runOver) return 'run_over';
  if (!v.target_stop_id) return 'no_target';
  if (level !== 'nodata') {
    if (isHeld(v)) return 'held';
    return v.prediction_updating === true ? 'updating' : 'current';
  }
  if (datasetEnd && v.target_time_begin && String(v.target_time_begin) > String(datasetEnd)) return 'outside_run';
  return hasPrediction ? 'stale' : 'no_forecast';
}

const help = no => 'Цель — первая остановка, до которой по расписанию 10–15 мин от времени данных. '
  + 'Опоздание — ожидаемое опоздание прибытия на неё, а не время до начала задержки. '
  + `„ост. ${no ?? 'N'}“ — ${no ?? 'N'}-я остановка в окне ±30 мин; названий в данных нет.`;

// Why a vehicle has no target: said in the dispatcher's words (not the code).
function noTargetReason(v) {
  if (v.gps_suspect === 'no_plan') return 'у ТС нет наряда — маршрута и прогноза нет.';
  if (v.route_not_started === true) return 'наряд ещё не начался. Прогноз появится, когда ТС выйдет на маршрут.';
  if (v.reason && v.reason !== 'no_target_in_horizon') return `${reasonText(v.reason)}.`;
  return 'ТС не на маршруте наряда в этом горизонте. Прогноз появится, когда ТС выйдет на маршрут.';
}

// Everything the state texts are made of, computed once.
function parts(v, ctx) {
  const numbers = ctx.numbers ?? {};
  const stop = numbers.target ? `ост.${NBSP}${numbers.target}` : null;
  const plan = planText(v.target_time_begin);
  const value = delayText(v.prediction_s);
  const expected = shiftedText(v.target_time_begin, v.prediction_s);
  const ago = agoText(v.prediction_age_s);
  const cur = finite(v.cur_dev_s) ? Number(v.cur_dev_s) : null;
  const factAt = numbers.fact ? `, ост.${NBSP}${numbers.fact}` : '';
  const reason = reasonText(v.reason);
  return {
    no: numbers.target ?? null, stop, plan, value, expected, ago, reason,
    head: stop ? `Цель прогноза · ${stop}` : 'Цель прогноза',
    help: `${help(numbers.target)}${v.target_stop_id && ctx.targetOnMap === false ? ' Координат цели нет — на карте она не показана.' : ''}`,
    fact: cur === null ? 'Факт опоздания пока не определён'
      : `${ctx.fresh ? 'Сейчас' : 'Последний факт'}: ${delayWords(cur)} (факт${factAt})`,
    // The last model result, never presented as current (stale, offline, run over).
    last: finite(v.prediction_s) && plan
      ? `Последний результат для ${stop ?? 'цели'}: по расписанию ${plan} · ожидалось ${expected} · ${value}.` : null,
    got: ago ? `Получен ${ago} (время данных).` : '',
    age: ago ? (v.last_success_at ? `Прогноз от ${planText(v.last_success_at)} — ${ago}` : `Прогноз получен ${ago}`) : null,
    newTarget: numbers.newTarget ?? null,
    dataTime: planText(ctx.dataTime),
    noTargetReason: noTargetReason(v),
    ageTitle: durationText(v.prediction_age_s) ?? 'неизвестен',
  };
}

const line = (text, kind = 'plain') => (text ? {text, kind} : null);
const current = p => [['По расписанию', p.plan ?? '—'], ['Ожидается', `${p.expected ?? '—'} · прогноз модели`]];

// state → texts. `big.size`: 'large' for the one number to read at a glance, 'medium' for a
// state sentence (never the large size for «no target»). `tone`: 'live' colours the value by
// level; 'quiet' keeps every number grey. `updating`: the «обновляется» mark and its tooltip.
export const FORECAST_STATES = {
  current: p => ({tone: 'live', head: p.head, rows: current(p),
    big: {label: 'Опоздание по прогнозу', value: p.value, size: 'large'}, lines: [line(p.age, 'age')]}),
  updating: p => ({tone: 'live', head: p.head, rows: current(p),
    big: {label: 'Опоздание по прогнозу', value: p.value, size: 'large'},
    lines: [line(`Прогноз обновляется · последний результат для этой цели: ${p.value} · ${p.ago ?? 'возраст неизвестен'}`, 'updating')],
    updating: `Пришли новые кадры той же цели; прогноз по ним ещё считается. Показан последний результат для этой цели (возраст ${p.ageTitle}, время данных).`}),
  held: p => ({tone: 'quiet', head: 'Цель прогноза сменилась', rows: [], big: null,
    lines: [line(p.newTarget ? `Новая цель: ост.${NBSP}${p.newTarget.no} · по расписанию ${p.newTarget.plan}. Прогноз для неё считается.`
      : 'Новая цель выбрана по расписанию. Прогноз для неё считается.', 'updating'),
    line(`Прошлый результат: ${[p.stop, p.plan, p.value].filter(Boolean).join(' · ')}. К новой цели не относится.`, 'muted')],
    updating: `Цель сменилась по расписанию; прогноз для новой цели считается. Прошлый результат относится к прошлой цели (возраст ${p.ageTitle}, время данных).`}),
  stale: p => ({tone: 'quiet', head: p.head, rows: [], big: {value: 'Прогноз устарел', size: 'large'},
    lines: [line(`${p.last ?? ''} ${p.got} Не использовать как текущий.`.trim(), 'muted'),
      line(`Причина: ${p.reason || 'данные устарели'}.`, 'reason')]}),
  no_forecast: p => ({tone: 'quiet', head: p.head, rows: [], big: {value: 'Прогноза для цели пока нет', size: 'medium'},
    lines: [line(`${p.no ? `Ост.${NBSP}${p.no}` : 'Цель'} · по расписанию ${p.plan ?? '—'}`),
      line(`Причина: ${p.reason || 'источник не передал прогноз'}.`, 'reason')]}),
  no_target: p => ({tone: 'quiet', head: 'Цель прогноза', rows: [], big: {value: 'Цель прогноза не выбрана', size: 'medium'},
    lines: [line(`Нет остановки по расписанию в горизонте 10–15 мин${p.dataTime ? ` от ${p.dataTime}` : ''}.`),
      line(`Причина: ${p.noTargetReason}`, 'reason')]}),
  outside_run: p => ({tone: 'quiet', head: p.head, rows: [], big: null,
    lines: [line('Прогноза не будет: цель по расписанию позже конца данных прогона.', 'strong'),
      line(`${p.no ? `Ост.${NBSP}${p.no}` : 'Цель'} · по расписанию ${p.plan ?? '—'}`)]}),
  run_over: p => ({tone: 'quiet', head: p.head, rows: [], big: {value: 'Прогон завершён', size: 'medium'},
    lines: [line('Новых прогнозов не будет до следующего прогона.'), line(p.last, 'muted')]}),
  offline: p => ({tone: 'quiet', head: p.head, rows: [], big: {value: 'Прогноз не обновляется', size: 'medium'},
    lines: [line('Backend недоступен — показано последнее известное. Не использовать как текущий.'),
      line(p.last ? `${p.last} ${p.got}`.trim() : null, 'muted')]}),
};

// ctx: {fresh, runOver, datasetEnd, dataTime, numbers: route-context stopNumbers(), targetOnMap}.
export function forecastView(v, ctx) {
  const state = forecastState(v, ctx);
  const p = parts(v, ctx);
  const view = FORECAST_STATES[state](p);
  return {state, help: p.help, fact: p.fact, updating: null, ...view, lines: view.lines.filter(Boolean)};
}
