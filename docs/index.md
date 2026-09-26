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

## Generated reference

- [OpenAPI](api/openapi.json) — снимок спецификации начального решения.
- `pydoc/` — снимок сгенерированной Python-документации.

## Preserved sources

- `../reference/initial-solution/` — неизменённые документы и манифест начального решения. Это исторический источник, а не актуальная эксплуатационная документация репозитория.

## Gaps

- Локальное ML-обучение и submission проверены; актуальный кандидат пока не интегрирован в сервис.
- Нет отдельного Backend для NDTP-потока.
- BI-дашборд ещё не реализован.
- Импорты, пути и Docker-конфигурация после объединения ещё не проверены и не исправлены.

## Project direction

- [Soul](../.locus/soul.md) — долговременная миссия, ловушки и принципы решений.
- [Near-term goal](../.locus/goal.md) — ближайшая цель проекта.
- [Roadmap](../.locus/roadmap.md) — этапы и evidence gates.
