---
title: Backend v1 — контракт локальной интеграции
type: guide
status: active
owner: transport2
updated: "2026-09-27T00:00:00Z"
---

# Backend v1

Этот контракт связывает NDTP state, orchestration, прогон официального эмулятора (T-7), replay для тестов и live consumer. Он фиксирует реализованный интерфейс; успешный запуск подтверждается отдельным readback. Полный BI/C4 сюда не входит.

## Прогон официального эмулятора (`SOURCE_CLOCK=simulation`)

Это режим демо (compose по умолчанию). Часы и прогон принадлежат одному владельцу — `transport_backend/run.py` (`RunRegistry`); NDTP-приём, tick прогнозов, `/ready`, `/v1/ingest`, `/v1/vehicles` и `/v1/route` читают mapping и время только через него.

- Backend стартует в состоянии `waiting_driver` **без** clock mapping: `clock_mapping=null`, snapshot отдаёт `run.state="waiting_driver"` и `vehicles=[]`, `Schedule` не вызывается. Handshake NDTP принимается (нет шторма переподключений), навигационные кадры отклоняются и считаются в `counters.rejected_no_run` (и в `dropped`).
- Драйвер `scripts/emulator_driver.py` регистрирует единственный на процесс прогон `POST /v1/run` **до** первого `POST /api/config` эмулятора:

```json
{"dataset_start": "2026-01-06T06:30:00", "dataset_end": "2026-01-06T08:30:00",
 "speedup": 5, "post_period_s": 2, "units": [786201, 893159],
 "path": {"786201": [[37.43, 55.80], [37.431, 55.801]]}, "source": "official_emulator"}
```

  Ответ `201`: `{"run_id": "run-20260927T124517-d90b", "clock_mapping": {"epoch_origin": 1790513117, "dataset_origin": "2026-01-06T06:30:00", "rate": 5}, "run": {...}}`. `run_id` генерирует Backend. `epoch_origin` — целая Unix-секунда регистрации (floor), `dataset_origin=dataset_start`, `rate=speedup`: время данных = `dataset_origin + (unix − epoch_origin) × rate`. Повторная регистрация в том же процессе → `409 {"detail": "run_already_registered", "run_id": "run-…"}` при любых параметрах (конфликт проверяется до проверки плана); вне `simulation` → `409 {"detail": "run_requires_simulation_clock", "run_id": null}`. Невалидное окно (`end ≤ start`), `speedup` вне `[1, 100]`, `post_period_s` вне `[1, 5]` с (при большем периоде heartbeat драйвера не уложится в 10 с, а здоровый прогон выглядел бы `stalled`), неизвестный или повторный `unit_id`, `path` вне `units` или координаты вне WGS84 → `422`. `path` — план подачи драйвера (только valid GPS окна), display-only: это «путь по GPS прогона», не официальная трасса и не вход модели.
- `ClockMapping.rate` (целое ≥ 1): при `rate ≠ 1` одна секунда NDTP `timestamp` (её ставит эмулятор) — это `rate` секунд данных, поэтому обратное `to_epoch` запрещено.
- Heartbeat и финал: `POST /v1/run/{run_id}/state` c `{"state": "running" | "completed" | "failed", "thinned_ratio": 0.28, "repeat_ratio": 0.27, "counters": {...}, "reason": null}`; драйвер шлёт `running` не реже раза в 10 с. `thinned_ratio` — доля точек окна, не отправленных из-за прореживания (за период уходит последняя точка ТС); `repeat_ratio` — доля повторов последней точки среди отправленных. Неизвестный `run_id` → `404`; после `completed`/`failed` → `409 run_already_finished`.
- Lifecycle (`run.state`): `waiting_driver → starting` (зарегистрирован, принятых кадров нет) `→ running` (есть принятый кадр не старше `RUN_STALL_AFTER_S=30` с wall) `→ completed | failed` (сообщает драйвер, финальны) или `stalled` (Backend ставит сам: нет принятых кадров > 30 с wall; также из `starting`). Если кадры снова пошли, `stalled → running`.
- Сброс = пересоздание процесса (recreate контейнера); endpoint сброса нет.
- Прогнозы не зависят от опроса: собственный tick `Orchestrator` (`PREDICT_TICK_S=1` с wall; только в `simulation` — replay двигается по одному подтверждённому кадру) оценивает ТС прогона тем же кодом, что и snapshot, под одним lock вместе с чтением часов. `PREDICT_INTERVAL_S=60` остаётся во времени данных.
- Переподключения: эмулятор рвёт и заново открывает TCP всех ТС на каждый `POST /api/config`. ТС считается подключённым, если есть активная сессия или последняя закрылась меньше `RECONNECT_GRACE_S=3` с wall назад; `connections/disconnects` считают все реальные сессии.

`GET /ready` → `{"status": "ready", "source_clock", "ndtp_host", "ndtp_port", "clock_mapping": {"epoch_origin", "dataset_origin", "rate"} | null, "run": {...} | null}`. `/v1/ingest` дополнительно отдаёт `clock_mapping` и `run`. Поле `scenario_label` удалено; источник — `run.source="official_emulator"`.

Конверт `run` (в `/ready`, `/v1/ingest`, `/v1/vehicles`; `null` вне `simulation`):

```json
{"run_id": "run-20260927T124517-d90b", "state": "running", "source": "official_emulator",
 "speedup": 5, "post_period_s": 2.0,
 "dataset_start": "2026-01-06T06:30:00", "dataset_end": "2026-01-06T08:30:00",
 "dataset_time": "2026-01-06T06:47:10", "progress": 0.1431,
 "thinned_ratio": 0.2822, "repeat_ratio": 0.2687,
 "vehicle_count": 16, "accepted_frames": 201, "last_frame_age_s": 1.07,
 "registered_at_utc": "2026-09-27T12:45:17.804080",
 "driver": {"state": "running", "reason": null, "counters": {"points_sent": 117, "...": 0},
            "reported_at_utc": "2026-09-27T12:45:39.939403"}}
```

До регистрации: `run_id=null`, `state="waiting_driver"`, числовые поля `null`. `progress = (dataset_time − dataset_start)/(dataset_end − dataset_start)`, ограничен `[0, 1]`. `run.dataset_time` — отсчёт тех же часов, что `clock_time` snapshot, но не позже `dataset_end`: часы источника после окна идут дальше (строки ТС честно стареют), а время прогона останавливается на конце окна. `thinned_ratio/repeat_ratio` — `null`, пока драйвер не прислал heartbeat.

## Часы и доступность (replay для тестов)

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
  "source_clock": "simulation",
  "clock_mapping": {"epoch_origin": 1790513117, "dataset_origin": "2026-01-06T06:30:00", "rate": 5},
  "clock_time": "2026-01-06T06:47:10",
  "run": {"run_id": "run-20260927T124517-d90b", "state": "running", "...": "см. конверт run"},
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
      "target_lon": 37.42318933,
      "target_lat": 55.7338932,
      "planned_target_stop_id": "53700172828",
      "cur_dev_s": 95.0,
      "cur_dev_source": "computed_stop",
      "prediction_s": 120.0,
      "predicted_arrival": "2026-01-06T03:52:00",
      "model_version": "canonical_rmse_d8",
      "artifact_sha256": "dc33437108c3e036089450c9b98771dacd014246fbb91d0df2a89d0c8e247122",
      "prediction_state": "fresh",
      "prediction_held_from_target": null,
      "status": "normal",
      "reason": null,
      "prediction_pending": false,
      "prediction_updating": true,
      "heading": 213,
      "gps_suspect": null,
      "gps_suspect_text": null,
      "route_offset_m": 20,
      "off_route": false,
      "route_not_started": false,
      "route_key": "R-69ee05",
      "route_label": "ул. Ивана Франко — Ярцевская ул.",
      "last_success_at": "2026-01-06T03:35:00",
      "revision": 12
    }
  ],
  "ingest": { "accepted": 12, "dropped": 0, "errors": 0, "rejected_no_run": 0, "queue_depth": 0 }
}
```

**Маршрут (T-14).** Номера маршрута в данных нет; Backend выводит его из плана (`transport_backend/route_catalog.py`). `route_key` — `"R-"` + первые 6 hex SHA-1 от отсортированного множества `geom` плановых остановок наряда: наряды с одинаковым набором остановок (в любом направлении) — один маршрут; ключ стабилен для одного плана. `route_label` — улицы двух самых удалённых друг от друга остановок (конечные) из `building_address` без номера дома; остановка без адреса берёт ближайший адрес в 300 м, иначе конец не называется; без адресов — `"—"`. У ТС без наряда в плане оба поля `null`. В демо-плане validate 13 нарядов дают 13 разных маршрутов (в train 39 нарядов → 13 маршрутов).

**Сверка с маршрутом наряда и направление (W11).** Маршрут ТС — плановая последовательность остановок его наряда `tr_id` (`schedule_plan`, по времени); `route_id` в данных нет.

- `route_offset_m` — расстояние в метрах (округлено до 10) от последней валидной позиции до ближайшего сегмента линии наряда за день: **все** плановые остановки по времени, соединённые формой дороги из `data/routes/route_shapes.json` (см. «Форма маршрута по дорогам»), для пар без формы — прямым отрезком (остановки без конечных координат пропускаются; линия строится один раз при старте). Это пространственная сверка «ездит ли ТС там, где проходит его наряд», а не сверка с плановой позицией во времени.
- `off_route` — гистерезис: `true`, когда расстояние `> OFF_ROUTE_M=400`; обратно `false` только при `< OFF_ROUTE_CLEAR_M=250` (оба — env; состояние на `tr_id` под lock orchestrator). Между порогами значение не меняется.
- Оба поля `null` (не `false`), если в плане наряда меньше двух остановок с координатами или у ТС нет ни одной валидной позиции.
- `route_not_started` — `true`, если у наряда нет ни одной плановой остановки в окне отображения `[сейчас − 15 мин, сейчас + 45 мин]` и первая остановка дня позже текущего времени («наряд ещё не начался»); `false` иначе; `null` без плана.
- `heading` — курс (целые градусы 0…360) последнего валидного кадра со скоростью `> 3` км/ч в пределах последних 120 с данных; иначе `null` (стоит или давно нет движения).

Офлайн-проверка той же функцией на validate 06:30–08:30 воспроизводит `artifacts/offroute-distribution.txt` (колонка A): доля точек `> 400 м` — 130072 100 %, 122613 49 %, 122658 26 %, 122048 4 %, остальные 0 %.

`vehicles` — только ТС текущего прогона (`units` регистрации); в `dataset_wall`/`utc` — все ТС реестра. `target_lon/target_lat` — координаты плановой цели (`null` без цели или без валидной координаты). `clock_time=null` до регистрации прогона.

**Подсказка о GPS: `gps_suspect`, `gps_suspect_text`.** Это только подсказка: `status`, `reason`, цель и прогноз она не меняет. Значение `null` или первое совпадение по порядку:

| `gps_suspect` | условие (время данных) | `gps_suspect_text` |
|---|---|---|
| `no_fix` | на связи, последний кадр не старше 120 с, но валидного фикса нет больше 600 с | «Датчик на связи, но не даёт валидных координат» |
| `out_of_map` | валидная позиция вне bbox карты `37.25,55.50,38.00,56.00` | «Координаты вне области карты» |
| `jump` | за последние 300 с есть два соседних валидных фикса дальше 500 м друг от друга и быстрее 50 м/с (180 км/ч) | «Скачок координат: быстрее 180 км/ч между соседними точками» |
| `far_from_route` | `off_route=true` | «Далеко от маршрута наряда (больше 400 м)» |
| `no_plan` | у `tr_id` нет наряда в плане: нет маршрута, цели и прогноза | «Нет наряда в плане: маршрут и прогноз не строятся» |

Пороги подобраны по `validate`, разбор — в `.tasks/T-7-2026-09-27-ml/artifacts/gps-131542.md`. Флага «стоит на месте» нет: плановые ТС стоят в отстое до 4 ч. Текст без чисел, поэтому `revision` меняется только при смене вида подсказки. Ручная отметка «неисправен GPS» — действие диспетчера в UI; Backend её не хранит.

**Свежесть прогноза в живом потоке.** Успешный прогноз относится к цели, для которой его посчитали. Если последний успех относится к текущей цели, его `quality="normal"` и возраст во времени данных `≤ PREDICTION_FRESH_S = 1.5 × PREDICT_INTERVAL_S` (90 с при 60 с), строка остаётся `status="normal"` даже при более новых кадрах; тогда `prediction_updating=true` (есть вход новее прогноза или задача в работе). Возраст больше порога → `degraded`, `prediction_aging`. Прежняя причина `prediction_behind_input` больше не выдаётся: её заменил флаг `prediction_updating`. Alert создаётся только прогнозом, посчитанным на полном текущем контексте (`normal` и `prediction_updating=false`).

**Смена цели: удержание прошлой пары (W14).** Когда цель плана меняется, задание для новой цели ставится в очередь сразу (не ждёт `PREDICT_INTERVAL_S`) и первым среди других ТС. Пока его ответа нет, но не дольше `PREDICTION_HOLD_S=180` (env, секунды времени данных, отсчёт от первой строки с удержанием этого успеха; `0` выключает), строка показывает прошлый прогноз **целой парой**: `target_stop_id`, `target_time_begin`, `target_lon/lat` — прошлой цели, `prediction_s`, `predicted_arrival`, `model_version`, `artifact_sha256`, `last_success_at`, `prediction_*` — её прогноза. Новая цель с прошлым значением никогда не смешивается. Поля строки:

| поле | значение |
|---|---|
| `prediction_state` | `"fresh"` — показан прогноз для текущей цели плана (его возраст и новизна — в `status`/`reason`/`prediction_updating`); `"updating"` — показана удержанная пара прошлой цели, прогноз для новой считается; `"none"` — прогноза нет (`prediction_s=null`) |
| `prediction_held_from_target` | при `"updating"` — `stop_id` удержанной цели (равен `target_stop_id`), иначе `null` |
| `planned_target_stop_id` | текущая цель плана всегда; отличается от `target_stop_id` только при удержании; `null`, если цели нет |

При удержании: `status="degraded"`, `reason="prediction_held_previous_target"` (или причина деградации GPS/ошибки ML, если она есть), `prediction_updating=true`, `alert=null`. Ответ для новой цели заменяет пару (`"fresh"`). Если за `PREDICTION_HOLD_S` ответа нет — `"none"`, `target_stop_id` = новая цель, `prediction_s=null`, `reason="prediction_pending"` (задание в работе) или `"prediction_waiting_new_telemetry"`. Без цели плана (`no_target_in_horizon`, конец плана) ничего не удерживается. Удержание меняет `revision` только на переходах (начало, конец, замена), не на каждом тике. `/v1/route/{tr_id}` берёт цель из той же строки: при удержании роль `target` — у прошлой цели; там же отдаются `prediction_state`, `prediction_held_from_target`, `planned_target_stop_id`.

Отсутствующие значения — JSON `null`, не ноль. `target_stop_id` — ID планового прибытия (`tt_action_item_id`). Долгота/широта — WGS84 degrees, с флагом валидности. `revision` меняется при принятом новом состоянии или изменении статуса; consumer использует его для live readback. `status` сообщает `normal`, `degraded` или `unavailable`, а `reason` объясняет отсутствие свежего прогноза. При сбое ML либо NDTP последнее число может оставаться только вместе с `degraded`, возрастом и `last_success_at`; его нельзя выдавать за свежий прогноз.

Backend отправляет ML только восемь разрешённых полей telemetry: `tr_id`, `event_time`, `receive_time`, `location_valid`, `lon`, `lat`, `speed`, `heading`. Внутренние `unit_id`, `packet_id`, `session_id`, `source_clock` и host clock в строгий `POST /v1/predict` не передаются. План ограничен `tt_action_item_id`, `tr_id`, `time_begin`, `geom`. Фактическое расписание не входит в runtime inference.

Для измерений row дополнительно содержит `input_frame_id`, `input_request_id`, `input_session_id`, `input_received_at_utc` и `published_unix_ns`. Новый прогноз сохраняет `prediction_input_frame_id` и `prediction_published_unix_ns`; при сбое эти поля остаются у прежнего success. Publication timestamps относятся к реальному Unix wall clock, а не к dataset/replay time. Monotonic clocks разных host/container domains напрямую не вычитаются; измеритель проверяет wall-clock alignment и отдельно хранит локальные monotonic интервалы.

Каждый outcome также сохраняет `received_at_utc` фактического приёма полного кадра. Sender trace получает его вместе с `frame_id`, поэтому wall receipt сопоставляется с правильным prediction input, даже когда vehicle snapshot уже показывает более новый кадр.

Источник: [T-4](../../.tasks/_archive/T-4-2026-09-25-backend-dashboard-infra/task.md), [NDTP spec](../../data/docs/Emulator-and-Telematic-Packets-Specification.md), `transport_ml.data.TRAFFIC_COLUMNS`, W1/W2 commits `b67af516`/`e009861c`.

## Ограниченная обработка ML и наблюдений остановки

HTTP inference выполняет отдельный worker. Одновременно активен один ML request; очередь хранит до `ML_QUEUE_LIMIT=32` автомобилей и объединяет ожидающие задания одного автомобиля до последнего входа. Каждое задание сохраняет свой T, target, frame identity и past-only request до помещения в очередь. Ingest acknowledgment и snapshot не ждут ML. Completion для изменившегося target отбрасывается; прогноз по более старому доступному контексту текущего target помечается `prediction_updating=true` (см. «Свежесть прогноза»). Pending обозначается `prediction_pending`.

`processing` в `/v1/ingest` и `/v1/vehicles` отдаёт `ml_enqueued`, `ml_started`, `ml_completed`, `ml_succeeded`, `ml_failed`, `ml_unavailable`, `ml_coalesced`, `ml_dropped_queue_full`, `ml_discarded_obsolete`, `ml_canceled_on_close`, `ml_max_queue_depth`, `ml_queue_depth`, `ml_queue_limit`, `ml_active_jobs` и bounded detector counters. Coalescing не является потерей входной telemetry, но пропускает промежуточное ML задание и должно учитываться в измерениях.

Первое наблюдение остановки хранится отдельно от скользящей 900-секундной ML history, максимум одно на известное плановое прибытие. Поэтому продолжительная стоянка не сдвигает уже наблюдённое время прибытия. Late evidence не меняет первое наблюдение и не обращает принятую последовательность остановок. Это приближённый GPS detector, а не фактическое расписание.

Row дополнительно отдаёт `input_context_revision` и `prediction_context_revision`. Версия сравнивает весь доступный bounded history, 900-секундный ML input, current deviation и target. Пакет с отрицательным receive lag, ставший доступным позже своего receive time, меняет эту версию и вызывает новый captured request; прежний completion не создаёт alert и показывается с `prediction_updating=true`. `input_frame_id` остаётся корреляцией последнего receive frame и сам по себе не доказывает неизменность контекста.

Same-event correction, отзывающая GPS evidence первого наблюдения остановки, снимает будущую уверенность detector до нового подтверждённого наблюдения. Простое вытеснение старой telemetry из bounded history этого не делает. Counters включают `stop_observations_retracted`, `context_history_frame_count` и `context_history_frame_limit`.

## Маршрутный контекст `GET /v1/route/{tr_id}`

Отдельная ручка (не внутри snapshot). Цель, `cur_dev_s`, `prediction_s`, `prediction_updating`, `model_version`, `artifact_sha256` и `vehicle_revision` берутся из последней посчитанной строки ТС — той же, что отдаёт `/v1/vehicles` (сверка по `vehicle_revision == row.revision`); `Schedule` здесь не пересчитывается, окно считается от момента расчёта этой строки (`clock_time`).

```json
{"run_id": "run-20260927T124517-d90b", "tr_id": "133300", "unit_id": 1076894,
 "vehicle_revision": 564, "clock_time": "2026-01-06T06:33:05.996345",
 "window_start": "2026-01-06T06:28:05.996345", "window_end": "2026-01-06T07:00:00",
 "path": [[37.411995, 55.734196], "..."],
 "passed": [[37.423573, 55.733715, "06:32:50"], "..."],
 "stops": [{"stop_id": "53700641295", "time": "06:32:00", "lon": 37.41915975, "lat": 55.733633, "role": "passed"},
           {"stop_id": "53700641290", "time": "06:34:00", "lon": 37.42385401, "lat": 55.73234446, "role": "before_target"},
           {"stop_id": "53700641292", "time": "06:45:00", "lon": 37.42318933, "lat": 55.7338932, "role": "target"},
           {"stop_id": "53700641287", "time": "06:46:00", "lon": 37.41785937, "lat": 55.73389267, "role": "after_target"}],
 "stops_dropped": 0, "stops_truncated": 0,
 "target_stop_id": "53700641292", "target_time_begin": "2026-01-06T06:45:00",
 "cur_dev_s": -40.0, "prediction_s": 30.46, "prediction_updating": true,
 "prediction_state": "fresh", "prediction_held_from_target": null,
 "planned_target_stop_id": "53700641292",
 "model_version": "canonical_rmse_d8", "artifact_sha256": "dc33…7122",
 "route_line": {"line": [[37.41266478, 55.73372104], "..."], "line_shape": "road",
                "passed": [[37.41266478, 55.73372104], [37.4162, 55.7336]],
                "ahead": [[37.4162, 55.7336], [37.41915975, 55.733633], "..."],
                "split": [37.4162, 55.7336], "split_reason": "on_route",
                "nearest": [37.4162, 55.7336], "off_route": false, "route_offset_m": 10}}
```

- `path` — manifest драйвера из регистрации (display-only, «путь по GPS прогона»).
- `passed` — только valid GPS из истории Backend этого процесса (кадры до регистрации отклонены, поэтому это только текущий прогон); время — `event_time` `HH:MM:SS`. Повтор точки драйвером даёт отдельную запись с теми же координатами.
- `stops` — плановые прибытия `tr_id` по времени в окне `[сейчас − 5 мин, цель + 15 мин]`, без цели — `[сейчас − 5 мин, сейчас + 30 мин]`; `time` — плановое `HH:MM:SS`. Не более 40: при переполнении отбрасываются самые ранние, цель всегда остаётся; их число — `stops_truncated`. Остановка без конечной координаты или вне bbox карты (`37.25,55.50,38.00,56.00`, как в `consumer/map/manifest.json`) исключается и считается в `stops_dropped`.
- `role`: `target` — цель модели; `passed` — детектор уже наблюдал это прибытие или `план + cur_dev_s < сейчас` (без `cur_dev_s` — `план < сейчас`); остальные до цели — `before_target`, после — `after_target`; без цели — `planned`. Значения прогноза для остановок кроме цели Backend не выдумывает: это допущение UI.
- `route_line` — точка ТС на маршруте (слои выбранного ТС): `line` — линия окна отображения, та же, что `line` в `/v1/routes` (остановки окна `[clock_time − 15 мин, clock_time + 45 мин]` в bbox, между ними — форма дороги). `split` — проекция последней валидной позиции на форму дороги ближайшего участка «остановка → остановка» окна, у которого плановое время (по остановкам-якорям) пересекается с `[clock_time − cur_dev_s − 10 мин, clock_time − cur_dev_s + 20 мин]` (без `cur_dev_s` сдвига нет): опаздывающее ТС находится там, где план был раньше, а на маршрутах туда-обратно не «прилипает» к обратному рейсу. При равном расстоянии (±1 м, та же улица в обе стороны) выигрывает сегмент, чья середина по плану ближе к `clock_time − cur_dev_s`. `passed` = `line` от начала окна до `split`, `ahead` = от `split` до конца окна; `split` входит в оба. `split_reason`:
  - `on_route` — деление есть (небольшое отклонение GPS от линии при `off_route=false` — норма);
  - `off_route` — `off_route=true`: `passed=[]`, `ahead=[]`, `split=null`; UI рисует `line` тускло и выноску от ТС к `nearest`;
  - `no_segment` — в `line` нет сегмента в этом интервале (в т.ч. пустое окно): деления нет;
  - `no_position` — нет валидной позиции.
  `nearest` — ближайшая точка **всей** линии наряда за день (та же линия, что для `route_offset_m`), поэтому выноска есть и при пустом окне (наряд 130072 начинается в 20:25); `null` только без плана (< 2 остановок) или без позиции. `off_route` и `route_offset_m` — из той же строки ТС (совпадают со snapshot); длина выноски ТС→`nearest` = `route_offset_m` ± 10 м.
- `404 {"detail": "unknown_tr_id"}` — ТС нет в текущем прогоне (или прогон не зарегистрирован); `404 {"detail": "vehicle_not_evaluated"}` — строка ещё не посчитана (tick исправит за ≤ 1 с).

## Маршруты всех ТС `GET /v1/routes`

Лёгкая обзорная ручка (UI опрашивает ≈ раз в 10 с). Окно по плановому времени `[сейчас − 15 мин, сейчас + 45 мин]` (включительно) — одно для обзора и выбранного ТС.

```json
{"run_id": "run-20260927T140339-d1ec", "clock_time": "2026-01-06T06:37:05.602605",
 "window_start": "2026-01-06T06:22:05.602605", "window_end": "2026-01-06T07:22:05.602605",
 "routes": [{"tr_id": "133300", "unit_id": 1076894,
             "line": [[37.41266478, 55.73372104], "..."], "line_times": ["06:30:00", null, "..."],
             "line_shape": "road",
             "off_route": false, "route_offset_m": 0, "route_not_started": false},
            {"tr_id": "130072", "unit_id": 896671, "line": [], "line_times": [], "line_shape": "road",
             "off_route": true, "route_offset_m": 3440, "route_not_started": true}],
 "catalog": [{"route_key": "R-69ee05", "route_label": "ул. Ивана Франко — Ярцевская ул.", "tr_ids": ["133300"]}, "..."]}
```

- `routes` — все ТС текущего прогона (вне `simulation` — весь реестр, `run_id=null`); до регистрации прогона `routes=[]` и все поля `null`, кроме `catalog`. У каждого элемента есть `route_key`/`route_label`, как в `/v1/vehicles`.
- `catalog` — все маршруты плана (не только прогона) с их нарядами, по `route_label`: список выбора «Мои маршруты» в UI.
- `line` — линия через плановые остановки наряда в окне по времени (только остановки внутри bbox данных карты `37.25,55.50,38.00,56.00`, как для `stops_dropped`), между соседними остановками — точки формы дороги. `line_times` той же длины, что `line`: у точки-остановки — её плановое время `HH:MM:SS`, у промежуточной точки формы — `null`.
- `line_shape` — `"road"`, если для наряда загружены формы; `"straight"` — форм нет (файла нет или наряда в нём нет), линия идёт прямыми между остановками.

### Форма маршрута по дорогам

Backend при старте читает `ROUTE_SHAPES_PATH` (по умолчанию `$DATA_DIR/routes/route_shapes.json`; формат и сборка — `transport_backend/route_shapes.py`, `scripts/build_route_shapes.py`). Для каждой пары **соседних** остановок наряда форма вставляется между ними; остановки остаются якорями: они лежат на линии точно в своих координатах, плановое время есть только у них. Пары без формы (другой план, остановка вне bbox окна и т. п.) рисуются прямой. Нет файла — все линии прямые, как раньше (`line_shape="straight"`); битый файл — ошибка старта. Одна и та же форма используется для `route_offset_m`/`off_route`/`nearest` (вся линия дня) и для `line`, `passed`, `ahead`, `split` (окно).
- `off_route`, `route_offset_m`, `route_not_started` — из последней посчитанной строки ТС (те же значения, что в `/v1/vehicles`).

## Consumer

- `GET /api/snapshot` — без изменений: конверт `{status, reason, checked_at, fetched_at, age_s, snapshot}`, новые поля Backend (`run`, `target_lon/lat`, `prediction_updating`) проходят как есть.
- `GET /api/route/{tr_id}` — proxy на `GET /v1/route/{tr_id}` без кэша: `200 {"status": "online", "reason": null, "checked_at", ...поля route}`; `404 {"status": "not_found", "reason": "<detail Backend>"}`; Backend недоступен, timeout, `5xx` или неверная форма → `503 {"status": "offline", "reason": "..."}` без маршрутных данных (прошлый маршрут не выдаётся). `tr_id` вне `[0-9A-Za-z_-]{1,64}` → `404`.
- `GET /api/routes` — proxy на `GET /v1/routes` в том же стиле: `200 {"status": "online", "reason": null, "checked_at", ...поля routes}`; Backend недоступен или неверная форма → `503 {"status": "offline", "reason"}` без линий.
- `GET /api/build` — `{"files": {"index.html", "static/app.js", "static/app.css", "static/map-worker.js": sha256}, "source_commit", "dashboard_bundle_sha256", "consumer_static_sha256"}`, считается на каждый запрос. Рецепт T-6 (`.tasks/T-6-2026-09-26-ndtp/artifacts/transport-demo/m2.md`): `dashboard_bundle_sha256` = sha256 вывода `shasum -a 256 consumer/static/app.css consumer/static/app.js consumer/static/map-worker.js`; `consumer_static_sha256` = sha256 вывода `shasum -a 256 consumer/index.html $(ls consumer/static/* | sort)` (пути относительно корня репозитория, сортировка C-locale). `source_commit` — build-arg `SOURCE_COMMIT` образа (`git describe --always --dirty --abbrev=40`), без него `"unknown"`.
