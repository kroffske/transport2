---
schema: task.v3
id: T-18
title: "UX: очередь, полоса внимания, поиск ТС и подписи времени"
status: review
review_required: qa
plan_review_profile: none
plan_review_gate: none
type: feature
priority: p1
owner: claude
created_at: "2026-09-27T17:42:58.205Z"
updated_at: "2026-09-27T18:16:36.781Z"
parent: null
depends_on: []
gstack_refs: {}
goal_contract: v1
stream: T
---
# T-18: UX: очередь, полоса внимания, поиск ТС и подписи времени

## Outcome

Primary goal: очередь — единственный владелец событий и не прыгает; полоса внимания — сводка; поиск ТС без ухода из очереди; время данных крупно, таймер реакции и отсрочка подписаны своим временем.
Direction: on-track
Comment: Часть объединённого UX-ревью (T-12 GPT + T-13 Claude). Требования — `.tasks/T-13-2026-09-27-ux-ui-claude-t-12/artifacts/merged-spec.md` раздел §Q. Параллельно идут T-15…T-18 в отдельных git worktree; интеграция и приёмка — T-19.

## Decisions

- Требования и тексты берутся дословно из `.tasks/T-13-2026-09-27-ux-ui-claude-t-12/artifacts/merged-spec.md` §Q; отклонения записываются в Execution log с причиной.
- Работа в отдельном git worktree от `dev`; владение файлами: dashboard/event-queue.js (+тест), dashboard/app.js (очередь, полоса внимания, toast, шапка, поиск, горячие клавиши), dashboard/run.js, шапка и шапка правой колонки в consumer/index.html, соответствующие стили. Чужие области не трогать; если без этого нельзя — минимальная правка и запись в handoff.
- Собранный бандл `consumer/static/*` не коммитить (его пересобирает T-19). Коммит в ветке worktree — да; push/PR/merge — только в T-19.
- Проверка без трогания общего стека: `.tasks/T-13-2026-09-27-ux-ui-claude-t-12/artifacts/tools/preview.mjs` (подменяет index.html/app.js/app.css сборкой worktree, API живой, есть фикстуры снимка).

## Boundary

- **Included:** §Q спецификации.
- **Excluded:** другие разделы спецификации; режим < 1100 px; изменения Backend/ML; перезапуск docker-стека.

## Work items

- [x] W1: Реализация §Q.
  - Deliverable: коммит в ветке worktree; тесты `npm --prefix dashboard test` зелёные.
  - Contribution: закрывает свою часть единого ревью.
  - Proxy result: изменения без обновлённых тестов или без скриншотов.
- [x] W2: Доказательства.
  - Deliverable: скриншоты до/после 1920×1080 и 1366×768 в `artifacts/` этой задачи + handoff.md (что сделано, отклонения, остаток, затронутые функции).
  - Contribution: T-19 интегрирует без повторного выяснения.
  - Proxy result: «сделано» без скриншотов.

## Verification

- `npm --prefix dashboard test` и `npm --prefix dashboard run build` проходят в worktree.
- Скриншоты через preview.mjs показывают требования §Q на обоих размерах.
