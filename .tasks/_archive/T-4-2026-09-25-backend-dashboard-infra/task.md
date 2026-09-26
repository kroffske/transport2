---
schema: task.v3
id: T-4
title: "Интегрировать NDTP, Backend, актуальную ML-модель и live consumer"
status: done
review_required: qa
plan_review_profile: standard
plan_review_gate: advisory
type: feature
priority: p1
owner: manager
created_at: "2026-09-25T19:32:16.620Z"
updated_at: "2026-09-26T03:37:06.840Z"
parent: null
depends_on: []
gstack_refs: {}
goal_contract: v1
stream: T
workflow: feature
---

# T-4: Интегрировать NDTP, Backend, актуальную ML-модель и live consumer

## Outcome

Primary goal: Получить работающую локальную цепочку NDTP/исторический replay → отдельный Backend с состоянием и расписанием → актуальная обученная ML-модель через отдельный API → простой live consumer, с Docker-запуском и проверяемым поведением при сбоях.

Direction: on-track

Пользователь 2026-09-26 разрешил исполнение сейчас, соседние рабочие чаты Sol High и локальные коммиты по проверенным задачам. Это заменяет прежнюю остановку draft до T-3 и включение полного dashboard. План не означает выполнение C1–C5; [scorecard](../../../docs/prd/evaluation-scorecard.md) сохраняет доказательственные границы.

## Decisions

1. **Сначала настоящий ML contract.** `transport_ml/` переносит только повторяемую inference-логику из `.local/validate-tuning-2026-09-26/{pipeline.py,final_model.py}`. Существующий FeatureBuilder остаётся владельцем motion-v1 и received-time фильтра. Отдельный загрузчик актуального артефакта использует `final_model.cbm`, metadata и `vehicle_origins.csv`; не переименовывать его в старые context/core. SHA-256 модели: `dc33437108c3e036089450c9b98771dacd014246fbb91d0df2a89d0c8e247122`. Старые training/evaluation вызовы не ломать без необходимости; serving явно выбирает новую модель.
2. **Версионированный HTTP seam.** Backend вызывает `POST /v1/predict` отдельного ML-процесса: `point={sample_id,tr_id,T,target_stop_id,target_time_begin,cur_dev_s}`, последние 900 секунд доступной telemetry и plan без фактических прибытий. ML формирует feature matrix в metadata-порядке с canonical vehicle/time. Ответ содержит schema/model version, artifact SHA, `prediction_s`, predicted arrival, applicability/quality и причину отказа. Вероятности, интервалы и causal explanations отсутствуют либо null; старые p_late/q10/q90 не смешивать с новым point model. Некорректная схема → 422, недоступный artifact → readiness failure; корректный, но неподдержанный день/ТС → явно unavailable без числа. W1 закрепляет точный OpenAPI до работы потребителей.
3. **Backend владеет состоянием.** Новый `transport_backend/` принимает TCP NDTP, связывает unit_id → tr_id явной проверенной таблицей, хранит ограниченную историю и доступность данных, выбирает первое плановое прибытие строго в `(T+600,T+900]`, оркестрирует HTTP inference. `target_stop_id` = tt_action_item_id планового прибытия, не ID физической остановки. План известен заранее; facts никогда не входят в inference.
4. **Два честных источника cur_dev_s.** Для exact offline/API parity и benchmark replay допустим только входной hint из validate/points.csv, доступный в его T, с `cur_dev_source=provided_point`; future hints запрещены. Для самостоятельного потока Backend вычисляет отклонение от последнего наблюдаемого прибытия по прошлым GPS и plan: последовательность остановок/рейса, ограниченный радиус, снижение скорости/остановка, время наблюдения и неоднозначность. Это приближённый detector, не фактическое расписание. Отдельно измерить покрытие/ошибку и влияние на прогноз против provided hint; не обещать offline MAE. До первого уверенного прибытия либо при неоднозначности → unavailable, не ноль и не future fact. Реальный stream с computed cur_dev должен показать хотя бы один настоящий prediction; provided-point путь один не завершает W3.
5. **Часы и replay.** Датасет имеет naive wall clock, timezone не доказан: сохранять как `dataset_wall`, не объявлять UTC/МСК. Unix NDTP трактуется UTC; исторический encoder использует документированное обратимое сопоставление dataset clock ↔ synthetic epoch с origin, не выдаваемое за географическую timezone. Replay clock отдельно от host wall/monotonic clock. Исторические строки выдаются по receive_time; использование в признаках только при event_time ≤ T И receive_time ≤ T, включая отрицательный receive lag (6434/105945 validate rows). Эмулятор всегда ставит текущий timestamp: он доказывает ingest/reconnect, но сегодняшний день не переносится скрыто на 2026-01-06. Model support проверяется по canonical prediction/target time и origin mapping; не отвергать допустимый исторический контекст около полуночи только по календарной дате пакета.
6. **NDTP — поток байтов.** Framing little-endian NPL/NPH, CRC со swap, handshake, частичные/склеенные кадры, размер и поддержанные ячейки проверяются на TCP boundary. Неизвестная ячейка без известной длины → явное отклонение кадра, не угадывать offset. Двери передавать только при известной проверенной раскладке датчика; отсутствие door telemetry обозначать unknown. Навигационный replay через настоящий TCP/NDTP обязателен; integer timestamp/speed quantization измеряется отдельно от exact JSON API parity.
7. **Повторы и свежесть.** Повтор кадра не создаёт повторную prediction/alert; поздние коррекции доступны только после receive time и не переписывают уже выданное прошлое. requestId может повториться после reconnect: identity включает session/protocol semantics, не глобальный requestId. История/очередь ограничены; overload/drop/coalescing наблюдаемы. На disconnect/stale GPS/ML timeout остаётся последнее известное состояние с возрастом, `degraded` и last-success timestamp; оно не маркируется свежим прогнозом. После reconnect обработка возобновляется. Границы stale/history/timeout документируются и проверяются.
8. **Live consumer без UI-проекта.** Backend `GET /v1/vehicles` отдаёт revision, tr_id/unit_id, lon/lat, target arrival, source/replay clock, timestamps/ages, current deviation/source, prediction/model, status/reason. Минимальная страница либо console polling показывает реальные изменения и сбой ML/связи. Polling достаточно; websocket/broker/database не нужны для одного локального demo. Consumer работает в третьем контейнере и читает Backend HTTP, не файлы модели. Изменение backend schema фиксируется до W4.
9. **C2 честно ограничен.** Пороговый сигнал `prediction_s > 120` допустим как deterministic delay rule, с dedup/cooldown, но не probability. Логи отдельно содержат уже известную задержку, новый сигнал, target window, emitted_at. Наблюдаемого размеченного onset в исходном контракте нет. Post-hoc train/test facts можно использовать только в отдельной evaluator-процедуре; approximate stop detector не считать независимой ground truth. Если onset нельзя обосновать, C2 остаётся неподтверждённым; это не блокирует W1–W5.
10. **География только как основа.** См. [решение](../../../docs/runbooks/geography-foundation.md): WGS84 lon/lat в градусах; будущая локальная ENU-сцена в метрах, x east/y up/z south. Нет route shape/road graph/stable physical-stop IDs. Line interpolation ≠ map matching. Полная карта и C4 вынесены в будущий этап.
11. **Владение исполнением.** Один Sol High координатор владеет интеграцией, task.md и общими Compose/dependencies/runbook. Каждый пишущий worker получает managed worktree и ветку codex/, одну область записи, критерий и local commit. Все рабочие/review чаты создаются с `model=gpt-6-sol`, `thinking=high` фактически в tool arguments. Read-only review независим от автора. Интеграция только после diff/tests/readback; каждый принятый срез отдельный commit. Основной checkout передаётся координатору после planning commit; планировщик после передачи не пишет туда.
12. **Локальные входы явно подключены.** DATA_DIR и MODEL_DIR configurable; исходные пути `/Users/ravius/projects/transport2/data` и `/Users/ravius/projects/transport2/.local/validate-tuning-2026-09-26`. В контейнеры mount read-only. Worktree не получает ignored artifacts автоматически. Не менять исходные веса, submission или labels; не коммитить dataset/.local/artifacts/caches/сырые task evidence. Remote отсутствует; push/PR/deploy/upload не входят в полномочия.

## Boundary

- **Included:** новый model serving contract, бинарный TCP ingest и historical NDTP replay, state/schedule/current-deviation logic, независимые Backend/ML/consumer, Docker, recovery/latency evidence, OpenAPI и актуальная PyDoc/Sphinx инструкция, краткое георешение.
- **Excluded:** переобучение/поиск лучшей модели, production multi-instance state и durable storage, calibrated probability/причины, BI-dashboard/C4, Three.js-карта, road map matching, внешняя публикация и platform upload.

## Work items

- [x] W1: Актуальная модель через проверенный API. Owner: ML worker; пишет `transport_ml/` и профильные tests, не Compose. Dependencies: нет.
  - Deliverable: versioned request/response, configurable artifact loader, reusable canonical features, model identity/readiness и offline CLI/API parity всех 151 validate points (tolerance ≤1e-6 с).
  - Contribution: последующие модули действительно используют выбранную модель.
  - Proxy result: старые context/core или импорт `.local/pipeline.py` в production.
  - Input/output: model+metadata+origins+point/history/plan → signed seconds prediction/status. Failure: неизвестная машина/день/битый artifact/неверный target, без молчаливого fallback.
  - Verification: oracle из frozen local predictor; API и package predictions; запрет чтения labels/facts; mutation future/late telemetry; no-risk-output check. Commit после review и проверок.
- [x] W2: NDTP и ограниченное состояние потока. Owner: Backend ingest worker; пишет parser/ingest/state в `transport_backend/` и свои tests. Dependencies: W1 contract; bounded parser work можно делать параллельно W1 после фиксации normalized packet schema.
  - Deliverable: TCP parser/handshake, unit mapping, event/receive clocks, duplicate/late policies, bounded history и freshness readback.
  - Contribution: настоящий транспортный поток становится причинно корректным входом системы.
  - Proxy result: CSV endpoint в обход NDTP либо статичные packets без TCP.
  - Input/output: NDTP bytes + local mapping → canonical telemetry/state. Failure: CRC/fragment/unknown cell/unknown unit/disconnect.
  - Verification: реальные socket fragmented/coalesced frames, bad CRC isolation, reconnect requestId reset, late correction, stale recovery и counters. Commit отдельно.
- [x] W3: Расписание и настоящий end-to-end prediction. Owner: Backend orchestration worker; пишет schedule/orchestration/API и tests после интеграции W2. Dependencies: W1+W2.
  - Deliverable: выбор target, observed-stop current deviation, HTTP ML call и backend snapshot; deterministic signal без probability; benchmark hints отдельным режимом.
  - Contribution: поток сам порождает реальные прогнозы без будущих фактов.
  - Proxy result: подавать готовые features/predictions или только provided hints и объявлять независимую online-работу.
  - Input/output: state+plan → ML request → versioned vehicle result. Failure: ambiguous stop/no eligible target/no current deviation/ML timeout.
  - Verification: хотя бы один computed-cur-dev NDTP→ML→Backend прогноз; coverage/error report; no future inputs; ML outage leaves last-success stale/degraded; no duplicate signal. Commit отдельно.
- [x] W4: Live consumer и воспроизводимый Docker launch. Owner: consumer worker для `consumer/`; координатор для Compose/Dockerfile/dependencies/replay scripts/runbooks. Dependencies: W3 backend schema; consumer можно готовить по frozen schema до завершения W3.
  - Deliverable: три отдельных контейнера, read-only data/model mounts, deterministic historical NDTP sender с replay clock, одна инструкция, live result revisions, OpenAPI и PyDoc/Sphinx.
  - Contribution: пользователь наблюдает настоящую цепочку и может повторить запуск.
  - Proxy result: три пустых контейнера, mock JSON, только host pytest или статическая страница.
  - Input/output: локальные artifacts + replay → меняющиеся consumer predictions/status. Failure: missing artifact, unavailable ML, interrupted replay.
  - Verification: cold Docker start; Swagger request; 2+ изменения результата в consumer и видимое degraded/recovery; official emulator handshake/navigation/reconnect отдельно (unsupported day допустим и явно показан). Component commits отдельно.
- [x] W5: Независимая проверка и доказательства. Owner: отдельный Sol High reviewer/QA; пишет только выделенный report/test boundary; координатор исправляет и закрывает parent. Dependencies: W1–W4.
  - Deliverable: повторяемый smoke/measurement сценарий; retained local evidence и краткие tracked выводы; actual SHA/readback; P50/P95/P99, accepted/emitted/dropped throughput, backlog/max queue, cold start, recovery timings; честный C2/C3/C5 статус.
  - Contribution: результат проверяем, сбои не скрыты сообщениями агентов.
  - Proxy result: PASS по одному worker summary, latency только model.predict или ускоренный event time, представленный как wall latency.
  - Input/output: финальный checkout+Docker → independent evidence. Failure: saturation, disconnect, corrupt packet, ML down/restart, unsupported model input.
  - Verification: NDTP send/receive → backend publish → consumer observe в wall/monotonic time с correlation ID; baseline 13 ТС, дополнительно bounded accelerated replay с указанным rate/duration/hardware; отсутствие растущей очереди, явные drops; C2 lead time только при независимом onset source. При техническом blocker фиксировать конкретную неисполненную проверку.

## Verification

- W1 exact parity не зависит от NDTP quantization и не доказывает качество online cur_dev; для W3/W4 измерить отличие округлённого wire replay отдельно.
- Point-in-time invariance: изменение future telemetry, позднего correction или fact schedule не меняет уже выданное prediction; оба времени проверены.
- Запуск не импортирует локальный эксперимент и не читает ответы; model fingerprint совпадает с выбранным artifact.
- Consumer readback показывает реальные revision/prediction и degradation/recovery после выключения ML/NDTP.
- C1 остаётся без platform score; C2 без onset evidence не закрывается; C3 подтверждается только в фактически показанной части с minimal consumer; C4 отложен; C5 зависит от реальных замеров.
- Independent plan challenge до implementation: координатор сверяет этот контракт с источниками, записывает advisory review через locus; существенные изменения возвращаются в planning.md. Independent code review и QA обязательны до закрытия T-4.

## Execution log

- 2026-09-26 — Astra перепланировал T-4 по прямому запросу пользователя; исходный main `d8e42a51606a0e391406b0b3470826309d1487fe`, чистое дерево, remote отсутствует. Код ещё не реализован; work items не отмечены выполненными.

- 2026-09-26 — Координатор принял W1–W4 после diff/tests/independent review; W5 отдельно проверила Docker, causal clocks, failure/recovery, 13-unit baseline, overload и latency. Финальная QA принята и интегрирована локально.

## Closure

Завершена 2026-09-26. W1–W5 приняты; независимый final code review `036f589` закрыл все findings, [QA](qa.md) приняла REQ-001…009. Координатор интегрировал source и QA commits в `codex/t4-integration`, выполнил 57 tests и финальный Docker readback: три healthy сервиса, завершённый replay, queues/active=0, last predictions явно degraded/disconnected.

Selected model/API совпадают с frozen oracle на 151/151 point; wire quantization и detector/hint delta измерены отдельно. При ML/Backend сбоях состояние сохраняет возраст и восстанавливается. Официальный UTC emulator подтвердил 13 соединений/reconnect без подмены trained day. [Runbook](../../../docs/runbooks/local-demo.md) содержит запуск и ограниченные wall measurements. C1/C2/C4, полный BI, dense13predictioncoverage и production load не заявляются.

Доставка ограничена локальными commits; push/PR/merge/deploy/training не выполнялись. Основной checkout остаётся на `codex/t4-integration`, local `main` — planning commit `b39fe7a`.
