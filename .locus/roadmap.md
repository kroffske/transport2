# transport2 — roadmap

Roadmap следует [scorecard официальных критериев](../docs/prd/evaluation-scorecard.md). Статус «done» означает наличие указанного evidence, а не только завершённый код.

## Phase 0 — Source truth and direction

**Outcome:** требования, критерии, миссия и задачи читаются без PDF и предыдущей переписки.

- T-1 «Собрать исходный ML-репозиторий» — done.
- T-2 «Оформить product direction, критерии и roadmap» — done.
- Evidence: PRD, scorecard, soul, goal, roadmap, task lint и docs lint.

## Phase 1 — First valid model

**Outcome:** на полном датасете есть воспроизводимый point-in-time pipeline, честное сравнение baseline и моделей, локально валидный submission и пакет evidence для C1.

- Parent task: [T-3 «Получить первую валидную ML-модель и submission»](../.tasks/T-3-2026-09-25-ml-submission/task.md) — planning.
- Срезы: T-3/data-audit, T-3/baseline, T-3/modeling, T-3/evaluation.
- Основные критерии: C1; foundation для C2.
- Exit evidence: notebook + reusable code, split manifest, metrics table, deterministic training command, validated submission schema.

## Phase 2 — Streaming system and operator surface

**Outcome:** NDTP replay проходит через отдельный Backend и ML-инференс в live dashboard; система запускается одной Docker-инструкцией.

- Parent task: [T-4 «Собрать системный контур Backend, dashboard и infra»](../.tasks/T-4-2026-09-25-backend-dashboard-infra/task.md) — draft; реализацию начать после Phase 1 model contract.
- Срезы: NDTP ingest/state; ML API contract; dashboard; Compose/runbook; end-to-end proof.
- Основные критерии: C2, C3, C4.
- Exit evidence: stream → prediction → dashboard, Swagger smoke, live refresh, operator scenario.

## Phase 3 — Performance and reliability

**Outcome:** система имеет измеренные latency/throughput, выдерживает disconnect/reconnect и предсказуемо стартует.

- Расширяет системный parent task или создаёт отдельный hardening task по итогам Phase 2.
- Основной критерий: C5.
- Exit evidence: P50/P95/P99, отсутствие накопления очереди, degradation/recovery test, cold-start measurement.

## Phase 4 — Submission handoff and pitch

**Outcome:** обязательные артефакты собраны, разрешённые внешние действия отделены от локальной подготовки, demo-path воспроизводим, команда готова объяснить решения и ограничения.

- Сразу после T-3/evaluation готовится локальный CSV handoff и checklist загрузки; это не зависит от C2–C5 и не разрешает upload.
- Platform upload/readback — отдельное явно разрешаемое действие. Именно readback может обновить C1.
- Финальная форма, system links и pitch-пакет готовятся по мере появления demo-path; их не следует откладывать до максимальных баллов.
- T-3/evaluation владеет артефактом 1; T-4 владеет актуальными system links, jury runbook, PyDoc/Sphinx, OpenAPI и performance/additional-features summary для артефактов 2–5. Перед сдачей создаётся интеграционный checklist task.
- Указанный PRD дедлайн — 27 сентября, 23:59 МСК; лимит — 36 общих и 24 успешные Data Science попытки на команду в день.
- Критерии pitch: P1–P3; итоговая проверка C1–C5 выполняется по доступному evidence.
- Любая внешняя загрузка, публикация и deploy требуют отдельного разрешения пользователя.

## Portfolio rules

- Одновременно активен один критический путь: сначала Phase 1, затем Phase 2.
- Дополнительные фичи не вытесняют основной scorecard.
- Задача, не меняющая evidence или обязательный артефакт, должна объяснить вклад до активации.
- Каждая фаза обновляет scorecard только после readback.
