---
schema: task.v3
id: T-3-modeling
title: Сравнить модели и выбрать финальный кандидат
status: done
review_required: none
plan_review_profile: none
plan_review_gate: none
type: feature
priority: p0
owner: manager
created_at: 2026-09-25T19:32:31.020Z
updated_at: 2026-09-25T21:41:11.425Z
parent: T-3
depends_on: [ T-3/baseline ]
gstack_refs: {}
goal_contract: v1
---

# T-3-modeling: Сравнить модели и выбрать финальный кандидат

## Outcome

Primary goal: Сравнить ограниченный набор модельных гипотез на frozen split/evaluator и выбрать один финальный кандидат с воспроизводимым artifact и объяснённым выигрышем.

Direction: on-track

## Goal alignment

Direction: on-track

Срез улучшает C1 только поверх принятого baseline contract; он не может менять audit после просмотра результатов.

## Parent alignment

Parent task: T-3
Parent goal: Получить на полном официальном датасете воспроизводимую модель задержки, которая честно сравнивается с baseline, формирует локально валидный `submission.csv` и создаёт evidence для C1 без point-in-time leakage.
Contribution: выбирает модель, которая улучшает честный baseline без разрастания experiment search.
Proxy result: лучший отдельный run без общей таблицы, seed и frozen split.

## Decisions

- Первая пара кандидатов — CatBoost direct и residual к `cur_dev_s`.
- GRU/ensemble допускается только как ограниченный follow-up с incremental evidence.
- Tuning использует только fit/tune/calibration; final audit остаётся locked.

## Boundary

### Included

- **Features** — только point-in-time safe признаки, согласованные data/baseline tasks.
- **Candidates** — direct/residual CatBoost и не более одного оправданного sequence/ensemble follow-up.
- **Artifacts** — config, seed, schema, model files и metrics table.

### Excluded

- **Unbounded tuning** — AutoML и широкие architecture sweeps.
- **Serving system** — FastAPI/Backend/dashboard integration.

## Work items

- [x] W1: Сравнить direct и residual CatBoost
  - Deliverable: воспроизводимые runs и одна metrics/ablation table против baseline.
  - Contribution: проверяет сильные tabular hypotheses для малых данных.
  - Proxy result: один run без ablation и segment diagnostics.
- [x] W2: Проверить оправданную дополнительную модель
  - Deliverable: documented go/no-go и, только при go, один bounded sequence/ensemble experiment.
  - Contribution: добавляет сложность только при наблюдаемом выигрыше.
  - Proxy result: нейросеть ради соответствия рекомендованному стеку.
- [x] W3: Зафиксировать финального кандидата
  - Deliverable: `notebooks/03_modeling.ipynb`, final config, artifact metadata и selection rationale.
  - Contribution: передаёт evaluation locked model без ambiguity.
  - Proxy result: несколько «лучших» моделей без одного выбранного кандидата.

## Verification

- Training rerun с тем же seed воспроизводит schema и метрики в tolerance.
- Artifact metadata содержит split hash, feature schema и source files.
- Выбранный кандидат превосходит declared hurdle или явно фиксируется stop/pivot.
- Final audit не читается до передачи в evaluation task.

## Execution log

## Closure

Direct и residual CatBoost сравнены на frozen split. Residual выбран по
tune до открытия audit; дополнительная модель не запускалась, потому что
предварительно установленный go/no-go не оправдывал усложнение. Выбранный
evaluation artifact и provenance сохранены в
`../../../../artifacts/t3-full-received-v2/evaluation_model/`.

Результат прошёл Astra review (`../../artifacts/astra-code-review.md`) и
независимую QA (`../../qa.md`, `REQ-006`–`REQ-007`).
