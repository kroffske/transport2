---
schema: task.v3
id: T-3-data-audit
title: Провести аудит данных и EDA
status: done
review_required: none
plan_review_profile: none
plan_review_gate: none
type: research
priority: p0
owner: manager
created_at: 2026-09-25T19:32:30.710Z
updated_at: 2026-09-25T21:41:09.785Z
parent: T-3
depends_on: []
gstack_refs: {}
goal_contract: v1
---

# T-3-data-audit: Провести аудит данных и EDA

## Outcome

Primary goal: Зафиксировать качество, grain, временную доступность и ограничения полного официального датасета так, чтобы следующий executor мог выбрать честный split и признаки без повторного исследования источников.

Direction: on-track

## Goal alignment

Direction: on-track

Это первый обязательный срез T-3; он снимает неопределённость до baseline и model work.

## Parent alignment

Parent task: T-3
Parent goal: Получить на полном официальном датасете воспроизводимую модель задержки, которая честно сравнивается с baseline, формирует локально валидный `submission.csv` и создаёт evidence для C1 без point-in-time leakage.
Contribution: устанавливает проверенный data contract и решения, от которых зависят split, features и метрики.
Proxy result: красивый EDA без grain/join/time-availability выводов и без handoff для baseline.

## Decisions

- Основной результат — проверяемые факты и решения; notebook является читаемым представлением, не единственным вычислительным владельцем.
- Validate исследуется только по входной schema/coverage; targets не предполагаются и не реконструируются.
- Фактическое расписание и target используются только для label/evaluation, не как признаки в момент T.
- Аудит ведёт реестр ранее просмотренных выборок и target-результатов. После выбора локального holdout его target distribution не раскрывается до freeze model contract; уже экспонированный `labels_test` таким holdout не считается.

## Boundary

### Included

- **Full data audit** — schema, row counts, keys, duplicates, missingness, times, vehicles, schedules, labels и validate points.
- **Availability audit** — какие поля реально известны к T и где возможна leakage.
- **EDA** — target/feature distributions, малый объём, смена периодов и synthetic-vs-real provenance, насколько доступно.
- **Handoff** — рекомендуемый split и список обязательных checks для baseline.

### Excluded

- **Training** — обучение кандидатов и tuning.
- **Final split authority** — baseline task принимает split после проверки рекомендаций.

## Work items

- [x] W1: Создать data-quality evidence и EDA notebook
  - Deliverable: `notebooks/01_data_audit.ipynb` и task-local report с таблицами grain, availability, missingness, duplicates, time ranges и target distributions.
  - Contribution: даёт baseline task проверяемую основу для split и features.
  - Proxy result: notebook, который нельзя rerun с нуля или который не заканчивается решениями.
- [x] W2: Передать split recommendations
  - Deliverable: короткий decision block с допустимыми окнами, purge/gap рисками, test usage и unresolved gaps.
  - Contribution: предотвращает random split и leakage.
  - Proxy result: общая рекомендация «использовать time split» без конкретных данных.

## Verification

- Fresh notebook run читает только `data/` и завершается без скрытого state.
- Row counts и schemas сверены для 10 CSV; наличие и hash проверены для README, NDTP-спецификации и Docker tar.
- Все joins имеют заявленный grain и проверку many-to-many.
- Availability matrix явно запрещает target, будущую телеметрию и фактическое расписание в features.
- Report называет факты, интерпретации и gaps отдельно.
- Exposure registry отдельно отмечает результаты, уже опубликованные в `reference/initial-solution/RESULTS.md` и `artifacts/`.

## Execution log

## Closure

Полный аудит сохранён в `../../artifacts/data_audit.md` и
`../../artifacts/data_audit.json`. Он покрывает все 10 CSV и три
вспомогательных источника, фиксирует grain/joins/availability, exposure
382/473 audit-точек и quarantine реконструируемого validate proxy.

Воспроизводимость и выводы независимо подтверждены в `../../qa.md`
(`REQ-001`–`REQ-003`, verdict `ACCEPTED`).
