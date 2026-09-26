# Планирование T-3

## Q0: Goal alignment

Question: является ли получение первой модели правильным следующим критическим путём?
Source check: `.locus/soul.md`, `.locus/goal.md`, `.locus/roadmap.md`, `docs/prd/evaluation-scorecard.md`.
Answer: T-3 реализует near-term north-star и самый ранний источник официальных баллов. System work не должно блокировать получение честного ML evidence.
Status: source-proven
Direction: on-track
Consequence: активируется T-3/data-audit; T-4 остаётся draft до фиксации model contract.

## Proposed execution graph

```text
T-3/data-audit
        ↓ data contract + decisions
T-3/baseline
        ↓ frozen split + evaluator
T-3/modeling
        ↓ selected candidate
T-3/evaluation
        ↓ model + local submission
      QA
```

Data audit и точный инвентарь кода могут выполняться параллельно read-only. Пишущие workers запускаются последовательно по графу, поскольку split/evaluator являются общим контрактом.

## Notebook and code ownership

| Slice | Notebook/evidence | Primary code ownership |
|---|---|---|
| data-audit | `notebooks/01_data_audit.ipynb`, task artifacts | read-only source analysis; решения возвращаются parent |
| baseline | `notebooks/02_baselines.ipynb`, split manifest | `transport_ml/data.py`, `transport_ml/validation.py` |
| modeling | `notebooks/03_modeling.ipynb`, experiment table | `transport_ml/features.py`, `transport_ml/train.py`, `transport_ml/neural.py` |
| evaluation | `notebooks/04_evaluation.ipynb`, submission report | `transport_ml/inference.py`, `transport_ml/predict.py`, final artifacts |

`transport_ml/service.py` не меняется в T-3, если только локальный inference contract нельзя проверить иначе; изменение публичного ML API возвращается в планирование и согласуется с T-4.

## Metrics

- Primary local metric: MAE в секундах, меньше лучше.
- Diagnostics: RMSE, P95 absolute error, signed bias, доля ошибок ≤30/60 секунд, MAE по `early/ontime/late` и по ТС.
- Early-warning diagnostics: подгруппа `cur_dev_s <= 120`, чтобы модель не выигрывала только повтором уже известного опоздания.
- Platform score не выводится локально без официальных скрытых констант и readback.

## Pressure pass

- Малые данные делают random split и широкий tuning особенно опасными.
- `labels_test` по названию не гарантирует независимость; EDA обязана проверить даты, ТС и повторяющиеся target events.
- Current artifacts могут быть полезны как comparator, но не как evidence на полном датасете.
- GRU/Transformer не обязателен: сохранить только при честном incremental gain.
- Один notebook со всем pipeline усложняет review и rerun; четыре последовательных notebook дают понятные gates, но reusable code остаётся в package.

## Agent roster for execution

- Parent/PM: фиксирует contracts, принимает evidence, не обучает конкурирующую модель параллельно workers.
- Data-quality leg: read-only analysis, реестр ранее просмотренных выборок и рекомендации по split.
- Baseline worker: владеет split/evaluator и обязательными comparators.
- Modeling worker: работает только после freeze baseline contract.
- Evaluation worker: не меняет training selection; проверяет locked candidate и submission.
- QA agent: независимый fresh-process rerun по acceptance criteria.

## Known evaluation limitation

`labels_test` уже использован начальным решением; опубликованные метрики и текущие hashes подтверждают экспозицию. Поэтому локальная оценка может проверять воспроизводимость и относительное поведение, но не является новым unseen evidence. Подтверждение C1 требует скрытого validate platform readback после отдельного разрешения на upload.

## Handoff

Первым запускается T-3/data-audit. До его решений T-3/baseline не фиксирует split, а modeling/evaluation остаются planning-only.
