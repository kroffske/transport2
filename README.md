# transport2 — предиктор изменений в движении транспорта

Единый локальный репозиторий для задачи хакатона Московского транспорта. Он объединяет официальную раздачу данных и эмулятор NDTP с начальным ML-решением, подготовленным на небольшой выборке.

Локальная цепочка NDTP → Backend → отдельный ML API → live consumer реализована и проверена через Docker historical replay. Backend вычисляет текущее отклонение из прошлых GPS и плана; consumer показывает реальные обновления и деградацию после разрыва связи. Полноценный BI-интерфейс отложен.

Выбранная CatBoost-модель имеет локальный MAE 44.01 с на validate и 45.00 с на test. Она обучена на 4 139 строках после исключения синтетических копий validate/test-прибытий; validate разрешён для выбора модели, но не включается в fit. Официальный score неизвестен без MAE_TARGET. Потоковый detector не сохраняет автоматически этот offline MAE.

## Локальный demo

При наличии локальных data/model файлов:

```bash
docker compose --profile demo up --build -d
```

Откройте [live consumer](http://localhost:8002) во время replay. Инструкция, configurable пути, часы, сбои и официальный эмулятор описаны в [runbook](docs/runbooks/local-demo.md). Для полного повторного запуска используйте `docker compose --profile demo down`.

## Что где лежит

| Путь | Назначение | Текущий статус |
|---|---|---|
| `transport_ml/` | Обучение, признаки, временное сравнение, инференс и FastAPI-сервис | Текущий direct-point API, pinned model/origin SHA и exact parity |
| `transport_backend/` | TCP NDTP, bounded state, расписание и HTTP orchestration | Past-only computed stop detector, явные clocks и failure readback |
| `consumer/` | Минимальная страница live polling | Читает только Backend HTTP; старые результаты помечает явно |
| `scripts/` | Historical NDTP sender | Receive-order lockstep replay с per-frame ack и trace |
| `tests/` | ML, NDTP/state, schedule/orchestration и consumer contracts | 57 тестов в объединённом checkout; [независимая QA](.tasks/_archive/T-4-2026-09-25-backend-dashboard-infra/qa.md) приняла локальную цепочку |
| `artifacts/` | Исторические модели и метрики T-3/T-5 | Локальные файлы; прежние модели не являются текущим кандидатом |
| `.local/validate-tuning-2026-09-26/` | Текущая модель, frozen код обучения/инференса и evidence | Игнорируется Git; production inference перенесён в owning пакет |
| `data/` | Официальные train/test/validate, labels, шаблон сабмита и эмулятор | Полная локальная копия; тяжёлые файлы исключены из Git |
| `docs/source/official/` | Официальная постановка и критерии оценки | Исходный PDF без изменений |
| `reference/initial-solution/` | Оригинальная документация начального решения | Сохранена побайтно для происхождения и контекста |
| `docs/api/`, `docs/pydoc/` | Текущие OpenAPI и исторические PyDoc snapshots | Актуальные PyDoc команды находятся в runbook |
| `notebooks/` | Четыре ноутбука аудита и моделирования T-3 | Сохраняют исторический результат T-3 |
| `dashboard/` | Будущий диспетчерский BI-интерфейс | Ещё не реализован |

Полное дерево и правила владения описаны в [`docs/repository-layout.md`](docs/repository-layout.md). Происхождение файлов — в [`docs/source-map.md`](docs/source-map.md). Навигация по документации начинается с [`docs/index.md`](docs/index.md).

Рабочая постановка задачи находится в [`docs/prd/transport-delay-predictor.md`](docs/prd/transport-delay-predictor.md), а критерии и подтверждённая готовность — в [`docs/prd/evaluation-scorecard.md`](docs/prd/evaluation-scorecard.md). Направление проекта зафиксировано в [`.locus/soul.md`](.locus/soul.md) и [`.locus/roadmap.md`](.locus/roadmap.md).

## Официальная задача

Нужно прогнозировать задержку транспортного средства на целевой остановке за 10–15 минут до события. Вход — историческая или потоковая телеметрия NDTP, расписание и известное на момент прогноза состояние. Основная метрика Data Science — MAE задержки в секундах; меньше — лучше.

Официальные критерии дополнительно требуют ML-ядро, Backend и BI-дашборд с Docker, низкой задержкой, обработкой обрывов и понятным интерфейсом. Текущий demo показывает три связанных процесса с минимальным consumer; он не доказывает полный BI/C4 или раннее предупреждение до независимого onset.

## Локальные данные

Файлы из `data/train/`, `data/test/`, `data/validate/`, `data/labels/` и Docker-образ в `data/emulator/` находятся в рабочем каталоге, но исключены из Git. Это предотвращает попадание 212 МБ входных материалов и tar-файла размером более 100 МБ в историю репозитория.

Официальное описание схемы и правил находится в [`data/README.md`](data/README.md), спецификация эмулятора — в [`data/docs/Emulator-and-Telematic-Packets-Specification.md`](data/docs/Emulator-and-Telematic-Packets-Specification.md).

## Оптимизированная модель и submission

Основной файл — [`submission.csv`](submission.csv): 151 строка в порядке официального шаблона. Модель и её актуальные ограничения описаны в [передаче интеграции](docs/runbooks/integration-handoff.md).

[Локальный отчёт](.local/validate-tuning-2026-09-26/report.md) содержит происхождение модели и все сравнения. При условном MAE_TARGET=30 score на validate равен 0.821; это не платформенный readback. Старые отчёты до очистки синтетики не доказывают отсутствие производных пересечений.

Воспроизведение из корня с установленными `requirements.txt`:

```bash
PYTHONPATH=. .venv/bin/python .local/validate-tuning-2026-09-26/final_model.py predict --output submission-reproduced.csv
```

Эта команда требует локальные данные и `.local`-артефакты текущего checkout; свежий clone их не содержит. Исторические команды `transport_ml.train` и `transport_ml.optimize` сохранены для воспроизведения прежних опытов и пока не включают последнюю очистку синтетических копий. Текущий кандидат — точечный прогноз; API не выдаёт probability, quantiles или causal explanation. Старые risk/quantile артефакты не используются serving-путём.

## Оставшиеся проверки

Для C1 нужен platform score выбранного submission; для C2 — независимое onset/lead-time evidence. Полный BI/C4 отложен, а общие performance/QA доказательства принадлежат T-4. Исторические ноутбуки T-3 воспроизводят старую модель и могут перезаписать корневой submission; для текущего кандидата используйте команды выше.
