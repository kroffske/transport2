# transport2 — предиктор изменений в движении транспорта

Единый локальный репозиторий для задачи хакатона Московского транспорта. Он объединяет официальную раздачу данных и эмулятор NDTP с начальным ML-решением, подготовленным на небольшой выборке.

Демо одно: официальный эмулятор NDTP, которого драйвер кормит GPS-точками из данных проекта → Backend (контекст по расписанию) → отдельный ML API с реальной моделью → consumer → диспетчерская 2D-карта Москвы с маршрутным контекстом выбранного ТС и прогнозом задержки на цели. Отдельного UI-only сценария нет. Это демонстрационный интерфейс, не полный BI.

Выбранная CatBoost-модель имеет локальный MAE 44.01 с на validate и 45.00 с на test. Она обучена на 4 139 строках после исключения синтетических копий validate/test-прибытий; validate разрешён для выбора модели, но не включается в fit. Платформа Data Science показывает для корневого `submission.csv` score 1,0 (подтверждение команды 2026-09-27, см. [форму сдачи](docs/submission-form.md#c1-точность-модели)). Потоковый detector не сохраняет автоматически этот offline MAE.

## Быстрый путь для жюри

Модель (`models/final/`, SHA-256 в `models/final/SHA256SUMS`) и карта (`consumer/map/moscow.pmtiles`, источник и SHA-256 — в `consumer/map/manifest.json`) лежат в репозитории. Один раз подготовить (не хранятся в Git): Docker, образ эмулятора и данные `data/validate/{traffic.csv,schedule_plan.csv}` из официальной раздачи.

Вне Git только три файла официальной раздачи организаторов. Положить их по путям от корня репозитория:

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

Файлы в репозитории проверяются так: модель — `cd models/final && shasum -a 256 -c SHA256SUMS`, карта — `shasum -a 256 consumer/map/moscow.pmtiles` сравнить с полем `sha256` в `consumer/map/manifest.json`.

```bash
docker load -i data/emulator/ndtp-telemetry-emulator.tar
```

Запуск и перезапуск с нуля — одна и та же команда из корня репозитория:

```bash
SOURCE_COMMIT=$(git describe --always --dirty --abbrev=40) docker compose --profile demo up -d --build --force-recreate --remove-orphans
```

Открыть <http://localhost:8002> (экран рассчитан на 1920×1080). В шапке видны прогон `run-…`, «Ускорение ×5: 1 мин показа = 5 мин данных», время данных и состояние прогона. На обзоре видны маршруты всех ТС прогона — линии через плановые остановки наряда, не дорожные трассы. Клик по ТС показывает его маршрут (пройдено / впереди; при сильном отклонении GPS — «вне маршрута ~N км»), остановки и цель через 10–15 мин с прогнозом модели. Повторная команда создаёт новый прогон с новым `run_id`, и открытая страница сама очищает события и историю. Остановка: `docker compose --profile demo down`.

Prerequisites, настройки `DEMO_SPEEDUP`/`DEMO_POST_PERIOD_S`/`DEMO_WINDOW`, состояния прогона, смысл слоёв и карточки, ограничения, troubleshooting и сценарий показа на 2–3 минуты — в [runbook](docs/runbooks/local-demo.md).

## Что где лежит

| Путь | Назначение | Текущий статус |
|---|---|---|
| `transport_ml/` | Обучение, признаки, временное сравнение, инференс и FastAPI-сервис | Текущий direct-point API, pinned model/origin SHA и exact parity |
| `transport_backend/` | TCP NDTP, bounded state, расписание, прогон эмулятора и HTTP orchestration | `run.py` владеет часами и прогоном; past-only computed stop detector, route context, failure readback |
| `consumer/` | Раздача диспетчерской карты, `/api/snapshot`, `/api/route/{tr_id}`, `/api/routes`, `/api/build` и локальных PMTiles ([контракт](docs/api/backend-v1.md#consumer)) | Читает только Backend HTTP; старые результаты помечает явно |
| `scripts/` | Драйвер официального эмулятора и historical NDTP sender | `emulator_driver.py` — источник демо (profile `demo`); `replay_ndtp.py` — только инструмент тестов |
| `tests/` | ML, NDTP/state, прогон и route, драйвер эмулятора, schedule/orchestration и consumer contracts | `.venv/bin/python -m pytest tests -q` — 89 тестов: 88 passed, 1 skipped (сверка с frozen `final_model.py` идёт только при `MODEL_DIR=.local/validate-tuning-2026-09-26`) |
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

[Локальный отчёт](.local/validate-tuning-2026-09-26/report.md) содержит происхождение модели и все сравнения. При условном MAE_TARGET=30 score на validate равен 0.821; это не платформенный readback. Старые отчёты до очистки синтетики не доказывают отсутствие производных пересечений.

Воспроизведение из корня с установленными `requirements.txt`:

```bash
PYTHONPATH=. .venv/bin/python .local/validate-tuning-2026-09-26/final_model.py predict --output submission-reproduced.csv
```

Эта команда требует локальные данные и `.local`-артефакты текущего checkout; свежий clone их не содержит. Исторические команды `transport_ml.train` и `transport_ml.optimize` сохранены для воспроизведения прежних опытов и пока не включают последнюю очистку синтетических копий. Текущий кандидат — точечный прогноз; API не выдаёт probability, quantiles или causal explanation. Старые risk/quantile артефакты не используются serving-путём.

## Оставшиеся проверки

C1 закрыт: платформа показывает 1,0 для `submission.csv` с SHA-256 выше (подтверждение команды, блок C1 в [форме сдачи](docs/submission-form.md#c1-точность-модели)). Для C2 нужно независимое onset/lead-time evidence. Полный BI/C4 отложен, а общие performance/QA доказательства принадлежат T-4. Исторические ноутбуки T-3 воспроизводят старую модель и могут перезаписать корневой submission; для текущего кандидата используйте команды выше.
