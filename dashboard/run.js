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

// «Ускорение ×5: 1 мин показа = 5 мин данных» — N comes only from the run.
export function speedupText(speedup) {
  if (!finite(speedup) || Number(speedup) <= 0) return 'Ускорение неизвестно';
  const n = number(speedup);
  return `Ускорение ×${n}: 1 мин показа = ${n} мин данных`;
}

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
