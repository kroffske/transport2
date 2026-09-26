---
schema: task.v3
id: T-3
title: "Получить первую валидную ML-модель и submission"
status: done
review_required: qa
plan_review_profile: standard
plan_review_gate: advisory
type: feature
priority: p0
owner: manager
created_at: "2026-09-25T19:32:16.466Z"
updated_at: "2026-09-25T21:41:13.333Z"
parent: null
depends_on: []
gstack_refs: {}
goal_contract: v1
stream: T
workflow: feature
---

# T-3: Получить первую валидную ML-модель и submission

## Outcome

Primary goal: Получить на полном официальном датасете воспроизводимую модель задержки, которая честно сравнивается с baseline, формирует локально валидный `submission.csv` и создаёт evidence для C1 без point-in-time leakage.

Direction: on-track

Результат задачи — не просто обученный файл модели, а воспроизводимый путь от аудита данных до проверенного submission и понятного отчёта об ограничениях.

## Goal alignment

Direction: on-track

T-3 является Phase 1 текущего goal и первым критическим путём roadmap. Он напрямую создаёт evidence для C1 и основу онлайн-проверки C2.

## Decisions

- Все эксперименты используют один зафиксированный point-in-time data contract и временной split; random split не является основным доказательством.
- Обязательные comparators: нулевой прогноз, `cur_dev_s`, медиана fit-части и текущий baseline начального решения, если его можно воспроизвести без leakage.
- Notebook владеет анализом и объяснением; переиспользуемая подготовка данных, признаки, обучение и инференс принадлежат `transport_ml/`.
- Модели усложняются по evidence: CatBoost direct/residual обязателен; GRU/ансамбль выполняется только после честного baseline и в фиксированном бюджете.
- Официальный `labels_test` уже исследован в начальном решении и используется только как ранее виденный диагностический набор. Он не доказывает forward-time переносимость. Data audit фиксирует реестр экспонированных выборок и выбирает повторяемую локальную схему с честно описанной ограниченной независимостью; скрытый validate остаётся единственным внешним unseen readback.
- Плановый горизонт `target_time_begin - T` подтверждает корректную постановку прогнозной точки, но сам по себе не доказывает C2 — раннее предупреждение нового инцидента. Политика алертов и onset-evaluation принадлежат T-4.
- Внешняя загрузка submission не входит в задачу без отдельного разрешения. «Валидный» здесь означает локальный schema/coverage/readback; platform score появляется только после разрешённой загрузки.
- Parent координирует четыре дочерних среза. Параллельное исполнение разрешено только после фиксации data contract/split; агенты не меняют чужие owning surfaces.

## Boundary

### Included

- **Data understanding** — полный аудит train/test/validate, labels, schedule и telemetry с point-in-time рисками.
- **Reproducible notebooks** — EDA, baseline, experiments и final evaluation как читаемый путь анализа.
- **Reusable ML code** — необходимые изменения `transport_ml/` для данных, признаков, обучения, инференса и validation.
- **Model evidence** — split manifest, metrics, model metadata, selected artifact и locally validated submission.
- **Agent execution structure** — дочерние задачи T-3/data-audit, baseline, modeling и evaluation с раздельным владением.

### Excluded

- **Platform action** — загрузка submission и получение leaderboard score без отдельного разрешения.
- **Streaming product** — NDTP ingest, Backend, dashboard и Docker end-to-end принадлежат T-4.
- **Unbounded search** — широкий AutoML, большое число нейросетевых архитектур и tuning по final audit.
- **Unsupported claims** — scorecard C1 не повышается до внешнего platform readback.

## Work items

- [x] W1: T-3/data-audit — аудит данных и EDA
  - Deliverable: data-quality report и `notebooks/01_data_audit.ipynb` фиксируют grain, временные диапазоны, missingness, duplicates, target distribution, leakage risks и доступный raw context.
  - Contribution: определяет, какие эксперименты честны и выполнимы на малых данных.
  - Proxy result: несколько графиков без проверок join/grain/availability и без решений для baseline.
- [x] W2: T-3/baseline — split и обязательные baseline
  - Deliverable: split manifest, `notebooks/02_baselines.ipynb` и reusable validation сравнивают обязательные baseline на одних временных окнах.
  - Contribution: создаёт нижнюю границу качества и общий контракт сравнения моделей.
  - Proxy result: одна CatBoost-модель без нулевого/`cur_dev_s` comparator или на random split.
- [x] W3: T-3/modeling — ограниченное сравнение моделей
  - Deliverable: `notebooks/03_modeling.ipynb`, воспроизводимая training command и metrics table сравнивают CatBoost direct/residual и только оправданные дополнительные кандидаты.
  - Contribution: выбирает модель по заранее заданной проверке, а не по удобному отдельному прогону.
  - Proxy result: лучший train score или ensemble без единого split и ablation.
- [x] W4: T-3/evaluation — locked evaluation и submission
  - Deliverable: `notebooks/04_evaluation.ipynb`, final model metadata, audit metrics и полный `submission.csv` с проверенным schema/coverage.
  - Contribution: превращает эксперимент в готовый локальный артефакт C1.
  - Proxy result: файл предсказаний без sample coverage, воспроизводимости или readback.
- [x] W5: Независимая QA модельного пути
  - Deliverable: QA повторяет ключевой путь в свежем процессе, проверяет leakage guards, метрики, deterministic seed и submission validator.
  - Contribution: подтверждает, что результат не зависит от состояния notebook или скрытого будущего.
  - Proxy result: self-check автора или успешное открытие готового notebook.

## Verification

- Data contract -> joins и grain checks на полном наборе -> нет скрытого many-to-many, target/validate разделены, признаки используют только данные `event_time <= T`.
- Split -> manifest и тесты -> временные окна воспроизводимы, train/tune/calibration не пересекаются по доступности меток; любой повторный local audit маркирован как ранее экспонированный и не выдаётся за новый unseen period.
- Baselines -> единый metrics table -> zero, median и `cur_dev_s` рассчитаны тем же evaluator, что модель.
- Model selection -> повтор training command с фиксированным seed -> тот же schema/artifact metadata и метрики в допустимом tolerance.
- Submission -> validator -> ровно `sample_id;prediction`, полное покрытие validate, нет дублей, пропусков и нечисловых значений.
- QA -> свежий процесс от documented command -> повторная локальная оценка и submission воспроизводятся без notebook state; report явно отделяет локальную диагностику от будущего platform readback.


## Execution log

## Closure

На полном официальном train-наборе построен воспроизводимый received-time
ML path от data audit до локально валидного submission. Residual CatBoost
выбран до audit; locked local MAE — 66.4011886321632 с на 473 точках.
Отдельный submission model обучен на всех 4434 train labels, а
`submission.csv` содержит 151 валидный прогноз в порядке шаблона.

Ограничение evidence явно сохранено: 382/473 audit-точек ранее
экспонировались, validate target технически реконструируем из factual test
schedule и поэтому quarantined, platform upload/readback отсутствует.
Astra review: `artifacts/astra-code-review.md`, verdict `PASS`, 8.2/10.
Независимая QA: `qa.md`, verdict `ACCEPTED`, `REQ-001`–`REQ-010` PASS.
