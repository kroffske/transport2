# transport2 — roadmap

Roadmap следует [scorecard официальных критериев](../docs/prd/evaluation-scorecard.md). Статус «done» означает наличие указанного evidence, а не только завершённый код.

## Phase 0 — Source truth and direction

**Outcome:** требования, критерии, миссия и задачи читаются без PDF и предыдущей переписки.

- T-1 «Собрать исходный ML-репозиторий» — done.
- T-2 «Оформить product direction, критерии и roadmap» — done.
- Evidence: PRD, scorecard, soul, goal, roadmap, task lint и docs lint.

## Phase 1 — First valid model

**Outcome:** на полном датасете есть воспроизводимый point-in-time pipeline, честное сравнение baseline и моделей, локально валидный submission и пакет evidence для C1.

- Parent task: [T-3 «Получить первую валидную ML-модель и submission»](../.tasks/_archive/T-3-2026-09-25-ml-submission/task.md) — archived; актуальный очищенный кандидат описан в integration-handoff.
- Срезы: T-3/data-audit, T-3/baseline, T-3/modeling, T-3/evaluation.
- Основные критерии: C1; foundation для C2.
- Exit evidence: notebook + reusable code, split manifest, metrics table, deterministic training command, validated submission schema.

## Phase 2 — текущая локальная интеграция

**Outcome:** historical NDTP replay → Backend state/schedule → актуальная модель отдельным API → live consumer; одна Docker-инструкция и проверенные failure paths.

- Parent task: [T-4 «Интегрировать NDTP, Backend, актуальную ML-модель и live consumer»](../.tasks/T-4-2026-09-25-backend-dashboard-infra/task.md) — planning по разрешению пользователя 2026-09-26; прежняя остановка draft отменена.
- Порядок: W1 модель/contract → W2 ingest/state → W3 schedule/orchestration → W4 consumer/Docker → W5 independent evidence. Parser может идти параллельно W1 после согласования packet schema.
- C2 проверяет плановый горизонт отдельно от onset lead time; C3 только в показанной части; C5 требует измерений. C1 без platform score не меняется.
- Полноценный BI-dashboard исключён из этой T-4; простой live consumer не закрывает C4.

## Phase 3 — будущий операторский интерфейс

**Outcome:** отдельная последующая задача реализует понятный BI-dashboard и карту, risk semantics и incident cards на стабильном backend contract.

- C4 отложен по запросу пользователя. Three.js — кандидат renderer, не источник геоданных.
- Основа: [географическое решение](../docs/runbooks/geography-foundation.md). Источники маршрутов, stable stop IDs и лицензии должны быть проверены до реализации.
- Эта будущая фаза не блокирует текущую интеграцию и локальные performance/reliability проверки T-4.

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

- Текущий критический путь — Phase 2; один координатор владеет интеграцией. Независимые срезы выполняются в изолированных worktree.
- Дополнительные фичи не вытесняют основной scorecard.
- Задача, не меняющая evidence или обязательный артефакт, должна объяснить вклад до активации.
- Каждая фаза обновляет scorecard только после readback.
