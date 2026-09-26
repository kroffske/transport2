---
title: Локальный NDTP demo
type: runbook
status: active
owner: transport2
tags: [ndtp, docker, integration]
updated: "2026-09-26T00:00:00Z"
description: "Запуск текущей модели, Backend и live consumer с причинным historical replay."
---

# Локальный NDTP demo

Три сервиса работают отдельно: Backend принимает TCP NDTP и хранит состояние, ML API загружает выбранную точечную модель, consumer читает Backend HTTP. Одноразовый replay container — источник demo-потока. Полный BI-интерфейс и карта отложены.

## Запуск

Нужны Docker и локальные файлы `data/validate/{traffic.csv,schedule_plan.csv}`, `.local/validate-tuning-2026-09-26/{final_model.cbm,final_model.json,vehicle_origins.csv}`. Модель и данные не входят в Git. При расположении файлов в основном checkout:

```bash
docker compose --profile demo up --build -d
```

При запуске из другого checkout задайте абсолютные host paths:

```bash
DATA_DIR=/Users/ravius/projects/transport2/data \
MODEL_DIR=/Users/ravius/projects/transport2/.local/validate-tuning-2026-09-26 \
docker compose --profile demo up --build -d
```

Откройте [consumer](http://localhost:8002) сразу после запуска. Он опрашивает Backend каждые 1,5 секунды. Demo выдаёт fragment 03:20–03:45 исходного дня со speedup 30; номинальная длительность около 50 секунд, реальное время зависит от обработки. После завершения sender закрывает TCP-соединения, поэтому сохранённые прогнозы закономерно становятся `degraded/disconnected`.

Проверки и остановка:

```bash
docker compose --profile demo ps
curl -fsS http://localhost:8000/ready
curl -fsS http://localhost:8001/v1/vehicles
curl -fsS http://localhost:8002/api/snapshot
docker compose logs replay
docker compose --profile demo down
```

При повторном полном demo сначала выполните `down` с тем же `--profile demo`: это удаляет завершённый replay container и его старую сеть. Перезапуск sender в уже продвинувшиеся исторические часы отвергает движение времени назад.

На проверенном host Docker Hub возвращал EOF при загрузке base image. Рабочий fallback сохранил тот же Python 3.12 image через registry mirror:

```bash
docker pull mirror.gcr.io/library/python:3.12-slim
docker tag mirror.gcr.io/library/python:3.12-slim python:3.12-slim
```

## Контракт и режимы

[Backend v1](../api/backend-v1.md) задаёт schema и clock control. Historical sender сортирует по source receive time, перед каждым Nav00 задаёт receive clock и ждёт исход именно своего кадра. Будущая telemetry в Backend не загружается. Используются оба условия `event_time ≤ T` и `receive_time ≤ T`; отрицательный receive lag сохраняется. Naive dataset clock не объявляется UTC или московским временем.

Wire origin: `2026-01-06 00:00:00` dataset wall ↔ synthetic epoch `1700000000`. Integer timestamp/speed NDTP могут отличаться от точного JSON input; дельта wire replay измеряется отдельно от W1 exact API parity. Backend `cur_dev_s` имеет источник `computed_stop`: это приближённое наблюдение остановки по прошлым GPS и плану, без фактического расписания. До уверенного наблюдения нет прогноза и нет подставленного нуля.

Model/data mounts read-only. Consumer не получает эти mounts. `/ready` ML подтверждает SHA выбранной модели; Backend readiness означает готовый NDTP listener и план, а consumer readiness — готовую страницу. Сбой ML показывается в vehicle status, а не скрывается readiness consumer.

## Официальный эмулятор

Он всегда ставит сегодняшний Unix timestamp. Этот режим проверяет ingest и reconnect; текущая модель возвращает `unsupported_day`, а не исторический прогноз.

```bash
docker compose --profile demo down
SOURCE_CLOCK=utc docker compose up -d ml backend consumer
docker load -i data/emulator/ndtp-telemetry-emulator.tar
docker run -d --rm --name transport2-ndtp-emu -p 18080:18080 \
  --add-host=host.docker.internal:host-gateway ndtp-telemetry-emulator:1.0
curl -fsS -X POST http://localhost:18080/api/config \
  -H 'Content-Type: application/json' \
  -d '{"targetHost":"host.docker.internal","targetPort":9201,"units":[{"unitId":985940,"intervalMs":500,"autoGenerate":true,"cells":[]}]}'
```

`GET /v1/ingest` показывает handshake/connections, accepted frames и ошибки; `GET /v1/vehicles` — UTC source clock и `unsupported_day`. `docker compose restart backend` закрывает сокет, эмулятор затем подключается снова. Остановите его командой `docker stop transport2-ndtp-emu`; historical demo запускайте после полного `down` без `SOURCE_CLOCK=utc`.

## API и Python reference

- [ML Swagger](http://localhost:8000/docs), [ML OpenAPI](../api/openapi.json).
- [Backend Swagger](http://localhost:8001/docs), [Backend OpenAPI](../api/backend-openapi.json).
- [Consumer OpenAPI](../api/consumer-openapi.json).

Актуальную Python-документацию можно открыть без Sphinx-зависимости:

```bash
PYTHONPATH=. .venv/bin/python -m pydoc transport_ml.final_model
PYTHONPATH=. .venv/bin/python -m pydoc transport_backend.service
PYTHONPATH=. .venv/bin/python -m pydoc consumer.service
```

Для HTML используйте `pydoc -w` в локальном output каталоге; результат содержит host file links. Существующий `docs/pydoc/` сохранён как исторический snapshot начального решения.

## Что доказано и что ограничено

W1 package/API совпал с frozen oracle на 151/151 validate points, максимум расхождения 0.000000490 с. Docker ML sample совпал с package без расхождения. Historical fragment через Docker дал 1630 frames, 1611 новых записей, 19 семантических повторов, без queue drops/errors; consumer показал несколько новых revision и прогнозов, затем disconnect degradation. Официальный эмулятор подтвердил navigation и reconnect на текущем UTC-дне.

Detector на validate имеет coverage 112/151 (74,2%); средняя абсолютная разница с provided `cur_dev_s` — 76,99 с. Это ошибка приближённого detector относительно подсказки, не online model MAE. 13 ТС имеют план; traffic содержит также 17 дополнительных ТС без этого плана. В demo fragment активны 11 unit. C1 без platform score, C2 без независимого onset evidence и C4 с отложенным BI остаются неподтверждёнными. Производительность и общая QA фиксируются отдельно в T-4 evidence.
