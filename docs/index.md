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
- [Форма сдачи](submission-form.md) — тексты полей «Загрузка решения» и подтверждение C1.
- [Контракт датасета](../data/README.md) — формат выборок, целевая переменная, метрика и правила сабмита.
- [Спецификация NDTP и эмулятора](../data/docs/Emulator-and-Telematic-Packets-Specification.md) — потоковый протокол и запуск эмулятора.
- [Передача текущей модели и интеграции](runbooks/integration-handoff.md) — актуальный ML-кандидат, локальные зависимости и границы следующего этапа.
- [Локальный NDTP demo](runbooks/local-demo.md) — единое демо: официальный эмулятор → Backend → ML → consumer → карта; одна команда запуска, настройки, lifecycle, ограничения, troubleshooting, проверки.
- [Инструкция для жюри](runbooks/jury-demo.md) — короткий проверяемый путь: подготовка файлов, официальный эмулятор или historical replay, прогнозы, алерты, метрики, Swagger и PyDoc.
- [Диспетчерская карта](../dashboard/README.md) — что на экране, слои маршрута и карточка прогноза, сборка и browser check.
- [Backend v1](api/backend-v1.md) — контракт прогона и часов, snapshot (`heading`, `off_route`, `route_offset_m`), маршрутного контекста (`route_line`), маршрутов обзора и consumer (`/api/route`, `/api/routes`, `/api/build`).
- [Географическая основа](runbooks/geography-foundation.md) — координаты, геоконтракт и ограничения по маршрутам.

## Generated reference

- [ML OpenAPI](api/openapi.json) — спецификация текущей точечной модели и readiness.
- [Backend OpenAPI](api/backend-openapi.json) и [Consumer OpenAPI](api/consumer-openapi.json) — текущие HTTP seams.
- [PyDoc](pydoc/index.html) — HTML 12 модулей `transport_ml`, `transport_backend` и `consumer`; команда пересборки — в том же `index.html`.

## Preserved sources

- `../reference/initial-solution/` — неизменённые документы и манифест начального решения. Это исторический источник, а не актуальная эксплуатационная документация репозитория.

## Gaps

- Официальных трасс маршрутов, `route_id`, устойчивых stop ID и map matching нет. Линии приближённо восстановлены по GPS и привязаны к плановым остановкам; участки без достаточных данных остаются прямыми.
- Время NDTP ставит эмулятор, поэтому реальные задержки доставки данных не воспроизводятся.
- Полный BI/C4, серверное хранение действий диспетчера и независимое onset/lead-time evidence отсутствуют. Score платформы (1,0) — со слов команды, скриншот в репозитории не сохранён ([форма сдачи](submission-form.md#c1-точность-модели)).

## Project direction

- [Soul](../.locus/soul.md) — долговременная миссия, ловушки и принципы решений.
- [Near-term goal](../.locus/goal.md) — ближайшая цель проекта.
- [Roadmap](../.locus/roadmap.md) — этапы и evidence gates.
