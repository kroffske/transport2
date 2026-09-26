---
schema: task.v3
id: T-3-evaluation
title: Провести финальную оценку и собрать submission
status: done
review_required: none
plan_review_profile: none
plan_review_gate: none
type: feature
priority: p0
owner: manager
created_at: 2026-09-25T19:32:31.173Z
updated_at: 2026-09-25T21:41:12.332Z
parent: T-3
depends_on: [ T-3/modeling ]
gstack_refs: {}
goal_contract: v1
---

# T-3-evaluation: Провести финальную оценку и собрать submission

## Outcome

Primary goal: Выполнить зафиксированную локальную оценку locked model с честно описанной ограниченной независимостью, собрать полный validate submission и доказать его schema, coverage и воспроизводимость без внешней загрузки.

Direction: on-track

## Goal alignment

Direction: on-track

Это финальный локальный срез T-3 и источник артефакта для отдельно разрешённой platform submission.

## Parent alignment

Parent task: T-3
Parent goal: Получить на полном официальном датасете воспроизводимую модель задержки, которая честно сравнивается с baseline, формирует локально валидный `submission.csv` и создаёт evidence для C1 без point-in-time leakage.
Contribution: превращает выбранную модель в проверенный result package и локально валидный submission.
Proxy result: CSV, который существует, но не имеет полного sample coverage или не воспроизводится.

## Decisions

- Model/hyperparameters/thresholds locked до открытия final audit results.
- Evaluation сообщает ограничения; плохой audit не запускает silent retuning.
- Platform upload и score readback остаются внешней границей пользователя.
- `labels_test` и прежние опубликованные результаты помечаются как exposed; локальный report не называет их unseen period.

## Boundary

### Included

- **Locked audit** — final local metrics и segment diagnostics.
- **Validate inference** — полный prediction path на official validate.
- **Submission validation** — schema, order/coverage, duplicates, missing и numeric values.
- **Result package** — notebook, metrics, metadata, model и submission.

### Excluded

- **Retuning after audit** — только отдельный replan/new window.
- **Platform upload** — не выполнять без отдельного разрешения.

## Work items

- [x] W1: Выполнить зафиксированную локальную оценку
  - Deliverable: `notebooks/04_evaluation.ipynb` и metrics report с exposure registry, точной схемой split и limitations.
  - Contribution: проверяет воспроизводимость и относительное поведение кандидата, не преувеличивая независимость данных.
  - Proxy result: ранее опубликованные test metrics, переименованные в unseen audit.
- [x] W2: Собрать и проверить submission
  - Deliverable: `submission.csv`, validation report и documented generation command.
  - Contribution: создаёт готовый локальный артефакт C1.
  - Proxy result: predictions без шаблона, sample coverage или readback.
- [x] W3: Подготовить result handoff
  - Deliverable: model metadata, metrics table, artifact paths и platform-upload checklist без выполнения upload.
  - Contribution: позволяет пользователю безопасно принять следующее внешнее действие.
  - Proxy result: сообщение «готово» без файлов и ограничений.

## Verification

- Fresh-process command воспроизводит audit и submission from documented inputs.
- Submission имеет ровно две колонки `sample_id;prediction`, полный validate coverage, 0 duplicates/missing/non-numeric.
- Hash model/split/features записан рядом с результатом.
- QA подтверждает отсутствие доступа к validate target и отсутствие post-audit tuning.

## Execution log

## Closure

Locked local audit дал MAE 66.4011886321632 с для residual против
74.1923890063425 с у `cur_dev_s` и 77.32980972515857 с у zero. Отдельный
submission model переобучен на всех 4434 train labels; его audit score не
заявляется.

Корневой `submission.csv` содержит 151 строку в порядке шаблона и прошёл
disk readback. Evidence: `../../artifacts/model_evaluation.md`,
`../../artifacts/submission_validation.json` и `../../qa.md`
(`REQ-007`–`REQ-010`). Platform upload не выполнялся.
