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
├── consumer/                      # минимальный live HTTP consumer
├── scripts/                       # historical NDTP sender и измерения
├── tests/                         # ML, NDTP, Backend и consumer contracts
├── artifacts/                     # исходные модели, метрики и результаты
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
│   ├── api/                       # текущие OpenAPI и Backend v1 contract
│   ├── pydoc/                     # исторический PyDoc snapshot
│   ├── runbooks/                  # текущий Docker demo и model provenance
│   ├── repository-layout.md
│   └── source-map.md
├── reference/
│   └── initial-solution/          # неизменённые документы исходного решения
├── notebooks/                     # будущие исследования и обучение
└── dashboard/                     # будущий диспетчерский интерфейс
```

## Владение компонентами

- `transport_ml/` владеет подготовкой признаков, обучением, схемой модели и инференсом. `service.py` обслуживает выбранный final artifact отдельным stateless HTTP API; NDTP state ему не принадлежит.
- `transport_backend/` владеет NDTP TCP boundary, bounded telemetry, unit mapping, source clocks, планом, computed current deviation и HTTP orchestration. Оно передаёт ML только разрешённые point/telemetry/plan поля.
- `consumer/` владеет минимальным polling view и возрастом последнего HTTP snapshot. Оно читает Backend API, не model/data files, и не заменяет полный BI.
- `scripts/` владеет source replay transport: CSV читается sender, а Backend узнаёт данные через NDTP по одному подтверждённому кадру.
- `dashboard/` предназначен для карты, риска, карточек инцидентов и метрик. README в каталоге фиксирует контракт, но не изображает готовую реализацию.
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
