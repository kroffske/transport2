---
schema: task.v3
id: T-4
title: "Собрать системный контур Backend, dashboard и infra"
status: draft
review_required: qa
plan_review_profile: standard
plan_review_gate: advisory
type: feature
priority: p1
owner: manager
created_at: "2026-09-25T19:32:16.620Z"
updated_at: "2026-09-25T19:32:16.620Z"
parent: null
depends_on: []
gstack_refs: {}
goal_contract: v1
stream: T
workflow: feature
---

# T-4: Собрать системный контур Backend, dashboard и infra

## Outcome

Primary goal: Собрать доказуемый системный контур NDTP → Backend → ML inference → BI-dashboard, который запускается одной Docker-инструкцией и создаёт evidence для C2–C5.

Direction: on-track

T-4 является отдельным portfolio box после фиксации ML contract в T-3; текущий draft не разрешает реализацию до готовности model input/output schema.

## Goal alignment

Direction: on-track

Задача реализует Phase 2–3 roadmap и не подменяет near-term ML goal. Она активируется после evidence T-3/evaluation.

## Decisions

- Backend владеет NDTP ingest, event-time состоянием, расписанием, идентификацией ТС/рейса, оркестрацией и incident lifecycle.
- ML-модуль владеет feature/model schema, инференсом, quality status и model metadata.
- Dashboard владеет операторским представлением: карта, risk colors, incident card, freshness и метрики.
- Плановое окно до целевой остановки не является onset-label. T-4 отдельно владеет определением наблюдаемого инцидента, alert policy и измерением фактического lead time; известная задержка и новое предупреждение не смешиваются.
- Docker/infra связывает три модуля и эмулятор, но не становится четвёртым продуктовым модулем.
- Точная API-схема зависит от финального T-3 model contract; до этого задача остаётся `draft`.
- Placeholder допустим только как документированный будущий owner, но не считается evidence C3/C4.

## Boundary

### Included

- **Backend/NDTP** — parser, TCP ingest/replay, state, schedule matching и orchestration.
- **ML serving seam** — согласованный request/response contract и version readback.
- **Dashboard** — live operator flow по официальным требованиям.
- **Docker/infra** — Compose, healthchecks, README runbook и emulator integration.
- **Reliability evidence** — latency, throughput, reconnect/degradation и cold start.

### Excluded

- **Model research** — обучение и выбор модели принадлежат T-3.
- **Optional features** — Map Matching, What-if, ONNX/TensorRT и сложные ансамбли до основных критериев.
- **Production deployment** — cloud, public URL и внешний deploy без отдельного решения.

## Work items

- [ ] W1: Backend и NDTP ingest
  - Deliverable: поток эмулятора принимается, валидируется, сопоставляется с расписанием и превращается в versioned ML request.
  - Contribution: создаёт реальный online input для C2/C3.
  - Proxy result: HTTP endpoint на статическом JSON без NDTP и event-time state.
- [ ] W2: Политика алертов и раннее предупреждение
  - Deliverable: определены наблюдаемое событие и источник его времени, risk probability/threshold, cooldown/dedup, alert timestamp и lead-time; отдельно измеряются уже известная задержка и новый инцидент.
  - Contribution: создаёт проверяемый путь C2 вместо подмены плановым горизонтом остановки.
  - Proxy result: прогноз в точке, где `target_time_begin - T` равно 10–15 минут, без доказательства предупреждения до onset.
- [ ] W3: ML serving seam
  - Deliverable: отдельный ML service принимает согласованный context, возвращает delay/risk/quality/model version и имеет Swagger smoke.
  - Contribution: разделяет Backend и ML по официальному критерию.
  - Proxy result: прямой import training code внутри Backend без API/readback.
- [ ] W4: Диспетчерский dashboard
  - Deliverable: live карта, risk colors, incident card, freshness, predicted delay, предполагаемый паттерн/причина, участок маршрута и рекомендация работают на потоке.
  - Contribution: создаёт evidence C4 и пользовательский результат.
  - Proxy result: статичный mock или таблица без live update.
- [ ] W5: Docker, документация и end-to-end runbook
  - Deliverable: эмулятор и три модуля запускаются одной инструкцией; healthchecks и demo-path проверены; PyDoc/Sphinx и OpenAPI пересозданы по финальному коду; инструкция жюри описывает поток/replay, прогнозы, алерты, dashboard и метрики.
  - Contribution: создаёт evidence C3.
  - Proxy result: отдельные Dockerfile без проверенной связи модулей.
- [ ] W6: Performance и reliability
  - Deliverable: зафиксированы P50/P95/P99, throughput, queue behavior, reconnect/degradation и cold start.
  - Contribution: создаёт evidence C5.
  - Proxy result: архитектурное обещание без замеров и failure-path теста.

## Verification

- NDTP -> emulator replay доставляет пакеты и Backend корректно обрабатывает reconnect.
- Horizon -> report отдельно показывает корректное плановое окно, время наблюдаемого onset, alert timestamp, lead-time и отсутствие post-event alerts. Если onset-разметки недостаточно, C2 остаётся неподтверждённым и ограничение записывается явно.
- Separation -> Backend и ML работают как независимые процессы; Swagger smoke подтверждает контракт.
- End-to-end -> поток → prediction → dashboard наблюдаем после одной documented команды запуска.
- Dashboard -> карта, цвета риска, incident card и live refresh проверены по операторскому сценарию.
- Reliability -> метрики latency/throughput, отсутствие неограниченной очереди, degradation/recovery и cold start сохранены как task evidence.
- Submission package docs -> PyDoc/Sphinx и OpenAPI соответствуют текущему коду; jury runbook и performance/additional-features summary покрывают обязательные артефакты 2–5.

## Execution log

## Closure
