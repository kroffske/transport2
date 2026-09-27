---
title: Документация transport2
type: index
status: active
owner: transport2
tags: [navigation]
updated: "2026-09-27T13:16:28Z"
source_commit: "074ba94415b2"
update_event: "sync"
context: "changes=XL files=52 task=T-7"
description: "Навигация: единое демо официального эмулятора, контракты, модель и проектное направление."
---

# Документация transport2

## Start here

- [Официальная постановка в Markdown](prd/transport-delay-predictor.md) — каноническое рабочее представление требований.
- [Scorecard критериев](prd/evaluation-scorecard.md) — баллы, доказательства, выполнимость и owning tasks.
- [Структура репозитория](repository-layout.md) — назначение каталогов, владельцы и границы первого этапа.
- [Карта происхождения](source-map.md) — какие файлы откуда перенесены и что исключено.
- [Официальная постановка и критерии](source/official/transport-delay-predictor.pdf) — исходный PDF без изменений.
- [Контракт датасета](../data/README.md) — формат выборок, целевая переменная, метрика и правила сабмита.
- [Спецификация NDTP и эмулятора](../data/docs/Emulator-and-Telematic-Packets-Specification.md) — потоковый протокол и запуск эмулятора.
- [Передача текущей модели и интеграции](runbooks/integration-handoff.md) — актуальный ML-кандидат, локальные зависимости и границы следующего этапа.
- [Локальный NDTP demo](runbooks/local-demo.md) — единое демо: официальный эмулятор → Backend → ML → consumer → карта; одна команда запуска, настройки, lifecycle, ограничения, troubleshooting, проверки.
- [Диспетчерская карта](../dashboard/README.md) — что на экране, слои маршрута и карточка прогноза, сборка и browser check.
- [Backend v1](api/backend-v1.md) — контракт прогона и часов, snapshot, маршрутного контекста и consumer (`/api/route`, `/api/build`).
- [Географическая основа](runbooks/geography-foundation.md) — координаты, геоконтракт и ограничения по маршрутам.

## Generated reference

- [ML OpenAPI](api/openapi.json) — спецификация текущей точечной модели и readiness.
- [Backend OpenAPI](api/backend-openapi.json) и [Consumer OpenAPI](api/consumer-openapi.json) — текущие HTTP seams.
- `pydoc/` — исторический снимок Python-документации; актуальные команды находятся в runbook.

## Preserved sources

- `../reference/initial-solution/` — неизменённые документы и манифест начального решения. Это исторический источник, а не актуальная эксплуатационная документация репозитория.

## Gaps

- Реальных трасс маршрутов, `route_id` и устойчивых stop ID нет; на карте — путь по GPS прогона и плановые остановки.
- Время NDTP ставит эмулятор, поэтому реальные задержки доставки данных не воспроизводятся.
- Полный BI/C4, серверное хранение действий диспетчера, platform score и независимое onset/lead-time evidence отсутствуют.

## Project direction

- [Soul](../.locus/soul.md) — долговременная миссия, ловушки и принципы решений.
- [Near-term goal](../.locus/goal.md) — ближайшая цель проекта.
- [Roadmap](../.locus/roadmap.md) — этапы и evidence gates.
