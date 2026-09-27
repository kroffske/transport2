---
schema: task.v3
id: T-17
title: "UX: обозначения ролей остановок на карте и легенда"
status: review
review_required: qa
plan_review_profile: none
plan_review_gate: none
type: feature
priority: p1
owner: claude
created_at: "2026-09-27T17:42:57.531Z"
updated_at: "2026-09-27T17:57:14.754Z"
parent: null
depends_on: []
gstack_refs: {}
goal_contract: v1
stream: T
---
# T-17: UX: обозначения ролей остановок на карте и легенда

## Outcome

Primary goal: на карте пройденные, предстоящие, целевая и последующие остановки различаются формой и штрихом без опоры на цвет; цвет серьёзности только у ТС.
Direction: on-track
Comment: Часть объединённого UX-ревью (T-12 GPT + T-13 Claude). Требования — `.tasks/T-13-2026-09-27-ux-ui-claude-t-12/artifacts/merged-spec.md` раздел §S. Параллельно идут T-15…T-18 в отдельных git worktree; интеграция и приёмка — T-19.

## Decisions

- Требования и тексты берутся дословно из `.tasks/T-13-2026-09-27-ux-ui-claude-t-12/artifacts/merged-spec.md` §S; отклонения записываются в Execution log с причиной.
- Работа в отдельном git worktree от `dev`; владение файлами: dashboard/route-layers.js, dashboard/map-symbols.js (+тесты), легенда в consumer/index.html, стили легенды и токены --stop-* в dashboard/style.css. Чужие области не трогать; если без этого нельзя — минимальная правка и запись в handoff.
- Собранный бандл `consumer/static/*` не коммитить (его пересобирает T-19). Коммит в ветке worktree — да; push/PR/merge — только в T-19.
- Проверка без трогания общего стека: `.tasks/T-13-2026-09-27-ux-ui-claude-t-12/artifacts/tools/preview.mjs` (подменяет index.html/app.js/app.css сборкой worktree, API живой, есть фикстуры снимка).

## Boundary

- **Included:** §S спецификации.
- **Excluded:** другие разделы спецификации; режим < 1100 px; изменения Backend/ML; перезапуск docker-стека.

## Work items

- [x] W1: Реализация §S.
  - Deliverable: коммит в ветке worktree; тесты `npm --prefix dashboard test` зелёные.
  - Contribution: закрывает свою часть единого ревью.
  - Proxy result: изменения без обновлённых тестов или без скриншотов.
- [x] W2: Доказательства.
  - Deliverable: скриншоты до/после 1920×1080 и 1366×768 в `artifacts/` этой задачи + handoff.md (что сделано, отклонения, остаток, затронутые функции).
  - Contribution: T-19 интегрирует без повторного выяснения.
  - Proxy result: «сделано» без скриншотов.

## Verification

- `npm --prefix dashboard test` и `npm --prefix dashboard run build` проходят в worktree.
- Скриншоты через preview.mjs показывают требования §S на обоих размерах.
