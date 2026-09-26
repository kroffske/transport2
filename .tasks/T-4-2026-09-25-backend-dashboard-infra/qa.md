Verdict: ACCEPTED

## Scope

T-4 — локальная интеграция NDTP → Backend → выбранная ML-модель по HTTP → live consumer. Независимая W5 QA проверила точный base `a0a38102d52a09edef04c22060c78f792963a9c2`, включающий исправления `036f589b979fd9c35437c2f619e6833f9951aa2a`. Workspace: `/Users/ravius/.codex/worktrees/t4-system-qa/transport2`; branch: `codex/t4-system-qa`. Product source, Compose, данные, модель и parent lifecycle не изменялись. Отчёт принимает локальную цепочку в согласованном scope, не полный PRD scorecard.

REQ-001…009 — task-local aliases из W5 dispatch: модель; NDTP/state; причинность/часы; target/detector; Docker/consumer; сбои/очереди; измерения; UTC emulator/scorecard; review/документация.

## Verification Ledger

| Requirement | Check | Status | Output |
| --- | --- | --- | --- |
| REQ-001 | Frozen oracle, package и настоящий Docker HTTP для всех 151 point; artifact/origin identity; invalid/unsupported input/readiness. | PASS | `artifacts/qa/model.json`: 151/151, package/HTTP max delta `4.901929138156902e-7` с. Model SHA `dc33437108c3e036089450c9b98771dacd014246fbb91d0df2a89d0c8e247122`; origin SHA `cb5d80f1546a793494c80e108642418d330d675ddf616ec9f56815206eb1f3f8`. Tests проверили 422, unsupported vehicle/day без числа, missing/corrupt artifact и подмену origin без fallback/probability/quantile. |
| REQ-002 | Настоящие sockets, fragmented handshake/coalesced Nav00, CRC/unknown cell, semantic duplicate/reconnect, correction; границы state/queue/handlers/journal. | PASS | `protocol.json`: 2 accepted, 2 duplicate, отдельно CRC и unknown-cell rejection, две session при request ID reset. `burst.json`: 26000 distinct frames, queue limit/max depth 1, 25926 явных queue drops; queue drained. Socket tests дополнительно проверили history eviction, journal gap и reaping 30 reconnect handlers. |
| REQ-003 | Event/receive cutoff, future/late/fact mutation, synthetic origin mismatch до TCP, session-bound ack и ранее полученный future event. | PASS | `pytest.log`, `review-probe.log`, `protocol.json`, `demo.json`: прежний probe exit 0; старый completion degraded, alert null, новое задание включает ставший доступным event. Test проверил input/prediction context revisions и отсутствие mutation старого snapshot. Origin mismatch exit 1, connections/accepted не изменились. |
| REQ-004 | Строгий target `(T+600,T+900]`, computed-stop prediction по NDTP→HTTP, долгая стоянка, отзыв GPS evidence, detector/hint/wire различия. | PASS | 160 ML successes в финальном shipped Docker demo; source `computed_stop`. Tests: стоянка 1800 с/history 4; invalid correction снимает cur_dev, moving packet не возвращает уверенность; новое подтверждение восстанавливает её. Независимый повтор raw benchmark: 139/151, delta прогноза 31.003 с; wire-only N151, mean 2.780 с/max 58.704 с. Это не online MAE. |
| REQ-005 | Холодный запуск трёх частей, readonly mounts, Swagger sample, текущий consumer, 2+ revision/prediction, API failure/recovery. | PASS | `startup.json`: prebuilt-image start до 3 healthy за 16.982 с. `infrastructure.json`: data/model mounts RW=false, consumer без mounts. `swagger.json`: оба `/docs` 200, shipped sample supported. `docker-demo.json`: 200 consumer revisions, 150 наблюдённых публикаций прогноза. `faults.json`: реальный consumer offline с сохранённым snapshot, затем online; shipped browser JS failure/timeout/recovery проверен тестом. |
| REQ-006 | Медленный/недоступный ML при нескольких машинах, ack/snapshot независимо от ML, bounded/coalesced jobs, obsolete completion, disconnect/stale/reconnect. | PASS | `faults.json`: 41 ML failures, 153 successes, 25 coalesced, 1 obsolete; 1630 кадров подтверждены. Ack P95 3.353 мс/P99 8.076 мс. `fault-detail.json`: сохранённый last success виден при ошибке, source-age до 105.977 с; первый новый прогноз после start ML наблюдался через ≤1.036 wall-секунды. Real HTTP timeout test подтвердил ack и snapshot <0.15 с для двух unit. Tests отдельно подтвердили queue-full, stale GPS и защиту нового target; UTC emulator подтвердил reconnect. |
| REQ-007 | Frame-correlated wall/monotonic latency, N и percentiles, throughput/coalescing/drops, hardware/start/recovery; 13-unit baseline и bounded acceleration. | PASS | Таблицы ниже; `demo*.json[l]`, `accelerated*.json[l]`, `sparse13.json`, `burst.json`, `clock-calibration.json`, `http-clock-calibration.json`. 13 planned unit проверены sparse real rows и одновременно официальным UTC emulator. Плотное historical prediction coverage всех 13 не заявляется. |
| REQ-008 | Официальный emulator current UTC, 13 units, restart/reconnect, unsupported day, отсутствие скрытого переноса на trained day. | PASS | `official-emulator.json`: 13 connections/46 accepted; после restart Backend — 13 connections/13 accepted за 2.337 с. Все 13 плановых строк имеют `unsupported_day`, prediction null; Backend не вызывает ML без подходящего historical target. Emulator удалён. C1/C2/C4 остаются неподтверждёнными; C3/C5 ограничены показанным scope. |
| REQ-009 | Закрытие независимого review и проверка current docs/OpenAPI/PyDoc. | PASS | Прочитаны initial/recheck/final review; final `036f589` закрыл оставшиеся два findings. Прежний probe повторён неизменённым: exit 0. 56 tests passed, 1 deselected, 1 Starlette deprecation warning; исключённый hardcoded-root parity test заменён независимым 151-point oracle/package/actual Docker HTTP check из QA cwd. Все 3 committed OpenAPI равны runtime schema. Runbook launch и текущий `pydoc` для 3 модулей проверены. |

## Измерения и граница доказательства

Host: Mac17,8, Apple M5 Pro, 48 GiB RAM. Docker 29.7.2/aarch64: 18 vCPU, 8317267968 bytes VM RAM (≈7.75 GiB), Python 3.12. VM и macOS monotonic никогда не вычитались друг из друга. Sender send/ack и probe observe используют один host monotonic domain. Backend ingest `received_at_utc` имеет текстовую точность 1 мкс; publish/send хранят Unix ns, что само по себе не доказывает наносекундную точность часов.

Проверяемый день — naive `dataset_wall`, не UTC/МСК. Mapping: dataset origin `2026-01-06 00:00:00` ↔ synthetic epoch `1700000000`. Source/event/receive clocks применяются только к доступности/свежести. Wall duration и latency измеряются отдельными host clocks.

Калибровка действительно выполнена: 7 Docker-exec замеров bracket host before/VM `time.time_ns`/host after дали offset interval [-12.350,+52.676] мс. 30 consumer fetched-at brackets отдельно дали [-16.978,-7.340] мс. Во время demo offset envelope fetched-at brackets был [-19.490,+34.002] мс; faults [-4.633,+34.249]; accelerated [-2.721,+33.271]. Нельзя считать offset постоянным или давать субмиллисекундную cross-VM точность.

Uncorrected `send→ingest` Unix delta имеет P50 -9.455 мс: это смещение часов, не отрицательная физическая latency. Для каждого кадра физический ingest находится между send и подтверждением ack: нижняя граница 0, верхняя — measured host ack latency. Нулевая фактическая latency не заявляется. Publication brackets ниже используют VM fetched_at внутри host request/response interval той же consumer выборки; предполагается стабильная скорость wall clock на соответствующем коротком интервале. Отрицательная математическая нижняя граница означает недостаточную точность bracket; физическая нижняя граница ограничивается 0.

### Основной historical replay, host sender → Docker

Фрагмент 03:20–03:45, speedup 30. 1630 sent / 1611 accepted / 19 semantic duplicates; 11 unit, 49.912 wall-секунды. Отправка 32.657 кадра/с, accepted 32.277/с. ML: 171 enqueued, 161 started/completed/succeeded, 10 coalesced, 0 failed/queue-full/obsolete. Ingest max queue 1/256; ML max queue 4/32; после обработки queue/active=0. Coalescing намеренно пропускает промежуточные задания и включён в отчёт; это не потерянная telemetry.

| Измерение | N | P50, мс | P95, мс | P99, мс |
| --- | ---: | ---: | ---: | ---: |
| Send → ingest acknowledgement, host monotonic | 1630 | 1.778 | 2.947 | 8.975 |
| Send → первое наблюдение input frame в consumer API, host monotonic | 1306 | 70.436 | 139.811 | 148.805 |
| Send → первое наблюдение сохранённой prediction publication в consumer API, host monotonic | 156 | 142.715 | 569.975 | 1118.503 |
| Send → sampled row publication, calibrated верхняя граница | 1306 | 2.510 | 61.914 | 138.421 |
| Send → prediction publication, calibrated нижняя…верхняя граница percentile | 156 | 26.114…42.102 | 449.118…464.512 | 1014.768…1028.937 |

Consumer запросы идут примерно раз в 0.1 с плюс время HTTP. Это HTTP wrapper observation, не browser paint при UI polling 1.5 с. N1306 — первые наблюдения distinct input frame ID, не все 1630 кадров; между polls кадры пропускаются. Если poll пропустил первую row publication, сохранённая позднейшая publication — sampled upper bound, не initial packet publication. Prediction identity содержит input frame, context revision и publication timestamp. N156 меньше 161 ML successes из-за polling. Наблюдение охватило 355 разных snapshot revisions.

Prediction latency привязана к send сохранённого `prediction_input_frame_id`. При отрицательном receive lag и изменении полного контекста этот send может предшествовать фактической eligibility другого события; метрика не является длительностью только model call. Sender trace сохраняет source packet/time, request/session/frame ack и host send/ack clocks; consumer observation сохраняет собственные clocks/fetched_at.

### Ускорение, overload и baseline 13

Accelerated replay запросил speedup 3000; lockstep ack фактически ограничил скорость. 1630 sent / 1611 accepted / 19 duplicates за 4.613 с: 353.311 sent/с, 349.193 accepted/с. 222 ML enqueued, 148 started/completed, 145 succeeded, 74 coalesced, 3 obsolete, без ML/ingest queue-full/errors. ML max queue 4/32, затем queue/active=0. Ack N1630: P50/P95/P99 1.251/2.107/5.686 мс. Consumer prediction observations N99: 86.157/171.511/178.291 мс. Более низкая sampled latency не доказывает меньшую latency каждой заявки: coalescing и sampling меняют выборку. Целевая скорость не достигнута: max send lateness 4.106 с. Один первоначальный запуск этого сценария прервался host HTTP connection timeout после 1113 кадров; после restart Backend/consumer полный повтор прошёл. Этот transient не скрыт и не используется как успешный замер.

Отдельный bounded burst не ждёт ack: 13 реальных planned unit, 2000 distinct Nav00/unit, всего 26000 кадров за 0.833 с (≈31198 attempted/с). Намеренно `NDTP_QUEUE_LIMIT=1`, history/outcome limit=64. 74 accepted, 25926 `dropped_queue_full`; processing journal evictions=25936, max queue=1, queue=0 после drain. Это контролируемая проверка явных drops и bounds, не production capacity. Source event/receive этого synthetic burst не давали eligible ML target; ML coverage этим тестом не доказывается. ML queue-full и stale/obsolete outcome проверены отдельно bounded controlled test.

Sparse historical baseline: первые 5 строк файла каждого из 13 planned unit, затем выбранные реальные строки отсортированы глобально по receive_time/packet_id; 65 sent/accepted, сохранены исходные event/receive clocks и порядок; все 13 соединений установлены. Это sparse ingest, не плотный historical replay и не 13-unit prediction coverage. Дополнительно официальный UTC emulator держал все 13 одновременно. Traffic содержит 30 unit, план — 13; выбранный demo содержит 11 unit. Полный 13-unit dense prediction benchmark и полный production load не выполнялись.

### Startup, сбои, final readback

После обязательного rebuild исходников выполнен timed cached rebuild: 0.613 с; отдельный prebuilt-image cold start до трёх healthy — 16.982 с. Это не время скачивания uncached image/dependencies; первый rebuild сохранён в `build.log`, но отдельно не хронометрировался. Реальные container source hashes для orchestration/schedule/service/replay совпали с QA checkout (`source-identity.json`).

Fault replay сохранил весь поток: 1630 sent, 1611 accepted, 19 duplicates за 49.914 с. Остановка ML произошла после первого успеха; 41 errors видны в counters/rows, last success сохранён с возрастом, 25 coalesced jobs и 1 obsolete completion не скрыты. После start ML первое новое наблюдение прогноза — ≤1.036 wall-секунды включая polling. Pause Backend заставил реальный consumer вернуть offline+cached snapshot, unpause восстановил online. Browser timeout/старение rows проверены shipped JS test; реальные pixels/paint timing не измерялись. Official emulator initial config→13-unit ingest занял 7.085 с, Backend restart→13-unit ingest 2.337 с.

Финальный **shipped Compose demo** пересобрал и replay image: 1630 sent / 1611 accepted / 19 duplicates, 49.909 с, 160 ML successes, 10 coalesced, 0 error/queue-full/obsolete. Consumer показал 200 snapshot revisions и 150 отдельных prediction publications. Разница относительно host-sender замера ожидаема при асинхронных задачах и sampling.

После QA оставлены `transport2-ml-1`, `transport2-backend-1`, `transport2-consumer-1` healthy; `transport2-replay-1` exited(0). Все TCP sender sessions закрыты. Сохранённые подходящие прогнозы имеют `degraded/disconnected`; другие строки без target имеют `no_target_in_horizon`. Ingest/ML queues=0, ML active=0. Readback: `final-readback.json`, `infrastructure.json`, `docker-demo.json`. `transport2-ndtp-emu` удалён. Historical source clock восстановлен.

Host environmental limit: посторонний Python PID 2161 слушает `127.0.0.1:8000` и возвращает 404. Он не остановлен. Docker ML проверялся через IPv6 `::1` / `localhost:8000`; backend/consumer через IPv4. Это конкретный конфликт host binding, не отказ ML-модели.

## Повторение и evidence

Все команды выполнялись с explicit cwd `/Users/ravius/.codex/worktrees/t4-system-qa/transport2`. Venv только `/Users/ravius/projects/transport2/.venv`. `DATA_DIR=/Users/ravius/projects/transport2/data`, `MODEL_DIR=/Users/ravius/projects/transport2/.local/validate-tuning-2026-09-26`, mounts readonly. Compose project всегда `transport2`. QA единолично владела Transport2 Docker; посторонние контейнеры не менялись.

Probe: `tests/system_probe.py`; фазы `model`, `sparse13`, `demo`, `faults`, `accelerated`, `burst`, `official`, `protocol`, `docker-demo`, `infrastructure`, `readback`. Фазы пишут JSON только в ignored `artifacts/qa/`. Для исторического sender до каждого нового replay нужно restart Backend/consumer либо полный down/up, поскольку replay time не идёт назад. `official` сама запускает UTC stack и удаляет emulator; перед возвратом к historical выполнены down/up без SOURCE_CLOCK. `docker-demo` оставляет завершившийся shipped sender.

Основные actual commands:

```bash
DATA_DIR=/Users/ravius/projects/transport2/data MODEL_DIR=/Users/ravius/projects/transport2/.local/validate-tuning-2026-09-26 docker compose -p transport2 build
DATA_DIR=/Users/ravius/projects/transport2/data MODEL_DIR=/Users/ravius/projects/transport2/.local/validate-tuning-2026-09-26 docker compose -p transport2 up -d --wait
PYTHONPATH=. PYTHONDONTWRITEBYTECODE=1 /Users/ravius/projects/transport2/.venv/bin/python tests/system_probe.py model
PYTHONPATH=. PYTHONDONTWRITEBYTECODE=1 /Users/ravius/projects/transport2/.venv/bin/python tests/system_probe.py demo
PYTHONPATH=. PYTHONDONTWRITEBYTECODE=1 /Users/ravius/projects/transport2/.venv/bin/python -m pytest -q tests -k 'not frozen_oracle_package_and_http_all_validate_points'
PYTHONPATH=. PYTHONDONTWRITEBYTECODE=1 /Users/ravius/projects/transport2/.venv/bin/python /Users/ravius/projects/transport2/.tasks/T-4-2026-09-25-backend-dashboard-infra/artifacts/code-review/probe-0abe832.py
PYTHONPATH=. PYTHONDONTWRITEBYTECODE=1 /Users/ravius/projects/transport2/.venv/bin/python /Users/ravius/.codex/worktrees/2652/transport2/.local/w3-recheck-benchmark/paired_benchmark.py --output .tasks/T-4-2026-09-25-backend-dashboard-infra/artifacts/qa/raw-detector-benchmark.json
```

Burst override сохранён в `artifacts/qa/burst-compose.yaml`; actual recreate: `docker compose -p transport2 -f compose.yaml -f <absolute burst-compose.yaml> up -d --force-recreate backend consumer`. Прочие фазы выполнялись тем же абсолютным venv. Сырые sender trace/observations, timings, process logs, model pairs, infrastructure/source identity и компактные phase summaries сохранены локально; data/model/raw evidence не коммитятся.

## Residual risk

- C1 не принят без platform score. C2 не принят без независимого размеченного onset; deterministic threshold alert не probability и не доказательство lead time. C4 отложен. C3 подтверждён только минимальным live consumer; C5 — показанными ограниченными 11-unit historical/13-unit ingest/overload сценариями, без полного production benchmark.
- Raw detector coverage 139/151 = 92.053%; mean absolute cur_dev difference 94.5539568 с, paired prediction mean difference 31.0029528 с/max 202.4468801 с, threshold rule changes 7/139, GPS retractions 5. Это raw received stream против provided hint, отдельно от Nav00 rounding и отдельно от online model MAE.
- Wire-only N151: mean absolute prediction delta 2.7799668 с/max 58.7041435 с при неизменных point/plan/provided cur_dev и receive clock. Integer event timestamp теряет субсекунды; exact API parity этого не обещает.
- State живёт в одном Backend процессе и не durable; Backend restart теряет историческое состояние. Fixed bounds/coalescing делают перегрузку наблюдаемой, но часть intermediate predictions пропускается. Полное покрытие всех 13 прогнозами не проверялось.
- QA не закрывала task.md и не принимала решение о parent lifecycle. Координатору остаётся проверить owned diff/readback и интегрировать локальный QA commit. Push/PR/merge/deploy/training не выполнялись.
