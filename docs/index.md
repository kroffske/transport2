---
title: Документация transport2
type: index
status: active
owner: transport2
tags: [navigation]
updated: "2026-09-27T16:46:22Z"
source_commit: "50e3b1cde8db"
update_event: "user_request"
context: "changes=L files=20"
description: "Навигация: единое демо официального эмулятора, контракты, модель и проектное направление."
---

# Документация transport2

Начните с [инструкции для жюри](runbooks/jury-demo.md): запуск Docker, карта, прогнозы и события.

## Документация кода и API

[PyDoc](pydoc/index.html) описывает Python-модули ML, Backend и веб-дашборда. После скачивания репозитория откройте `docs/pydoc/index.html` в браузере; GitHub показывает HTML как исходный текст.

После запуска системы доступны интерактивные страницы Swagger:

| Сервис | Swagger | Сохранённая спецификация |
|---|---|---|
| ML | [localhost:8000/docs](http://localhost:8000/docs) | [OpenAPI](api/openapi.json) |
| Backend | [localhost:8001/docs](http://localhost:8001/docs) | [OpenAPI](api/backend-openapi.json) |
| Веб-дашборд | [localhost:8002/docs](http://localhost:8002/docs) | [OpenAPI](api/consumer-openapi.json) |

[Описание Backend API](api/backend-v1.md) поясняет формат прогнозов, состояние транспорта и диагностику.

## Если нужны подробности

- [Эксплуатация](runbooks/local-demo.md) — настройки, ошибки и исторические замеры производительности.
- [Модель](runbooks/integration-handoff.md) — качество и ограничения прогнозов.
- [Дашборд](../dashboard/README.md) и [карта](runbooks/geography-foundation.md) — возможности интерфейса.
- [Данные](../data/README.md) и [эмулятор NDTP](../data/docs/Emulator-and-Telematic-Packets-Specification.md) — форматы организаторов.

<details>
<summary>Материалы проекта</summary>

- [Задача](prd/transport-delay-predictor.md), [исходный PDF](source/official/transport-delay-predictor.pdf) и [критерии оценки](prd/evaluation-scorecard.md).
- [Структура репозитория](repository-layout.md) и [происхождение файлов](source-map.md).
- [Тексты формы сдачи](submission-form.md).
- [Назначение проекта](../.locus/soul.md), [ближайшая цель](../.locus/goal.md) и [план развития](../.locus/roadmap.md).

</details>
