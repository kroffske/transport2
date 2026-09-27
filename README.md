# transport2 — предиктор изменений в движении транспорта

Система прогнозирует опоздание транспорта на остановке через 10–15 минут и показывает результат на диспетчерской карте Москвы. Docker запускает три связанных модуля: ML-ядро, Backend и веб-дашборд. Для демонстрации официальный эмулятор NDTP передаёт GPS-точки из исторического датасета; Backend строит контекст по расписанию, вызывает модель и передаёт прогнозы в дашборд.

Инструкция ниже рассчитана на первый запуск из свежего clone. Подробный маршрут проверки — в [инструкции для жюри](docs/runbooks/jury-demo.md), тексты полей сдачи — в [пакете загрузки решения](docs/submission-form.md).

Выбранная CatBoost-модель имеет локальный MAE 44.01 с на validate и 45.00 с на test. Она обучена на 4 139 строках после исключения синтетических копий validate/test-прибытий; validate разрешён для выбора модели, но не включается в fit. Платформа Data Science показывает для корневого `submission.csv` score 1,0 (подтверждение команды 2026-09-27, см. [форму сдачи](docs/submission-form.md#c1-точность-модели)). Потоковый detector не сохраняет автоматически этот offline MAE.

## Быстрый путь для жюри

### 1. Подготовьте окружение и репозиторий

Нужны Git, работающий Docker Engine / Docker Desktop с Compose v2 или новее и браузер. При первой сборке нужен интернет для базового Python-образа и зависимостей. Python и Node.js на компьютере устанавливать не нужно: модель, карта и собранный интерфейс уже входят в репозиторий. Освободите порты `8000`, `8001`, `8002`, `9201` и `18080`.

```bash
git clone https://github.com/kroffske/transport2.git
cd transport2
docker version
docker compose version
```

Для демо нужны три файла из официальной раздачи организаторов. Они не хранятся в Git и не скачиваются автоматически. Скопируйте их в следующие каталоги от корня `transport2`:

| Путь | Байт | SHA-256 |
|---|---:|---|
| `data/validate/traffic.csv` | 17117773 | `3c74bb9d3cc5e076a2e7f89de7e78fb103c350757d16c9d629de651ee09bf517` |
| `data/validate/schedule_plan.csv` | 683160 | `c9b561743a5cb83616941b02b47c5aded89e75218d93c13a282a2e8c790787c8` |
| `data/emulator/ndtp-telemetry-emulator.tar` | 134284800 | `89399e531f20a508554441f1491be5676a524fa14c05f6e10e48fd22d849a199` |

Проверка: сохранить блок ниже в корне репозитория как `external.sha256` и выполнить `shasum -a 256 -c external.sha256` (Linux: `sha256sum -c external.sha256`). Ожидается три строки `OK`.

```text
3c74bb9d3cc5e076a2e7f89de7e78fb103c350757d16c9d629de651ee09bf517  data/validate/traffic.csv
c9b561743a5cb83616941b02b47c5aded89e75218d93c13a282a2e8c790787c8  data/validate/schedule_plan.csv
89399e531f20a508554441f1491be5676a524fa14c05f6e10e48fd22d849a199  data/emulator/ndtp-telemetry-emulator.tar
```

Модель (`models/final/`) и карта (`consumer/map/moscow.pmtiles`) входят в репозиторий. Проверка модели: `(cd models/final && shasum -a 256 -c SHA256SUMS)`. Хэш карты: `shasum -a 256 consumer/map/moscow.pmtiles`; сравните его с `sha256` в `consumer/map/manifest.json`. На Linux вместо `shasum -a 256` можно использовать `sha256sum`.

Загрузите образ эмулятора в Docker один раз:

```bash
docker load -i data/emulator/ndtp-telemetry-emulator.tar
docker image inspect ndtp-telemetry-emulator:1.0 --format '{{.Id}}'
```

Ожидается идентификатор образа `sha256:…`. Образ рассчитан на `linux/amd64`; на Apple Silicon Docker Desktop запускает его через эмуляцию.

### 2. Запустите систему одной командой

Из корня репозитория:

```bash
SOURCE_COMMIT=$(git describe --always --dirty --abbrev=40) docker compose --profile demo up -d --build --force-recreate --remove-orphans
```

Команда запускает `ml`, `backend`, `consumer`, официальный `emulator` и `driver`. Последние два контейнера подают поток автоматически; вручную настраивать эмулятор не нужно. По умолчанию проигрывается окно 06:30–08:30 дня 2026-01-06 с ускорением ×5 — около 24 минут реального времени. Первая сборка занимает больше времени, чем повторный запуск.

### 3. Откройте дашборд и проверьте поток

Откройте <http://localhost:8002> (экран рассчитан на 1920×1080). Дождитесь состояния «идёт» и увеличения числа принятых кадров в «Диагностике». Клик по транспортному средству открывает текущую задержку и целевую остановку через 10–15 минут с прогнозом модели. При смене цели предыдущая цель и её прогноз могут кратко оставаться вместе с пометкой «обновляется», пока новая цель считается; они не смешиваются. Предупреждение появляется при прогнозе задержки больше двух минут и доступно во вкладке «События». У части ТС прогноза нет: причина отображается в карточке, например отсутствие целевой остановки в нужном временном окне.

| Что проверить | Адрес |
|---|---|
| Диспетчерская карта, прогнозы, события и диагностика | <http://localhost:8002> |
| Текущее состояние ТС (`snapshot.vehicles`), `prediction_s`, `alert` и счётчики ML | <http://localhost:8002/api/snapshot> |
| Приём NDTP, счётчики ошибок и состояние прогона | <http://localhost:8001/v1/ingest> |
| Swagger ML API | <http://localhost:8000/docs> |
| Swagger Backend API | <http://localhost:8001/docs> |
| Swagger веб-дашборда | <http://localhost:8002/docs> |

Проверка готовности из терминала:

```bash
docker compose --profile demo ps -a
curl -fsS http://localhost:8000/ready
curl -fsS http://localhost:8001/ready
curl -fsS http://localhost:8002/ready
```

У `ml`, `backend` и `consumer` ожидается `healthy`, у всех трёх `/ready` — `"status":"ready"`. Это проверяет запуск сервисов. Сам поток проверяйте по `run.state=running` и растущему `run.accepted_frames` в Backend `/ready`, а прогнозы — по `prediction_s` в `/api/snapshot`. Драйвер штатно завершается после конца окна данных; это не ошибка.

Если сервис не стал healthy или поток не начался, посмотрите причину:

```bash
docker compose --profile demo logs --tail=100 ml backend consumer emulator driver
```

### 4. Перезапуск и остановка

Повторите команду запуска из шага 2, чтобы начать новый прогон. Она пересоздаёт контейнеры; прогнозы, счётчики и история текущего прогона начинают отсчёт заново. Дашборд автоматически замечает новый `run_id` и очищает события и историю браузера.

Чтобы остановить систему и удалить её контейнеры и сеть:

```bash
docker compose --profile demo down --remove-orphans
```

Модель, карта, входные CSV и Docker-образы сохраняются. Состояние Backend хранится в памяти и после остановки теряется.

## Три модуля и границы демо

| Модуль | За что отвечает |
|---|---|
| ML-ядро (`transport_ml/`, контейнер `ml`, порт 8000) | Загружает CatBoost-модель и выдаёт точечный прогноз задержки в секундах через `POST /v1/predict` |
| Backend (`transport_backend/`, контейнер `backend`, порты 8001 и 9201) | Принимает TCP NDTP, сопоставляет телеметрию с расписанием, управляет временем прогона, вызывает ML и выдаёт состояние ТС |
| Веб-дашборд (`dashboard/` + `consumer/`, контейнер `consumer`, порт 8002) | Показывает живую карту, целевую остановку, прогноз, предупреждения и счётчики обработки из Backend |

Это демонстрационный диспетчерский дашборд; полный аналитический BI пока не реализован. Маршруты приближённо восстановлены по GPS, привязаны к плановым остановкам и не являются официальными дорожными трассами или результатом map matching; на участках без достаточных данных остаются прямые отрезки. Действия диспетчера и заметки сохраняются только в текущем браузере. Поток использует исторические координаты и время, заданное эмулятором, поэтому не воспроизводит реальные задержки доставки. Офлайн MAE модели и горизонт 10–15 минут не доказывают время предупреждения до независимого начала инцидента.

Подача данных, прогнозы, алерты и метрики описаны в [инструкции для жюри](docs/runbooks/jury-demo.md). Настройки `DEMO_SPEEDUP`/`DEMO_POST_PERIOD_S`/`DEMO_WINDOW`, состояния прогона и устранение неполадок — в [подробном runbook](docs/runbooks/local-demo.md). Документация кода — [PyDoc](docs/pydoc/index.html); сохранённые схемы API — [ML](docs/api/openapi.json), [Backend](docs/api/backend-openapi.json) и [дашборд](docs/api/consumer-openapi.json).

## Что где лежит

| Путь | Назначение | Текущий статус |
|---|---|---|
| `transport_ml/` | Обучение, признаки, временное сравнение, инференс и FastAPI-сервис | Текущий direct-point API, pinned model/origin SHA и exact parity |
| `transport_backend/` | TCP NDTP, bounded state, расписание, прогон эмулятора и HTTP orchestration | `run.py` владеет часами и прогоном; past-only computed stop detector, route context, failure readback |
| `consumer/` | Раздача диспетчерской карты, `/api/snapshot`, `/api/route/{tr_id}`, `/api/routes`, `/api/build` и локальных PMTiles ([контракт](docs/api/backend-v1.md#consumer)) | Читает только Backend HTTP; старые результаты помечает явно |
| `scripts/` | Драйвер официального эмулятора и historical NDTP sender | `emulator_driver.py` — источник демо (profile `demo`); `replay_ndtp.py` — только инструмент тестов |
| `tests/` | ML, NDTP/state, прогон и route, драйвер эмулятора, schedule/orchestration и consumer contracts | `.venv/bin/python -m pytest tests -q` — 100 passed, 1 skipped на commit `09c742e` |
| `artifacts/` | Исторические модели и метрики T-3/T-5 | Локальные файлы; прежние модели не являются текущим кандидатом |
| `models/final/` | Файлы текущей модели для ML-сервиса (`final_model.cbm`, `final_model.json`, `vehicle_origins.csv`) | В Git, SHA-256 в `SHA256SUMS`; compose монтирует по умолчанию (`MODEL_DIR=./models/final`) |
| `.local/validate-tuning-2026-09-26/` | Frozen код обучения/инференса, отчёт и evidence модели | Игнорируется Git; для запуска демо не нужен, production inference перенесён в owning пакет |
| `data/` | Официальные train/test/validate, labels, шаблон сабмита и эмулятор | Полная локальная копия; тяжёлые файлы исключены из Git |
| `docs/source/official/` | Официальная постановка и критерии оценки | Исходный PDF без изменений |
| `reference/initial-solution/` | Оригинальная документация начального решения | Сохранена побайтно для происхождения и контекста |
| `docs/api/`, `docs/pydoc/` | Текущие OpenAPI/Backend v1 и PyDoc 12 модулей (`docs/pydoc/index.html`) | PyDoc пересобирается командой из `docs/pydoc/index.html` |
| `notebooks/` | Четыре ноутбука аудита и моделирования T-3 | Сохраняют исторический результат T-3 |
| `dashboard/` | Исходники диспетчерской карты (MapLibre, PMTiles, Three.js), сборка в `consumer/static` | Один экран живого прогона: шапка прогона, маршрутный контекст, карточка с фактом/прогнозом/допущением; см. [`dashboard/README.md`](dashboard/README.md) |

Полное дерево и правила владения описаны в [`docs/repository-layout.md`](docs/repository-layout.md). Происхождение файлов — в [`docs/source-map.md`](docs/source-map.md). Навигация по документации начинается с [`docs/index.md`](docs/index.md).

Рабочая постановка задачи находится в [`docs/prd/transport-delay-predictor.md`](docs/prd/transport-delay-predictor.md), а критерии и подтверждённая готовность — в [`docs/prd/evaluation-scorecard.md`](docs/prd/evaluation-scorecard.md). Направление проекта зафиксировано в [`.locus/soul.md`](.locus/soul.md) и [`.locus/roadmap.md`](.locus/roadmap.md).

## Официальная задача

Нужно прогнозировать задержку транспортного средства на целевой остановке за 10–15 минут до события. Вход — историческая или потоковая телеметрия NDTP, расписание и известное на момент прогноза состояние. Основная метрика Data Science — MAE задержки в секундах; меньше — лучше.

Официальные критерии дополнительно требуют ML-ядро, Backend и BI-дашборд с Docker, низкой задержкой, обработкой обрывов и понятным интерфейсом. Текущее demo связывает официальный эмулятор, Backend, ML и диспетчерскую карту; оно не доказывает полный BI/C4 или раннее предупреждение до независимого onset.

## Локальные данные

Файлы из `data/train/`, `data/test/`, `data/validate/`, `data/labels/` и Docker-образ в `data/emulator/` находятся в рабочем каталоге, но исключены из Git. Это предотвращает попадание 212 МБ входных материалов и tar-файла размером более 100 МБ в историю репозитория.

Официальное описание схемы и правил находится в [`data/README.md`](data/README.md), спецификация эмулятора — в [`data/docs/Emulator-and-Telematic-Packets-Specification.md`](data/docs/Emulator-and-Telematic-Packets-Specification.md).

## Оптимизированная модель и submission

Основной файл — [`submission.csv`](submission.csv): 151 строка в порядке официального шаблона, SHA-256 `4c324401d397c0720887c9b5a2b2d0fb931c791df70935e6cea4e670cee7b0ce`. Модель, provenance кандидата, проверка формата и статус сдачи на платформу описаны в [передаче интеграции](docs/runbooks/integration-handoff.md#кандидат-сдачи-проверено-2026-09-27).

Происхождение модели, зафиксированные метрики и границы воспроизведения описаны в [передаче интеграции](docs/runbooks/integration-handoff.md). Локальный каталог `.local/validate-tuning-2026-09-26/` содержит подробный отчёт и код финального обучения, но намеренно не входит в Git. При условном `MAE_TARGET=30` score на validate равен 0.821; это не платформенный readback. Старые отчёты до очистки синтетики не доказывают отсутствие производных пересечений.

Воспроизведение из корня с установленными `requirements.txt`:

```bash
PYTHONPATH=. .venv/bin/python .local/validate-tuning-2026-09-26/final_model.py predict --output submission-reproduced.csv
```

Эта команда требует локальные данные и `.local`-артефакты текущего checkout; свежий clone их не содержит. Исторические команды `transport_ml.train` и `transport_ml.optimize` сохранены для воспроизведения прежних опытов и пока не включают последнюю очистку синтетических копий. Текущий кандидат — точечный прогноз; API не выдаёт probability, quantiles или causal explanation. Старые risk/quantile артефакты не используются serving-путём.

## Оставшиеся проверки

C1 закрыт: платформа показывает 1,0 для `submission.csv` с SHA-256 выше (подтверждение команды, блок C1 в [форме сдачи](docs/submission-form.md#c1-точность-модели)). Для C2 нужно независимое onset/lead-time evidence. Полный BI/C4 отложен, а общие performance/QA доказательства принадлежат T-4. Исторические ноутбуки T-3 воспроизводят старую модель и могут перезаписать корневой submission; для текущего кандидата используйте команды выше.
