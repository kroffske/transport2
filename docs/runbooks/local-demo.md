---
title: Локальный NDTP demo
type: runbook
status: active
owner: transport2
tags: [ndtp, docker, integration]
updated: "2026-09-27T00:00:00Z"
description: "Сценарный показ одной командой, рассказ на 2–3 минуты и тезисы pitch; запуск модели, Backend и live consumer с причинным historical replay."
---

# Локальный NDTP demo

Есть два раздельных режима показа. **Сценарный показ** — только интерфейс диспетчера на заданных сценарием значениях; ML и Backend для него не нужны. **Сквозной режим** — три сервиса: Backend принимает TCP NDTP и хранит состояние, ML API загружает выбранную точечную модель, consumer читает Backend HTTP и раздаёт ту же диспетчерскую карту ([`dashboard/README.md`](../../dashboard/README.md)). Режимы не смешиваются: у них разные адреса, а на экране постоянно видна подпись источника.

## Сценарный показ: одна команда

Нужны Docker и локальный файл карты `consumer/map/moscow.pmtiles` (он не хранится в Git; хэш и источник — в `consumer/map/manifest.json`). Собранный интерфейс `consumer/static/` хранится в репозитории. Из корня репозитория:

```bash
docker compose --profile ui-demo up --build -d ui-demo
```

Откройте <http://localhost:8003/?mode=demo>. Экран открывается в режиме «Демо-сценарий · значения заданы»: 8 машин на двух демонстрационных направлениях, одно существующее предупреждение. Все плитки, скрипты и стили раздаются локально; внешние CDN и сеть не нужны. Кнопка «Поток Backend» в этом профиле честно показывает «Backend недоступен · данных нет» — сценарий не подставляется. Остановка: `docker compose --profile ui-demo down`.

Перед показом проверьте, что браузер получил новую сборку: «Диагностика» → «Сборка интерфейса · app.js sha256» должна совпасть с `shasum -a 256 consumer/static/app.js`. После правок в `dashboard/` сначала выполните `npm ci --prefix dashboard && npm --prefix dashboard run build`, затем ту же команду `up --build`. Если на экране «Карта недоступна», файл `moscow.pmtiles` отсутствует в образе: точки на карте не рисуются, список и карточка работают.

**Повтор без перезагрузки.** «Сброс» начинает новый запуск (новый номер запуска в панели сценария) с первой фазы и удаляет события, отметки «В работе» и заметки прошлого запуска. Проверка `dashboard/browser-check.mjs` проходит историю три раза подряд через «Сброс» и сравнивает, что экран показывает одно и то же.

### Рассказ на 2–3 минуты

| Шаг | Действие | Что сказать |
|---|---|---|
| 1 | Обзор карты, указать на жёлтую подпись режима | «Это экран диспетчера. Сейчас демо-сценарий: значения заданы, это не телеметрия и не модель. Одна задержка уже есть — Д-103 на направлении А.» |
| 2 | «Далее» дважды (или «Начать демо»: фаза раз в 8 с) | «Прогноз по Д-104 обновился — появилось новое предупреждение и одно уведомление.» |
| 3 | «События» → верхнее событие «направление Б» | «Диспетчер не ищет по карте: событие сгруппировано по направлению — Д-104 и Д-102 вместе, встречное направление отдельно.» |
| 4 | Карточка Д-104 | «Прогноз задержки у цели Б2, плановое время, свежесть данных. Причина не установлена — мы её не выдумываем.» |
| 5 | «Взять в работу», заметка, «Связь с водителем · прототип» | «Статус "в работе" и заметка локальные. Связь с водителем — прототип: экран готовит текст, отправка не подключена.» |
| 6 | «Далее» дважды | «Данные по Д-103 пропали — это "мониторинг потерян", а не "задержка закончилась". Потом задержки возвращаются в норму: история и отметки остаются, новых уведомлений нет.» |
| 7, по желанию | Переключить на сквозной режим (см. ниже, адрес `:8002/?mode=live`) | «Здесь в карточке — результат настоящей модели, связанный с кадром NDTP и контекстом.» Только если сквозной стек запущен и прогрет заранее. |

В конце — две фразы о следующем этапе: сопоставление реальных маршрутов и остановок, серверная история действий, подключение канала связи с водителем, измерение раннего предупреждения на длительном потоке.

Резервная запись этого рассказа создаётся той же проверкой: `UI_URL=http://127.0.0.1:8003 UI_EVIDENCE_DIR=<каталог> UI_RECORD=1 node dashboard/browser-check.mjs` сохраняет `d06-backup-recording.webm` и контрольные кадры `d06-1-overview-1920.png`, `d06-2-incident-1920.png`, `d06-3-handling-1920.png`.

### Тезисы pitch и что за ними стоит

| Тезис | Что именно готово |
|---|---|
| Диспетчер за секунды видит, где проблема | Работающий интерфейс: карта Москвы на локальных плитках OSM, список, фильтры, карточка. В сценарном режиме значения заданы сценарием. |
| Предупреждение превращается в одно событие по направлению | Работающая локальная обработка в браузере: группировка, «прочитано», «в работе», «задержка закончилась», история. Без серверного хранения и нескольких пользователей. |
| У диспетчера есть следующий шаг | «Взять в работу» и заметка работают локально. Связь с водителем — прототип: текст готовится, отправка не подключена. |
| ML встроен в архитектуру, а не нарисован в UI | NDTP → Backend → отдельный ML API (CatBoost) → consumer → та же карточка. Короткий сквозной фрагмент проверен: разные входные кадры дали разные результаты модели в карточке. Это проверка связи, не точности. |
| Модель | Точечный прогноз задержки у плановой точки. Локальная MAE на validate — 44,0 с; это не официальный score платформы. Вероятность и причина задержки не рассчитываются. |

Не говорить: «доказанное предупреждение за 10–15 минут» (lead-time до начала задержки не измерялся), «команда отправлена водителю» (отправки нет), «все маршруты Москвы» (показаны две демонстрационные схемы, пунктир — не трасса по дорогам), «официальный score N» (ответа платформы нет).

### Короткие ответы на вопросы

- **Откуда данные на экране?** В сценарном режиме — из версии сценария в коде интерфейса; это видно по подписи режима и в карточке («Значение задано сценарием»). В сквозном режиме — из Backend через consumer; при потере Backend показан последний снимок с пометкой, сценарий не подставляется.
- **Где ML?** Отдельный сервис; Backend вызывает его по новым кадрам NDTP. Интерфейс модель не содержит.
- **Что заглушка?** Значения демо-сценария, схемы направлений и связь с водителем. Действия диспетчера работают, но хранятся только в этом браузере и этом запуске.
- **Почему 2D, а не 3D?** Диспетчеру нужен вид сверху: где проблема и что затронуто.

## Сквозной режим: NDTP + ML

Нужны Docker и локальные файлы `data/validate/{traffic.csv,schedule_plan.csv}`, `.local/validate-tuning-2026-09-26/{final_model.cbm,final_model.json,vehicle_origins.csv}`. Модель и данные не входят в Git. При расположении файлов в основном checkout:

```bash
docker compose --profile demo up --build -d
```

При запуске из другого checkout задайте абсолютные host paths:

```bash
DATA_DIR=<основной checkout>/data \
MODEL_DIR=<основной checkout>/.local/validate-tuning-2026-09-26 \
docker compose --profile demo up --build -d
```

Откройте [consumer в режиме потока](http://localhost:8002/?mode=live) сразу после запуска; без параметра страница открывается в явно подписанном «Демо-сценарии» (5 заданных фаз, два демо-направления со схемой точек, центр «События», «Взять в работу» и заметки; кнопки «Начать демо / Пауза / Далее / Сброс»; «Сброс» начинает новый запуск без перезагрузки и без событий прошлого запуска, см. [`dashboard/README.md`](../../dashboard/README.md)). В режиме потока страница раз в 1,5 секунды запрашивает `/api/snapshot`, а consumer — Backend. Demo выдаёт fragment 03:20–03:45 исходного дня со speedup 30; номинальная длительность около 50 секунд, реальное время зависит от обработки. После завершения sender закрывает TCP-соединения, поэтому сохранённые прогнозы закономерно становятся `degraded/disconnected`.

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

Короткий сквозной ML-фрагмент (D02B), без подмены в браузере: при уже запущенных `ml backend consumer` выполните `docker compose restart backend` (свежий replay clock), затем `.venv/bin/python scripts/replay_ndtp.py --traffic data/validate/traffic.csv --start "2026-01-06 03:20:00" --end "2026-01-06 03:35:00" --speedup 2` и откройте `http://127.0.0.1:8002/?mode=live`. В карточке машины с прогнозом поле «Результат модели» показывает кадр NDTP, номер контекста и артефакт модели; каждый новый результат ML меняет кадр, контекст и значение в той же карточке. Это демонстрирует связь NDTP → Backend → ML → consumer → UI, а не точность модели или раннее предупреждение; 15-минутный прогон остаётся отдельным резервом. На host, где `127.0.0.1:8000` занят другим процессом, ML контейнер отвечает на `http://[::1]:8000`.

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

Detector на validate имеет coverage 139/151 (92,05%) на raw receive-ordered validate stream; средняя абсолютная разница с provided `cur_dev_s` — 94,55 с. При одинаковых доступных history и plan замена только `cur_dev_s` даёт среднюю абсолютную разницу прогноза 31,00 с, максимум 202,45 с; правило `prediction_s > 120` меняется в 7/139 пар. NDTP quantization сюда не входит. Это ошибка приближённого detector относительно подсказки, не online model MAE. 13 ТС имеют план; traffic содержит также 17 дополнительных ТС без этого плана. В demo fragment активны 11 unit. C1 без platform score, C2 без независимого onset evidence и C4 с отложенным BI остаются неподтверждёнными. Производительность и общая QA фиксируются отдельно в T-4 evidence.

## Измерения финальной интеграции

Независимая QA проверила source `036f589` в Docker на Apple M5 Pro, 48 GiB host RAM; Docker VM: 18 vCPU и около 7,75 GiB RAM. Исторический fragment 03:20–03:45, speedup 30: 1630 отправленных кадров за 49,91 wall-секунды, 1611 новых записей и 19 wire duplicates, 161 успешный ML request и 10 coalesced jobs, без queue overflow и protocol errors. Consumer API наблюдал 156 отдельных публикаций прогноза; это выборка, а не все входные кадры.

| Интервал в реальном времени | N | P50 | P95 | P99 |
|---|---:|---:|---:|---:|
| От отправки до ingest acknowledgment | 1630 | 1,78 мс | 2,95 мс | 8,97 мс |
| От отправки до первого наблюдения frame в consumer API | 1306 | 70,44 мс | 139,81 мс | 148,80 мс |
| От отправки до наблюдения нового прогноза в consumer API | 156 | 142,71 мс | 569,97 мс | 1118,50 мс |

Таблица использует monotonic clock одного macOS host для sender и probe. Consumer API опрашивался примерно каждые 0,1 секунды; это не browser render latency страницы с polling 1,5 секунды. Unix timestamps публикаций относятся к Docker VM; QA сохранила калибровку и её погрешность отдельно. Source/replay clock не используется для latency.

Холодный старт уже собранных образов до трёх healthy сервисов занял 16,98 с; cached rebuild — 0,61 с. Запрос speedup 3000 дал фактически 1630 кадров за 4,61 с, 74 coalesced jobs и 3 отброшенных obsolete completion; очередь опустела. Это ограниченный lockstep replay, не максимальная пропускная способность. Отдельный burst при искусственном лимите очереди 1 отправил 26 000 кадров: 74 приняты и 25 926 явно отклонены как queue full; размер очереди не превысил 1.

13 плановых unit проверены отдельно: sparse subset 65 реальных receive-ordered кадров и 13 соединений официального UTC-эмулятора с reconnect. Плотный demo fragment имеет 11 активных unit; полное историческое покрытие прогнозами всех 13 этим не заявляется. Отключение ML сохранило last success с явной деградацией, восстановление ML вернуло прогнозы. При недоступном Backend consumer сохранил snapshot и затем вернулся online.

На одинаковых 151 point/history/plan/provided cur_dev Nav00-округление меняет prediction в среднем на 2,78 с, максимум на 58,70 с. Это wire quantization; exact package/HTTP oracle parity остаётся 151/151 с максимумом 0,000000490 с. Detector/hint delta приведена выше отдельно. C1, C2 и C4 остаются неподтверждёнными; C3 ограничен простым consumer, а C5 — этими локальными измерениями.

Подробный [независимый QA отчёт](../../.tasks/_archive/T-4-2026-09-25-backend-dashboard-infra/qa.md) содержит ledger, команды и остаточные ограничения. Повторяемый probe — `tests/system_probe.py`; список фаз: `.venv/bin/python tests/system_probe.py --help`. Для нового historical replay сбросьте Backend clock через restart Backend/consumer или полный `down/up` перед фазой. Сырые trace/JSON остаются в локальных ignored task artifacts.
