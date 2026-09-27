// Russian labels for the reason codes of Backend and ML: a vehicle row's `reason`
// (transport_backend/state.py and orchestration.py, including ML failures and the ML service's own
// `reason`) and the `reason` of a consumer /api/route 404. An unknown code is shown as it is,
// never guessed.

const LABELS = {
  // Telemetry (TelemetryState.snapshot)
  no_available_gps: 'нет позиции GPS',
  invalid_gps: 'последняя позиция GPS недостоверна',
  stale_gps: 'GPS устарел',
  disconnected: 'устройство отключено',
  // Timetable and observed stops (Orchestrator._vehicle)
  no_target_in_horizon: 'у ТС нет плановой остановки через 10–15 мин',
  no_confident_observed_stop: 'не определена пройденная остановка — нет факта опоздания',
  unsupported_day: 'день не поддерживается моделью',
  // Prediction freshness
  prediction_pending: 'прогноз обновляется для новой цели',
  prediction_held_previous_target: 'прогноз прошлой цели, новая цель считается',
  prediction_waiting_new_telemetry: 'ожидается новая телеметрия для прогноза',
  prediction_behind_input: 'прогноз отстаёт от телеметрии', // legacy: replaced by `prediction_updating`
  prediction_aging: 'прогноз устарел',
  prediction_queue_full: 'очередь прогнозов переполнена',
  // Model call (ModelClient / worker)
  ml_unreachable_or_timeout: 'модель недоступна (нет ответа или timeout)',
  ml_invalid_json: 'модель вернула некорректный JSON',
  ml_schema_mismatch: 'ответ модели не соответствует контракту',
  ml_worker_error: 'ошибка обработчика прогнозов Backend',
  ml_unavailable: 'модель не дала прогноз',
  // ML service applicability
  unsupported_vehicle: 'модель не поддерживает это ТС',
  stale_or_missing_telemetry: 'для модели нет свежей телеметрии',
  // Route context (consumer /api/route 404)
  unknown_tr_id: 'Backend не знает это ТС в текущем прогоне',
  vehicle_not_evaluated: 'Backend ещё не рассчитал строку этого ТС',
};

// Label for one code; null/empty → null so the caller decides what "no reason" means.
export function reasonText(code) {
  if (code === null || code === undefined || code === '') return null;
  const key = String(code);
  if (LABELS[key]) return LABELS[key];
  const http = /^ml_http_(\d{3})$/.exec(key);
  if (http) return `модель ответила ошибкой HTTP ${http[1]}`;
  return key;
}
