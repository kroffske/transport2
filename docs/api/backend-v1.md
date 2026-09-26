---
title: Backend v1 — контракт локальной интеграции
type: guide
status: active
owner: transport2
updated: "2026-09-26T00:00:00Z"
---

# Backend v1

Этот контракт связывает W2 NDTP state, W3 orchestration, W4 replay и live consumer в T-4. Он фиксирует ожидаемый интерфейс; успешный запуск подтверждается отдельным readback. Полный BI/C4 сюда не входит.

## Часы и доступность

`dataset_wall` — исходные naive timestamps датасета, без утверждения географической timezone. Historical NDTP `u32 timestamp` кодируется обратимой парой `dataset_origin=2026-01-06 00:00:00`, `epoch_origin=1700000000`. Live emulator timestamp — настоящий Unix UTC; его сегодняшний день не переводится на дату обучения.

В историческом режиме один controller посылает кадры по `source_receive_time`. Перед каждым navigation кадром он задаёт точное receive-время через `POST /v1/replay/clock` и ждёт подтверждения обработанного кадра через `GET /v1/ingest`. Только после подтверждения задаётся следующее время. Backend не читает будущие строки traffic. История для прогноза T включает только `event_time ≤ T` и `receive_time ≤ T`. `received_at_utc` хранит время фактического приёма хостом отдельно от `dataset_wall`.

`POST /v1/replay/clock` доступен только при `SOURCE_CLOCK=dataset_wall` и принимает `{ "receive_time": "2026-01-06T03:35:00", "unit_id": 123, "request_id": 2 }`. Он отвергает движение времени назад, одновременный незавершённый шаг и неизвестный unit. Ответ: `{ "processed_revision": 12 }`. После этого controller шлёт ровно один NDTP frame с данным unit/request ID. `GET /v1/ingest?since_revision=12` возвращает `processed_revision`, `accepted_revision`, ограниченный список `outcomes` с `unit_id`, `request_id`, `session_id`, `frame_id`, `outcome`, флаг `outcome_gap`, а также counters и `queue_depth`. Успех шага требует исхода своего кадра `accepted` либо ожидаемого `duplicate`; `outcome_gap`, timeout и drop — ошибка replay, а не пропущенный успех.

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

Источник: [T-4](../../.tasks/T-4-2026-09-25-backend-dashboard-infra/task.md), [NDTP spec](../../data/docs/Emulator-and-Telematic-Packets-Specification.md), `transport_ml.data.TRAFFIC_COLUMNS`, W1/W2 commits `b67af516`/`e009861c`.
