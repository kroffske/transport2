---
title: Структура репозитория transport2
type: overview
status: active
owner: transport2
tags: [repository, architecture]
updated: "2026-09-25T18:38:17Z"
source_commit: "unknown"
update_event: "user_request"
context: "changes=unknown files=0 task=T-1 git=unavailable"
description: "Текущая раскладка репозитория и владельцы будущих компонентов."
---

# Структура репозитория

## Принцип первого этапа

Начальное решение сохранено максимально близко к исходной раскладке. В частности, `transport_ml/`, `Dockerfile`, `compose.yaml`, `requirements*.txt` и `artifacts/` остались в корне, потому что Dockerfile и Compose уже ссылаются на эти пути.

Официальная раздача имеет одного владельца — `data/`. Копии README и NDTP-спецификации из `transport_ml_solution` не перенесены повторно, поскольку они побайтно совпадают с файлами из `dataset`.

## Текущее дерево

```text
transport2/
├── README.md
├── transport_ml/                  # ML features, выбранный artifact и stateless API
├── transport_backend/             # NDTP/state/schedule и HTTP orchestration
├── consumer/                      # HTTP consumer, собранный UI (static/) и карта (map/moscow.pmtiles, в Git)
├── scripts/                       # драйвер официального эмулятора, historical NDTP sender для тестов
├── tests/                         # ML, NDTP, Backend и consumer contracts
├── artifacts/                     # исторические модели и метрики T-3/T-5
├── models/final/                  # текущая модель ML-сервиса (в Git, SHA256SUMS)
├── Dockerfile
├── compose.yaml
├── requirements.txt
├── requirements-torch.txt
├── example_request.json
├── data/
│   ├── README.md                  # официальный контракт датасета
│   ├── train/
│   ├── test/
│   ├── validate/
│   ├── labels/
│   ├── sample_submission.csv
│   ├── docs/                      # спецификация NDTP и эмулятора
│   └── emulator/                  # локальный Docker-образ эмулятора
├── docs/
│   ├── source/official/           # исходная постановка и критерии
│   ├── prd/                       # рабочая постановка и scorecard критериев
│   ├── api/                       # текущие OpenAPI и Backend v1 contract
│   ├── pydoc/                     # PyDoc 12 модулей; index.html с командой пересборки
│   ├── runbooks/                  # текущий Docker demo и model provenance
│   ├── submission-form.md         # тексты формы сдачи и C1
│   ├── repository-layout.md
│   └── source-map.md
├── reference/
│   └── initial-solution/          # неизменённые документы исходного решения
├── notebooks/                     # ноутбуки аудита и моделирования T-3
└── dashboard/                     # диспетчерская карта (исходники UI; сборка → consumer/static)
```

## Владение компонентами

- `transport_ml/` владеет подготовкой признаков, обучением, схемой модели и инференсом. `service.py` обслуживает выбранный final artifact отдельным stateless HTTP API; NDTP state ему не принадлежит.
- `transport_backend/` владеет NDTP TCP boundary, bounded telemetry, unit mapping, source clocks, планом, computed current deviation и HTTP orchestration. Оно передаёт ML только разрешённые point/telemetry/plan поля.
- `consumer/` раздаёт собранный UI и локальные PMTiles, проксирует Backend (`/api/snapshot`, `/api/route`, `/api/routes`) и отдаёт `/api/build`. Оно читает Backend API, не model/data files, и не заменяет полный BI.
- `models/final/` — единственный источник модели для compose (`MODEL_DIR=./models/final`); `.local/validate-tuning-2026-09-26/` (вне Git) хранит код обучения, отчёт и evidence.
- `scripts/` владеет источниками телеметрии: `emulator_driver.py` регистрирует прогон в Backend и кормит официальный эмулятор точками датасета через его `POST /api/config` (единственный показ, compose profile `demo`); `replay_ndtp.py` — инструмент тестов прямой NDTP-отправки в Backend режима `dataset_wall`. Backend узнаёт данные только через NDTP.
- `dashboard/` владеет диспетчерской картой: MapLibre/PMTiles, ТС прогона, маршруты по плановым остановкам наряда, маршрут и остановки выбранного ТС, карточка с фактом/прогнозом модели, события и diagnostics. Собирается в `consumer/static` командой `npm --prefix dashboard run build`.
- `notebooks/` предназначен для аудита данных, экспериментов и воспроизводимого обучения. Производственный код не должен жить только в ноутбуках.
- `data/` — локальный неизменяемый вход. Производные таблицы и кэши в будущем должны получить отдельные подкаталоги и правила воспроизводимости.

## Критерии, влияющие на архитектуру

Официальный PDF требует:

1. прогноз и алерт строго за 10–15 минут до события;
2. независимые ML-ядро и Backend;
3. диспетчерский BI-дашборд;
4. запуск системы в Docker по одной инструкции;
5. рабочую цепочку поток NDTP → прогноз → дашборд;
6. подтверждённую производительность и деградацию без падения при обрыве связи;
7. PyDoc/Sphinx и OpenAPI/Swagger.

Это целевая граница продукта, а не утверждение о состоянии текущего кода.
