---
title: Документация transport2
type: index
status: active
owner: transport2
tags: [navigation]
updated: "2026-09-25T19:37:24Z"
source_commit: "9339093e841d"
update_event: "sync"
context: "changes=L files=22 task=T-2"
description: "Навигация дополнена PRD, scorecard и проектным направлением."
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
- [Backend v1](api/backend-v1.md) — контракт часов, NDTP readback и live consumer для T-4.
- [Локальный NDTP demo](runbooks/local-demo.md) — Docker-запуск, historical replay, официальный эмулятор и актуальные API/PyDoc команды.

## Generated reference

- [ML OpenAPI](api/openapi.json) — спецификация текущей точечной модели и readiness.
- [Backend OpenAPI](api/backend-openapi.json) и [Consumer OpenAPI](api/consumer-openapi.json) — текущие HTTP seams.
- `pydoc/` — исторический снимок Python-документации; актуальные команды находятся в runbook.

## Preserved sources

- `../reference/initial-solution/` — неизменённые документы и манифест начального решения. Это исторический источник, а не актуальная эксплуатационная документация репозитория.

## Gaps

- Текущий кандидат подключён к отдельному ML API; NDTP Backend и минимальный live consumer прошли Docker readback.
- BI-дашборд и карта ещё не реализованы; consumer не закрывает C4.
- Platform score и независимое onset/lead-time evidence отсутствуют. Общая QA и performance evidence ведутся в T-4.

## Project direction

- [Soul](../.locus/soul.md) — долговременная миссия, ловушки и принципы решений.
- [Near-term goal](../.locus/goal.md) — ближайшая цель проекта.
- [Roadmap](../.locus/roadmap.md) — этапы и evidence gates.
