import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunTracker, dataTimeText, progressText, runStateText, shortRunId, sourceText, speedupText} from './run.js';

test('the speed-up text comes from the run value, never a fixed factor', () => {
  assert.equal(speedupText(5), 'Ускорение ×5: 1 мин показа = 5 мин данных');
  assert.equal(speedupText(10), 'Ускорение ×10: 1 мин показа = 10 мин данных');
  assert.equal(speedupText(2.5), 'Ускорение ×2,5: 1 мин показа = 2,5 мин данных');
  assert.equal(speedupText('12'), 'Ускорение ×12: 1 мин показа = 12 мин данных');
  for (const missing of [null, undefined, '', 0, -1, 'x']) assert.equal(speedupText(missing), 'Ускорение неизвестно');
});

test('lifecycle and progress of the run', () => {
  assert.equal(runStateText({state: 'running', progress: 0.14}), 'идёт · 14 %');
  assert.equal(runStateText({state: 'completed', progress: 1}), 'завершён · 100 %');
  assert.equal(runStateText({state: 'stalled', progress: 0.5}), 'остановился: нет кадров дольше 30 с · 50 %');
  assert.equal(runStateText({state: 'failed', progress: null}), 'драйвер завершился с ошибкой');
  assert.equal(runStateText({state: 'waiting_driver', progress: 0}), 'ожидание драйвера эмулятора');
  assert.equal(runStateText({state: 'starting', progress: 0}), 'запуск: кадров ещё нет · 0 %');
  assert.equal(runStateText({state: 'paused_by_someone'}), 'paused_by_someone', 'unknown state shown as is');
  assert.equal(runStateText(null), 'нет данных о прогоне');
  assert.equal(progressText(1.2), '100 %');
  assert.equal(progressText(undefined), null);
});

test('source, data time and run ID texts', () => {
  assert.equal(sourceText('official_emulator'), 'Официальный эмулятор NDTP');
  assert.equal(sourceText('something_else'), 'something_else');
  assert.equal(dataTimeText('2026-01-06T06:47:10.189'), '06:47:10');
  assert.equal(dataTimeText(null), null);
  assert.equal(shortRunId('run-20260927T120501-3f9c'), 'run-…3f9c');
  assert.equal(shortRunId(null), null);
});

test('a different run ID resets the screen; the first snapshot and the same run do not', () => {
  const tracker = createRunTracker();
  const snap = run_id => ({run: {run_id, state: run_id ? 'running' : 'waiting_driver'}});
  assert.equal(tracker.observe(snap('run-a')), false, 'first snapshot of the page');
  assert.equal(tracker.observe(snap('run-a')), false);
  assert.equal(tracker.runId, 'run-a');
  assert.equal(tracker.observe(snap(null)), true, 'stack recreated: driver not yet registered');
  assert.equal(tracker.observe(snap(null)), false);
  assert.equal(tracker.observe(snap('run-b')), true, 'new run registered');
  assert.equal(tracker.observe(snap('run-c')), true, 'recreate straight into a new run');
  assert.equal(tracker.observe({vehicles: []}), true, 'a snapshot without run is not the same run');
  const fresh = createRunTracker();
  assert.equal(fresh.observe(snap(null)), false, 'waiting at page load is not a change');
  assert.equal(fresh.observe(snap('run-x')), true);
});
