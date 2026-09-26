---
schema: task.v3
id: T-3-baseline
title: Зафиксировать point-in-time split и baseline
status: done
review_required: none
plan_review_profile: none
plan_review_gate: none
type: feature
priority: p0
owner: manager
created_at: 2026-09-25T19:32:30.856Z
updated_at: 2026-09-25T21:41:10.532Z
parent: T-3
depends_on: [ T-3/data-audit ]
gstack_refs: {}
goal_contract: v1
---

# T-3-baseline: Зафиксировать point-in-time split и baseline

## Outcome

Primary goal: Зафиксировать воспроизводимый point-in-time split, evaluator и обязательные baseline, с которыми будут честно сравниваться все модели T-3.

Direction: on-track

## Goal alignment

Direction: on-track

Срез начинается после data-audit decisions и создаёт общий контракт для modeling/evaluation.

## Parent alignment

Parent task: T-3
Parent goal: Получить на полном официальном датасете воспроизводимую модель задержки, которая честно сравнивается с baseline, формирует локально валидный `submission.csv` и создаёт evidence для C1 без point-in-time leakage.
Contribution: задаёт сравнимую временную проверку и нижнюю границу качества.
Proxy result: обученная CatBoost-модель без общего evaluator и baseline comparators.

## Decisions

- Split формируется по времени и доступности меток, с документированным purge/gap.
- Официальный `labels_test` считается ранее просмотренным диагностическим набором. Data audit определяет воспроизводимую локальную проверку и прямо маркирует её ограниченную независимость; ни один уже опубликованный result не называется новым holdout.
- Zero, fit median и `cur_dev_s` обязательны; текущая модель решения — дополнительный comparator.

## Boundary

### Included

- **Split/evaluator** — deterministic manifest, leakage guards и единые метрики.
- **Baselines** — zero, median, `cur_dev_s` и воспроизводимый existing comparator.
- **Notebook** — объяснение выбора split и результатов.

### Excluded

- **Broad modeling** — tuning и дополнительные architectures.
- **Final audit reuse** — audit не используется для выбора baseline или thresholds.

## Work items

- [x] W1: Реализовать split manifest и evaluator
  - Deliverable: reusable split/evaluation code и manifest с точными sample ids/timestamps.
  - Contribution: делает все последующие результаты сравнимыми.
  - Proxy result: split только внутри notebook без стабильного manifest.
- [x] W2: Рассчитать baseline table
  - Deliverable: `notebooks/02_baselines.ipynb` и metrics table для обязательных comparators.
  - Contribution: задаёт hurdle для model candidates.
  - Proxy result: одна итоговая MAE без segment diagnostics.

## Verification

- Повтор split command создаёт тот же manifest.
- Feature cutoff тесты запрещают `event_time > T` и future schedule fact.
- Sensitivity-check для потока проверяет `receive_time <= T`, late packets и порядок cutoff → dedup; отсутствие received-time в конкретном offline path отражается как ограничение.
- Все baseline проходят один evaluator и одинаковые rows.
- Metrics содержат MAE и заявленные diagnostics по segments.

## Execution log

## Closure

Зафиксирован календарный split с границами 14:00/17:30/20:30 и maturity
purge: fit 2540, tune 750, calibration 392, audit 473. Общий evaluator
сравнивает zero, fit median и `cur_dev_s` на одинаковых строках.

Manifest и baseline metrics находятся в
`../../../../artifacts/t3-full-received-v2/evaluation_model/`; независимая
проверка — `../../qa.md`, `REQ-003` и `REQ-005`.
