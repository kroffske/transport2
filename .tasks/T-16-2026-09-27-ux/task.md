---
schema: task.v3
id: T-16
title: "UX: карточка автобуса — блок прогноза, состояния, тексты и формат"
status: doing
review_required: qa
plan_review_profile: none
plan_review_gate: none
type: feature
priority: p1
owner: claude
created_at: "2026-09-27T17:42:56.765Z"
updated_at: "2026-09-27T17:42:56.765Z"
parent: null
depends_on: []
gstack_refs: {}
goal_contract: v1
stream: T
---
# T-16: UX: карточка автобуса — блок прогноза, состояния, тексты и формат

## Outcome

Primary goal: карточка отвечает за один взгляд: цель, по расписанию, ожидается, опоздание по прогнозу, факт сейчас и возраст; тексты всех состояний и единый формат +м:сс; нигде нет двусмысленного «+3 мин · с 06:58».
Direction: on-track
Comment: Часть объединённого UX-ревью (T-12 GPT + T-13 Claude). Требования — `.tasks/T-13-2026-09-27-ux-ui-claude-t-12/artifacts/merged-spec.md` раздел §C. Параллельно идут T-15…T-18 в отдельных git worktree; интеграция и приёмка — T-19.

## Decisions

- Требования и тексты берутся дословно из `.tasks/T-13-2026-09-27-ux-ui-claude-t-12/artifacts/merged-spec.md` §C; отклонения записываются в Execution log с причиной.
- Работа в отдельном git worktree от `dev`; владение файлами: dashboard/app.js (рендер карточки, тексты очереди/меток), dashboard/route-context.js, dashboard/map-labels.js, стили карточки в dashboard/style.css. Чужие области не трогать; если без этого нельзя — минимальная правка и запись в handoff.
- Собранный бандл `consumer/static/*` не коммитить (его пересобирает T-19). Коммит в ветке worktree — да; push/PR/merge — только в T-19.
- Проверка без трогания общего стека: `.tasks/T-13-2026-09-27-ux-ui-claude-t-12/artifacts/tools/preview.mjs` (подменяет index.html/app.js/app.css сборкой worktree, API живой, есть фикстуры снимка).

## Boundary

- **Included:** §C спецификации.
- **Excluded:** другие разделы спецификации; режим < 1100 px; изменения Backend/ML; перезапуск docker-стека.

## Work items

- [ ] W1: Реализация §C.
  - Deliverable: коммит в ветке worktree; тесты `npm --prefix dashboard test` зелёные.
  - Contribution: закрывает свою часть единого ревью.
  - Proxy result: изменения без обновлённых тестов или без скриншотов.
- [ ] W2: Доказательства.
  - Deliverable: скриншоты до/после 1920×1080 и 1366×768 в `artifacts/` этой задачи + handoff.md (что сделано, отклонения, остаток, затронутые функции).
  - Contribution: T-19 интегрирует без повторного выяснения.
  - Proxy result: «сделано» без скриншотов.

## Verification

- `npm --prefix dashboard test` и `npm --prefix dashboard run build` проходят в worktree.
- Скриншоты через preview.mjs показывают требования §C на обоих размерах.
