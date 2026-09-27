---
schema: task.v3
id: T-19
title: "UX: интеграция, проверка и выпуск правок диспетчерского экрана"
status: planned
review_required: qa
plan_review_profile: none
plan_review_gate: none
type: feature
priority: p1
owner: claude
created_at: "2026-09-27T17:43:15.943Z"
updated_at: "2026-09-27T18:22:56.009Z"
parent: null
depends_on: []
gstack_refs: {}
goal_contract: v1
stream: T
---
# T-19: UX: интеграция, проверка и выпуск правок диспетчерского экрана

## Outcome

Primary goal: правки T-15…T-18 объединены в `dev` одной веткой и PR, бандл пересобран, сценарии §V единой спецификации пройдены на 1920×1080 и 1366×768, независимый QA принял результат; после приёмки — commit, push, PR, merge.
Direction: on-track
Comment: Спецификация — `.tasks/T-13-2026-09-27-ux-ui-claude-t-12/artifacts/merged-spec.md` §V. Пользователь 2026-09-27: «Коммит, push, PR, merge — делаем после закрытия тасок, если есть чужие изменения — можем их коммитить тоже».

## Decisions

- Ветка интеграции `ux/dispatcher-layout` от актуального `dev`; ветки worktree T-15…T-18 вливаются по очереди: T-17 → T-16 → T-18 → T-15 (от наименее к наиболее конфликтной по `app.js`/`index.html`).
- Параллельные незакоммиченные изменения соседних сессий (T-14 «Настройки оператора: выбор своих маршрутов», T-7) не перетирать: сначала попросить владельцев закоммитить, затем вливать. Пользователь разрешил закоммитить чужие изменения, если они готовы; решение о готовности — по владельцу сессии.
- Бандл `consumer/static/*` собирается один раз после слияния.

## Boundary

- **Included:** слияние, разрешение конфликтов, сборка, тесты, браузерная проверка §V, QA, ship.
- **Excluded:** новые UX-требования сверх спецификации; перезапуск общего docker-стека без согласования с соседними сессиями.

## Work items

- [ ] W1: Слияние T-15…T-18 и сборка.
  - Deliverable: ветка интеграции, зелёные `npm --prefix dashboard test`, `pytest`, сборка.
  - Contribution: единая версия.
  - Proxy result: ветки не слиты или бандл не пересобран.
- [ ] W2: Проверка §V.
  - Deliverable: скриншоты и результаты сценариев 1–10 в `artifacts/`.
  - Contribution: доказательство эффекта.
  - Proxy result: проверка только одного размера окна.
- [ ] W3: QA и ship.
  - Deliverable: QA ACCEPTED; commit, push, PR в `dev`, merge.
  - Contribution: изменения в `dev`.
  - Proxy result: локальный коммит без push/PR.

## Verification

- `npm --prefix dashboard test`, `npm --prefix dashboard run build`, `python -m pytest -q` зелёные.
- Сценарии §V 1–10: каждый с отметкой pass/fail и скриншотом.
- `gh pr view` показывает merged.
