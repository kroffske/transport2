---
title: Backend v1 — контракт локальной интеграции
type: guide
status: active
owner: transport2
updated: "2026-09-26T00:00:00Z"
---

# Backend v1

Этот контракт связывает W2 NDTP state, W3 orchestration, W4 replay и live consumer в T-4. Он фиксирует реализованный интерфейс; успешный запуск подтверждается отдельным readback. Полный BI/C4 сюда не входит.

## Часы и доступность

`dataset_wall` — исходные naive timestamps датасета, без утверждения географической timezone. Historical NDTP `u32 timestamp` кодируется обратимой парой `dataset_origin=2026-01-06 00:00:00`, `epoch_origin=1700000000`. Live emulator timestamp — настоящий Unix UTC; его сегодняшний день не переводится на дату обучения.

В историческом режиме один controller посылает кадры по `source_receive_time`. Перед каждым navigation кадром он задаёт точное receive-время через `POST /v1/replay/clock` и ждёт подтверждения обработанного кадра через `GET /v1/ingest`. Только после подтверждения задаётся следующее время. Backend не читает будущие строки traffic. История для прогноза T включает только `event_time ≤ T` и `receive_time ≤ T`. `received_at_utc` хранит время фактического приёма хостом отдельно от `dataset_wall`.

Sender до TCP отправки сверяет `/ready.source_clock` и `/ready.clock_mapping={dataset_origin,epoch_origin}` со своими origins. После handshake он получает единственную активную `session_id` своего unit из ingest readback; неоднозначность соединений означает отказ.

`POST /v1/replay/clock` доступен только при `SOURCE_CLOCK=dataset_wall` и принимает `{ "receive_time": "2026-01-06T03:35:00", "unit_id": 123, "request_id": 2, "session_id": "active-tcp-session" }`. Он отвергает движение времени назад, одновременный незавершённый шаг, неизвестный unit и чужую/неоднозначную session. Ответ: `{ "processed_revision": 12 }`. После этого controller шлёт ровно один NDTP frame с данным unit/request/session. `GET /v1/ingest?since_revision=12` возвращает `processed_revision`, `accepted_revision`, ограниченный список `outcomes` с `unit_id`, `request_id`, `session_id`, `frame_id`, `outcome`, флаг `outcome_gap`, а также counters и `queue_depth`. Успех шага требует исхода своего кадра `accepted` либо ожидаемого `duplicate`; `outcome_gap`, timeout и drop — ошибка replay, а не пропущенный успех. Исход другой session с тем же request ID не подтверждает шаг.

## Снимок для consumer

`GET /v1/vehicles` возвращает JSON:

```json
{
  "schema_version": "transport.backend-vehicles.v1",
  "revision": 12,
  "source_clock": "dataset_wall",
  "clock_time": "2026-01-06T03:35:00",
  "vehicles": [
    {
      "tr_id": "131672",
      "unit_id": 123,
      "lon": 37.6,
      "lat": 55.7,
      "location_valid": true,
      "event_time": "2026-01-06T03:34:55",
      "receive_time": "2026-01-06T03:35:00",
      "gps_age_s": 5.0,
      "connected": true,
      "target_stop_id": "53700172828",
      "target_time_begin": "2026-01-06T03:50:00",
      "cur_dev_s": 95.0,
      "cur_dev_source": "computed_stop",
      "prediction_s": 120.0,
      "predicted_arrival": "2026-01-06T03:52:00",
      "model_version": "canonical_rmse_d8",
      "artifact_sha256": "dc33437108c3e036089450c9b98771dacd014246fbb91d0df2a89d0c8e247122",
      "status": "normal",
      "reason": null,
      "last_success_at": "2026-01-06T03:35:00",
      "revision": 12
    }
  ],
  "ingest": { "accepted": 12, "dropped": 0, "errors": 0, "queue_depth": 0 }
}
```

Отсутствующие значения — JSON `null`, не ноль. `target_stop_id` — ID планового прибытия (`tt_action_item_id`). Долгота/широта — WGS84 degrees, с флагом валидности. `revision` меняется при принятом новом состоянии или изменении статуса; consumer использует его для live readback. `status` сообщает `normal`, `degraded` или `unavailable`, а `reason` объясняет отсутствие свежего прогноза. При сбое ML либо NDTP последнее число может оставаться только вместе с `degraded`, возрастом и `last_success_at`; его нельзя выдавать за свежий прогноз.

Backend отправляет ML только восемь разрешённых полей telemetry: `tr_id`, `event_time`, `receive_time`, `location_valid`, `lon`, `lat`, `speed`, `heading`. Внутренние `unit_id`, `packet_id`, `session_id`, `source_clock` и host clock в строгий `POST /v1/predict` не передаются. План ограничен `tt_action_item_id`, `tr_id`, `time_begin`, `geom`. Фактическое расписание не входит в runtime inference.

Для измерений row дополнительно содержит `input_frame_id`, `input_request_id`, `input_session_id`, `input_received_at_utc` и `published_unix_ns`. Новый прогноз сохраняет `prediction_input_frame_id` и `prediction_published_unix_ns`; при сбое эти поля остаются у прежнего success. Publication timestamps относятся к реальному Unix wall clock, а не к dataset/replay time. Monotonic clocks разных host/container domains напрямую не вычитаются; измеритель проверяет wall-clock alignment и отдельно хранит локальные monotonic интервалы.

Каждый outcome также сохраняет `received_at_utc` фактического приёма полного кадра. Sender trace получает его вместе с `frame_id`, поэтому wall receipt сопоставляется с правильным prediction input, даже когда vehicle snapshot уже показывает более новый кадр.

Источник: [T-4](../../.tasks/T-4-2026-09-25-backend-dashboard-infra/task.md), [NDTP spec](../../data/docs/Emulator-and-Telematic-Packets-Specification.md), `transport_ml.data.TRAFFIC_COLUMNS`, W1/W2 commits `b67af516`/`e009861c`.

## Ограниченная обработка ML и наблюдений остановки

HTTP inference выполняет отдельный worker. Одновременно активен один ML request; очередь хранит до `ML_QUEUE_LIMIT=32` автомобилей и объединяет ожидающие задания одного автомобиля до последнего входа. Каждое задание сохраняет свой T, target, frame identity и past-only request до помещения в очередь. Ingest acknowledgment и snapshot не ждут ML. Completion для изменившегося target отбрасывается; прогноз по более старому доступному контексту текущего target остаётся `degraded` с причиной `prediction_behind_input`. Pending обозначается `prediction_pending`.

`processing` в `/v1/ingest` и `/v1/vehicles` отдаёт `ml_enqueued`, `ml_started`, `ml_completed`, `ml_succeeded`, `ml_failed`, `ml_unavailable`, `ml_coalesced`, `ml_dropped_queue_full`, `ml_discarded_obsolete`, `ml_canceled_on_close`, `ml_max_queue_depth`, `ml_queue_depth`, `ml_queue_limit`, `ml_active_jobs` и bounded detector counters. Coalescing не является потерей входной telemetry, но пропускает промежуточное ML задание и должно учитываться в измерениях.

Первое наблюдение остановки хранится отдельно от скользящей 900-секундной ML history, максимум одно на известное плановое прибытие. Поэтому продолжительная стоянка не сдвигает уже наблюдённое время прибытия. Late evidence не меняет первое наблюдение и не обращает принятую последовательность остановок. Это приближённый GPS detector, а не фактическое расписание.

Row дополнительно отдаёт `input_context_revision` и `prediction_context_revision`. Версия сравнивает весь доступный bounded history, 900-секундный ML input, current deviation и target. Пакет с отрицательным receive lag, ставший доступным позже своего receive time, меняет эту версию и вызывает новый captured request; прежний completion не может получить `normal` или создать alert. `input_frame_id` остаётся корреляцией последнего receive frame и сам по себе не доказывает неизменность контекста.

Same-event correction, отзывающая GPS evidence первого наблюдения остановки, снимает будущую уверенность detector до нового подтверждённого наблюдения. Простое вытеснение старой telemetry из bounded history этого не делает. Counters включают `stop_observations_retracted`, `context_history_frame_count` и `context_history_frame_limit`.
