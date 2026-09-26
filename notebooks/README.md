# Ноутбуки T-3

Четыре ноутбука читаются и выполняются по порядку. Повторно используемая логика данных, признаков, обучения и проверки CSV находится в transport_ml/; outputs в notebooks показывают результаты уже зафиксированного run.

1. 01_data_audit.ipynb — десять официальных CSV, связность, качество и реестр предыдущей экспозиции audit.
2. 02_baselines.ipynb — фиксированные временные границы, maturity purge и три обязательных baseline.
3. 03_modeling.ipynb — CatBoost direct/residual, выбор по tune и повторная локальная audit оценка.
4. 04_evaluation.ipynb — локальные метрики, отличия evaluation_model от submission_model и проверка submission.csv.

Из корня проекта, в новом окружении:

```bash
uv venv .venv
uv pip install --python .venv/bin/python -r requirements-notebooks.txt
export TRANSPORT_MODEL_RUN=artifacts/t3-fresh-run-01
.venv/bin/python -m transport_ml.audit --data-dir data --out .tasks/T-3-2026-09-25-ml-submission/artifacts
.venv/bin/python -m transport_ml.train --data-dir data --context train --availability received --out "$TRANSPORT_MODEL_RUN/evaluation_model" --iterations 300 --depth 5 --seed 42
.venv/bin/python -m transport_ml.predict --data-dir data --model-dir "$TRANSPORT_MODEL_RUN/submission_model" --output submission.csv --report .tasks/T-3-2026-09-25-ml-submission/artifacts/submission_validation.json
for notebook in notebooks/01_data_audit.ipynb notebooks/02_baselines.ipynb notebooks/03_modeling.ipynb notebooks/04_evaluation.ipynb; do
  .venv/bin/jupyter nbconvert --execute --to notebook --inplace "$notebook"
done
```

Имя `TRANSPORT_MODEL_RUN` должно указывать на новый пустой каталог для обучения; поменяйте суффикс при повторе. Без переменной notebooks читают сохранённый artifacts/t3-full-received-v2/. Каждый nbconvert запуск создаёт новый kernel и выполняет cells сверху вниз. Этот порядок не загружает submission на платформу.

У текущего audit ограниченная историческая независимость: 382/473 его sample_id уже встречались в прежних audit artifacts. labels_test тоже ранее просмотрен. Реконструируемый validate target proxy из test schedule исключён из оценки и inference.
