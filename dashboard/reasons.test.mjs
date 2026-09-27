import test from 'node:test';
import assert from 'node:assert/strict';
import {reasonText} from './reasons.js';

test('Backend and ML reason codes have Russian labels', () => {
  const codes = ['ml_unreachable_or_timeout', 'ml_invalid_json', 'ml_schema_mismatch', 'ml_worker_error', 'ml_unavailable',
    'prediction_queue_full', 'unsupported_vehicle', 'unsupported_day', 'stale_or_missing_telemetry', 'no_target_in_horizon',
    'no_confident_observed_stop', 'prediction_pending', 'prediction_waiting_new_telemetry', 'prediction_behind_input',
    'prediction_aging', 'disconnected', 'stale_gps', 'invalid_gps', 'no_available_gps'];
  for (const code of codes) {
    const label = reasonText(code);
    assert.notEqual(label, code, code);
    assert.match(label, /[а-яё]/i, code);
  }
  assert.equal(reasonText('no_target_in_horizon'), 'у ТС нет плановой остановки через 10–15 мин');
  assert.equal(reasonText('ml_unreachable_or_timeout'), 'модель недоступна (нет ответа или timeout)');
  assert.equal(reasonText('prediction_pending'), 'прогноз обновляется для новой цели');
});

test('route 404 codes have Russian labels too', () => {
  assert.equal(reasonText('unknown_tr_id'), 'Backend не знает это ТС в текущем прогоне');
  assert.equal(reasonText('vehicle_not_evaluated'), 'Backend ещё не рассчитал строку этого ТС');
});

test('HTTP failures of the model keep their status code', () => {
  assert.equal(reasonText('ml_http_503'), 'модель ответила ошибкой HTTP 503');
  assert.equal(reasonText('ml_http_422'), 'модель ответила ошибкой HTTP 422');
});

test('an unknown code is shown as it is; no code is no label', () => {
  assert.equal(reasonText('brand_new_reason'), 'brand_new_reason');
  assert.equal(reasonText('ml_http_abc'), 'ml_http_abc');
  assert.equal(reasonText(null), null);
  assert.equal(reasonText(''), null);
});
