---
schema: task.v3
id: T-15
title: "UX: три колонки, панель карточки и кадр карты"
status: review
review_required: qa
plan_review_profile: none
plan_review_gate: none
type: feature
priority: p1
owner: claude
created_at: "2026-09-27T17:42:55.861Z"
updated_at: "2026-09-27T18:22:55.702Z"
parent: null
depends_on: []
gstack_refs: {}
goal_contract: v1
stream: T
---
# T-15: UX: три колонки, панель карточки и кадр карты

## Outcome

Primary goal: карточка автобуса открывается отдельной колонкой 440 px (Full HD) или панелью 420 px поверх карты (1100–1599 px) левее очереди; очередь и карточка прокручиваются независимо; кадр карты держит ТС, цель и подписи в видимой зоне.
Direction: on-track
Comment: Часть объединённого UX-ревью (T-12 GPT + T-13 Claude). Требования — `.tasks/T-13-2026-09-27-ux-ui-claude-t-12/artifacts/merged-spec.md` раздел §L. Параллельно идут T-15…T-18 в отдельных git worktree; интеграция и приёмка — T-19.

## Decisions

- Требования и тексты берутся дословно из `.tasks/T-13-2026-09-27-ux-ui-claude-t-12/artifacts/merged-spec.md` §L; отклонения записываются в Execution log с причиной.
- Работа в отдельном git worktree от `dev`; владение файлами: consumer/index.html (разметка колонок), dashboard/style.css (сетка/панели), dashboard/app.js (focusSelected, followSelected, открытие/закрытие карточки, Esc). Чужие области не трогать; если без этого нельзя — минимальная правка и запись в handoff.
- Собранный бандл `consumer/static/*` не коммитить (его пересобирает T-19). Коммит в ветке worktree — да; push/PR/merge — только в T-19.
- Проверка без трогания общего стека: `.tasks/T-13-2026-09-27-ux-ui-claude-t-12/artifacts/tools/preview.mjs` (подменяет index.html/app.js/app.css сборкой worktree, API живой, есть фикстуры снимка).

## Boundary

- **Included:** §L спецификации.
- **Excluded:** другие разделы спецификации; режим < 1100 px; изменения Backend/ML; перезапуск docker-стека.

## Work items

- [x] W1: Реализация §L.
  - Deliverable: коммит в ветке worktree; тесты `npm --prefix dashboard test` зелёные.
  - Contribution: закрывает свою часть единого ревью.
  - Proxy result: изменения без обновлённых тестов или без скриншотов.
- [x] W2: Доказательства.
  - Deliverable: скриншоты до/после 1920×1080 и 1366×768 в `artifacts/` этой задачи + handoff.md (что сделано, отклонения, остаток, затронутые функции).
  - Contribution: T-19 интегрирует без повторного выяснения.
  - Proxy result: «сделано» без скриншотов.

## Verification

- `npm --prefix dashboard test` и `npm --prefix dashboard run build` проходят в worktree.
- Скриншоты через preview.mjs показывают требования §L на обоих размерах.
