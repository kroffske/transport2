// The emulator run shown in the header: text for `snapshot.run` (source, run ID, speed-up, data
// time, lifecycle, progress) and detection of a new run, after which the screen drops the local
// state of the previous one. Backend owns the run (transport_backend run registry); nothing here
// assumes a speed-up or a run ID.

const SOURCE = {official_emulator: 'Официальный эмулятор NDTP'};
const RUN_STATE = {
  waiting_driver: 'ожидание драйвера эмулятора',
  starting: 'запуск: кадров ещё нет',
  running: 'идёт',
  completed: 'завершён',
  failed: 'драйвер завершился с ошибкой',
  stalled: 'остановился: нет кадров дольше 30 с',
};

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const number = value => Number(value).toLocaleString('ru-RU', {maximumFractionDigits: 2});

export const sourceText = source => (source ? SOURCE[source] ?? String(source) : 'источник не указан');

const knownSpeedup = speedup => finite(speedup) && Number(speedup) > 0;

// «×5 · 1 мин на экране = 5 мин данных» — N comes only from the run.
export function speedupText(speedup) {
  if (!knownSpeedup(speedup)) return 'Ускорение неизвестно';
  const n = number(speedup);
  return `×${n} · 1 мин на экране = ${n} мин данных`;
}

// «12 с», «1 мин», «1 мин 40 с»: a short duration in whole seconds.
function spanText(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} с`;
  const rest = s % 60;
  return rest ? `${Math.floor(s / 60)} мин ${rest} с` : `${s / 60} мин`;
}

// How long `dataSeconds` of data time last on the screen at the run's speed-up: «≈1 мин на экране
// при ×5» (5 data min), «≈12 с на экране при ×5» (a forecast age of 1 data min). null when the
// speed-up or the duration is unknown. Shared by the snooze menu and the card (forecast age).
export function wallEquivalentText(dataSeconds, speedup) {
  if (!knownSpeedup(speedup) || !finite(dataSeconds) || Number(dataSeconds) < 0) return null;
  return `≈${spanText(Number(dataSeconds) / Number(speedup))} на экране при ×${number(speedup)}`;
}

// A snooze option: «5 мин данных · ≈1 мин на экране при ×5».
export function snoozeOptionText(minutes, speedup) {
  const wall = wallEquivalentText(minutes * 60, speedup);
  return wall ? `${minutes} мин данных · ${wall}` : `${minutes} мин данных`;
}

// A snooze counts data time: once the run is over or its driver failed, data time no longer moves
// and a reminder would never come. Returns the reason to show, or null while snoozing works.
const DATA_STOPPED = new Set(['completed', 'failed']);
export const snoozeBlockedText = run => (DATA_STOPPED.has(run?.state) ? 'Отсрочка недоступна: время данных больше не идёт' : null);

export const progressText = progress => (finite(progress) ? `${Math.round(Math.min(1, Math.max(0, Number(progress))) * 100)} %` : null);

export function runStateText(run) {
  if (!run) return 'нет данных о прогоне';
  const state = RUN_STATE[run.state] ?? (run.state ? String(run.state) : 'состояние неизвестно');
  const progress = run.state === 'waiting_driver' ? null : progressText(run.progress);
  return progress ? `${state} · ${progress}` : state;
}

// Time of day of the dataset clock, «06:47:10».
export function dataTimeText(iso) {
  const match = typeof iso === 'string' ? /T?(\d{2}:\d{2}:\d{2})/.exec(iso) : null;
  return match ? match[1] : null;
}

// The header's data clock (Q7): large «08:30» with a small «время данных»; once the run is over,
// «Данные на 08:30:00 · прогон завершён». `title` has the full time and says whose clock it is.
export function dataClockView(run) {
  const time = dataTimeText(run?.dataset_time);
  if (!time) return {prefix: null, time: '—', label: 'время данных неизвестно', over: false, title: 'Время данных неизвестно: прогон его не сообщил.'};
  if (run.state === 'completed') {
    return {prefix: 'Данные на', time, label: 'прогон завершён', over: true, title: `Данные на ${time} · прогон завершён: время данных больше не идёт.`};
  }
  const speed = knownSpeedup(run.speedup) ? ` Идут в ${number(run.speedup)} раз быстрее реального времени.` : '';
  return {prefix: null, time: time.slice(0, 5), label: 'время данных', over: false, title: `Время данных ${time} — часы прогона эмулятора.${speed}`};
}

// Short form for the header; the full ID goes to the tooltip and diagnostics.
export const shortRunId = id => (typeof id === 'string' && id.length > 14 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id ?? null);

// Tracks the run ID of online snapshots. `observe` answers whether the snapshot starts a different
// run than the one on screen: then events, history, selection and route are dropped. The first
// snapshot of the page is not a change; a run ID that becomes null (stack recreated, driver not yet
// registered) is one.
export function createRunTracker() {
  let shown;
  return {
    observe(snapshot) {
      const id = snapshot?.run?.run_id ?? null;
      const changed = shown !== undefined && id !== shown;
      shown = id;
      return changed;
    },
    get runId() { return shown ?? null; },
  };
}
