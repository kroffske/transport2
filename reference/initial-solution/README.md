# Предиктор задержек: ML starter kit

План ML System Design, воспроизводимое обучение CatBoost/PyTorch, калибровка риска,
временная проверка, генератор submission и stateless ML API.

**Данные:** приложенный `dataset-2.zip`, а не непроверенное содержимое публичного архива.
**Статус:** исследовательский baseline; не готовый промышленный NDTP-диспетчер.

## Что читать сначала

`MLSD.md` — постановка, архитектура, признаки, валидация, метрики и план реализации.
`DATA_AUDIT.md` — проверка комплектности и качества данных.
`RESULTS.md` — реально измеренные результаты и ограничения.
`docs/dataset_README.md` — оригинальная инструкция организаторов из архива.

## Установка

Из каталога проекта, Python **3.12 или новее**:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
# CPU-вариант PyTorch. Для CUDA установите соответствующую сборку PyTorch.
python -m pip install -r requirements-torch.txt --index-url https://download.pytorch.org/whl/cpu
```

В Windows активация: `.venv\Scripts\activate`.
Код обучения и тесты проверены в среде Python 3.13.5, CatBoost 1.2.8,
PyTorch 2.10.0+cpu; версии вспомогательных библиотек зафиксированы в requirements.
Dockerfile использует Python 3.12; сборка Docker и GPU-запуск здесь **не проверялись**.

## Подготовка файлов

Распакуйте **доверенный** архив в каталог `data`, сохранив его структуру.
Не помещайте файлы labels в features и не копируйте факт расписания в plan-only признаки.

```text
data/
  labels/labels_train.csv
  labels/labels_test.csv
  test/traffic.csv
  test/schedule.csv
  sample_submission.csv
```

В приложенном архиве отсутствуют `train/`, `validate/` и образ эмулятора.
Поэтому предусмотрены два ЯВНО различных режима. `available` — осознанное совместное
использование только входной телеметрии и плана из доступных train/test.
`labels-only` — модель на полях прогнозной точки без телеметрии.
`train` — обычный режим для полного набора, требует train/traffic.csv и train/schedule.csv.

## Воспроизвести аудит и обучение на приложенном архиве

```bash
python -m transport_ml.audit --data-dir data --out audit.json

# Признаки контекста для 1 141 train-точки с найденным raw context;
# еще 3 293 строки без такого контекста явно исключаются из этого эксперимента.
python -m transport_ml.train \
  --data-dir data --context available \
  --out artifacts/my_context --iterations 500 --train-gru --epochs 25

# Отдельный fallback на всех 4 434 train-строках, включая синтетическую часть.
python -m transport_ml.train \
  --data-dir data --context labels-only \
  --out artifacts/my_core --iterations 500

python -m pytest -q
```

Готовые результаты этих запусков уже лежат в `artifacts/context` и `artifacts/core`.
Повторный запуск требует **нового** `--out`: программа не перезаписывает готовую модель.
Нет необходимости повторно обучать модель только ради проверки API.

Для полного датасета:

```bash
python -m transport_ml.train \
  --data-dir data --context train \
  --out artifacts/full_context --iterations 800 --train-gru --epochs 30
```

Для более строгого воспроизведения доступности в онлайн-системе добавьте
`--availability received`: тогда обязательны одновременно `event_time <= T` и
`receive_time <= T`. Режим по умолчанию `event` соответствует явно указанному
в README правилу соревнования. Модель запоминает выбранную политику;
нельзя обучить по одной политике и незаметно обслуживать по другой.

Опциональный GPU-запуск: `--catboost-device GPU --torch-device cuda`.
CPU Dockerfile не содержит CUDA; для GPU требуется отдельная совместимая среда.

## Что делает обучение

1. Валидирует контракт точек и горизонт `(600, 900]` секунд.
2. Строит 6 core-признаков или 85 признаков с контекстом; последовательность `60 × 9`.
3. Делит данные на хронологические fit / tune / calibration / audit блоки по
   55% / 15% / 15% / 15% уникальных временных отметок, а НЕ по процентам строк.
4. Удаляет пограничные строки, пока их фактический результат и окно следующего блока пересекаются.
5. Сравнивает zero, cur_dev, median, direct CatBoost, residual CatBoost и, опционально, GRU/смеси.
6. Выбирает модель и вес смеси ТОЛЬКО на tune.
7. Обучает отдельный классификатор `target_delay_s > 120`, калибрует на calibration.
8. Выбирает порог алерта на calibration; измеряет реальную precision/recall на audit.
9. Обучает квантили q10/q90; их 80% покрытие проверяется, но НЕ гарантируется.
10. Сохраняет модели, JSON-метрики, предсказания, состав сплитов и SHA-256 источников.

`labels_test` — дополнительная официальная локальная диагностика, а не независимый
future-day тест. Текущая версия **не переобучает** итоговую модель на всех метках после
оценки: сохраненные модели в точности соответствуют опубликованным метрикам.

## Генерация submission

Только после получения настоящих `validate/points.csv`, `validate/traffic.csv`
и `validate/schedule_plan.csv`:

```bash
python -m transport_ml.predict \
  --data-dir data --model-dir artifacts/context --output submission.csv
```

Для labels-only модели достаточно points и шаблона; телеметрия и план не требуются.
В любом случае points обязательны: код НЕ восстанавливает скрытые ответы из расписания
и НЕ выдумывает недостающие точки из sample_id.
Проверяются уникальность и полное совпадение ID с шаблоном, порядок, конечность чисел,
разделитель `;`, две колонки, отсутствие индекса. Отрицательные задержки сохраняются.
`submission.csv` в комплект намеренно не включен: scoring inputs в приложении отсутствуют.

## ML API

```bash
MODEL_DIR=artifacts/context FALLBACK_MODEL_DIR=artifacts/core \
  uvicorn transport_ml.service:app --host 0.0.0.0 --port 8000

curl -X POST http://localhost:8000/v1/predict \
  -H 'Content-Type: application/json' --data-binary @example_request.json
```

Swagger: `http://localhost:8000/docs`. Статическая схема: `docs/openapi.json`.
Сгенерированная PyDoc-документация модулей: `docs/pydoc/`.
Точка API получает уже декодированные данные, не бинарный NDTP.
Все времена должны быть заранее приведены к одной временной шкале датасета;
timezone-aware строки отвергаются, чтобы не было скрытого часового сдвига.

При отсутствии свежего контекста вызывается core-модель. `status=degraded`,
`alert=null`: отсутствие связи не окрашивается в зеленый. При отсутствии fallback
возвращается `cur_dev_s`, без вероятности и без уверенного алерта.
Рекомендации — диагностические шаблоны, не автоматические управляющие действия.

```bash
docker compose up --build
```

Compose поднимает **ML-сервис**, а не весь Backend/BI/NDTP стек.
Образы и CUDA в текущей среде не запускались; API проверен локально через TestClient.
Не публикуйте демонстрационный порт наружу без аутентификации, rate limit и лимитов тела запроса.

## Структура

```text
transport_ml/
  data.py          # схема, чтение, allowlist планового расписания
  features.py      # единые point-in-time признаки + последовательности
  validation.py    # time blocks, purge, метрики, bootstrap
  neural.py        # GRU, L1Loss, scaler fit-only, checkpoint
  train.py         # обучение, выбор, калибровка, аудит
  inference.py     # загрузка артефактов и общий инференс
  predict.py       # строгий submission
  service.py       # ML API и деградация
  audit.py         # воспроизводимый аудит источника; факт только для проверки
```

## Чего здесь нет

Промышленного TCP NDTP-приемника, дорожного map matching, состояния рейсов и device→vehicle
реестра, настоящего BI-интерфейса, event-level оценщика с разметкой начала инцидента,
модели причин, честного контрфактуального симулятора, будущих дней для проверки и полной
проверки на GPU/Docker. План их интеграции находится в `MLSD.md`.
