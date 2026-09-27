---
schema: task.v3
id: T-7
title: "Единое демо: официальный эмулятор → ML → карта с маршрутом и прогнозом"
status: doing
review_required: qa
plan_review_profile: standard
plan_review_gate: required
type: feature
priority: p1
owner: claude
created_at: "2026-09-27T11:24:42.661Z"
updated_at: "2026-09-27T18:31:09.463Z"
parent: null
depends_on: []
gstack_refs: {}
goal_contract: v1
stream: T
---
# T-7: Единое демо: официальный эмулятор → ML → карта с маршрутом и прогнозом


## Outcome

Primary goal: Одно понятное рабочее демо хакатона: официальный NDTP-эмулятор → Backend → ML → consumer → UI. Пользователь одной задокументированной командой `docker compose` поднимает или перезапускает стек с нуля. Официальный эмулятор из `data/emulator/ndtp-telemetry-emulator.tar`, которого кормят координатами из данных проекта, отправляет NDTP нескольких ТС. Backend строит контекст по расписанию и получает прогнозы реальной модели, consumer отдаёт snapshot, UI рисует упрощённый «Google Maps с прогнозом задержек по маршруту». Карта road-first, транспорт/остановка/цель различимы, у ТС видно направление, маршруты (плановые остановки наряда) видны и на обзоре, ТС с координатами вне маршрута помечены, ускорение и run ID видны, отдельного UI-only сценария нет. Требования покрыты актуальной traceability matrix, документация и evidence честные.
Direction: on-track
Comment: Predecessor — T-6 (история T-6 не переписывается; в T-7 перенесены только актуальные открытые findings и новая цель). Принятый Prompt Draft от 2026-09-27 с поправками пользователя — источник intent; где handoff memo T-6 расходится с ним, действует draft: единый сценарий, официальный эмулятор, без GPT-6, только 1920×1080. Research (data-note, emulator-spike, code-recon, traceability) подтвердил реализуемость; обоснование — [planning.md](planning.md).

### Result examples

Запуск и перезапуск (одна команда; `SOURCE_COMMIT` нужен только для identity в diagnostics, без него UI честно пишет `unknown`):

```bash
SOURCE_COMMIT=$(git describe --always --dirty --abbrev=40) docker compose --profile demo up -d --build --force-recreate --remove-orphans
```

Регистрация прогона драйвером (иллюстрация формы; точные имена полей фиксирует W3 и `docs/api/backend-v1.md`):

```text
POST backend:8001/v1/run
{"dataset_start":"2026-01-06T06:30:00","dataset_end":"2026-01-06T08:30:00","speedup":5,
 "units":[664030, ...16 шт.], "path":{"664030":[[37.43,55.80], ...]}}
→ 201 {"run_id":"run-20260927T120501-3f9c","clock_mapping":{"epoch_origin":1790496301,
       "dataset_origin":"2026-01-06T06:30:00","rate":5}}
повторный POST в том же процессе → 409 {"detail":"run_already_registered","run_id":"run-…"}
```

Конверт `/api/snapshot` → `snapshot.run` (новое):

```text
{"run_id":"run-20260927T120501-3f9c","state":"running","speedup":5,
 "dataset_start":"…06:30:00","dataset_end":"…08:30:00","dataset_time":"…06:47:10",
 "progress":0.14,"source":"official_emulator"}
до регистрации: {"run_id":null,"state":"waiting_driver", ...}
```

Строка ТС получает `target_lon`, `target_lat`; в snapshot только ТС текущего прогона.

Маршрутный контекст `GET /api/route/{tr_id}` (consumer → Backend `GET /v1/route/{tr_id}`):

```text
{"run_id":"run-…","tr_id":"132430","unit_id":…,
 "path":[[lon,lat],…],          // план подачи драйвера на всё окно: «путь по GPS прогона»
 "passed":[[lon,lat,"06:41:05"],…], // только valid GPS, реально принятые Backend в этом run
 "stops":[{"stop_id":"5369…","time":"06:52:00","lon":…,"lat":…,"role":"before_target"},
          {"stop_id":"…","time":"06:58:00","lon":…,"lat":…,"role":"target"},
          {"stop_id":"…","time":"07:03:00","lon":…,"lat":…,"role":"after_target"}, …],
 "cur_dev_s":95,"prediction_s":140,"model_version":"…","artifact_sha256":"…"}
остановка без валидной координаты → в stops не попадает (и считается в "stops_dropped")
```

UI на 1920×1080 (было → стало):
- было: переключатель «Демо-сценарий / Поток Backend», live — мелкие круги, бледные дороги, цели нет;
- стало: шапка «Официальный эмулятор NDTP → ML · прогон run-…3f9c · Ускорение ×5: 1 мин показа = 5 мин данных · время данных 06:47 · идёт (14 %)»; ТС — иконки автобуса; дороги с casing главнее зданий; на обзоре тонкие маршруты всех ТС; у выбранного ТС подсвечен только маршрут наряда между остановками: путь впереди ярко, пройденная часть тускло (GPS-след не рисуется), стрелка направления на иконке, остановки отдельным символом с временем, выделенная цель с прогнозом модели; ТС вне маршрута с пометкой «вне маршрута ~N км»; карточка: «Текущее опоздание 1 мин 35 с (факт)», «Цель 06:58 — прогноз модели +2 мин 20 с», остановки до цели «06:52 → ~06:53:35 (по факту, не прогноз)», после цели «07:03 → ~07:05:20 (допущение: тот же сдвиг)» с переключателем «Показывать сдвиг после цели».
- нет прогноза: карточка «Прогноза нет: у ТС нет плановой остановки через 10–15 мин» / «модель недоступна (timeout)» / «нет валидного GPS», статус не зелёный.

## Decisions

- **Источник данных — только официальный эмулятор** (`ndtp-telemetry-emulator:1.0`, не модифицируется). В нём нет маршрутов/расписания, поэтому драйвер-сервис `scripts/emulator_driver.py` (тот же образ, profile `demo`) берёт кадры `data/validate/traffic.csv` выбранного окна и штатным `POST /api/config` подаёт эмулятору явные `G6CellNav00` для всех ТС окна; эмулятор сам отправляет NDTP в Backend. `autoGenerate` не используется; `replay_ndtp.py` остаётся инструментом тестов, но не источником демо (`scripts/replay_ndtp.py` не меняется; драйвер имеет собственный загрузчик (читает `is_hist_data`, фильтрует и упорядочивает по `event_time`) и может импортировать только нейтральные helpers вроде кодирования навигации).
- **Темп драйвера** (по [emulator-spike](artifacts/emulator-spike.md)): `intervalMs=3600000` («один POST — одна точка»), период POST `DEMO_POST_PERIOD_S=2` (минимум 1, меньше запрещено валидацией), в одном POST все ТС. **Порядок точек — по dataset `event_time`, монотонно на ТС** (эмулятор ставит текущее время, поэтому задержку доставки воспроизвести нельзя): строки `is_hist_data=True` и строки с `event_time` не позже уже отправленной для ТС пропускаются и считаются в trace; за период уходит последняя точка ТС с `event_time ≤` текущему времени данных (исправления одной секунды схлопываются по последнему `receive_time`). Если новой точки нет — повторяется последняя отправленная, но **не дольше `DEMO_REPEAT_MAX_S=30` с данных** (≈3 медианных шага GPS); дальше ТС убирается из конфига эмулятора до своей следующей точки, и Backend честно показывает `stale_gps`/отключение; `course` ограничен 0…360, `speedAvg/course` целые, биты `extraDopBit5-7` заданы явно, invalid-строки уходят с `extraDopBit7=false`; эхо каждого POST сверяется.
- **Ускорение — настройка, по умолчанию ×5** (`DEMO_SPEEDUP`, env драйвера): при P=2 с сохраняется ≈70 % точек; ×10 допустимо только с P=1 с; >×10 разрешено. Драйвер при любом N считает `thinned_ratio` (доля точек окна, не отправленных из-за прореживания) и `repeat_ratio` и сообщает их Backend в `POST /v1/run/{id}/state` (heartbeat каждые ≤10 с); `run.thinned_ratio` всегда виден в diagnostics UI. Окно по умолчанию `DEMO_WINDOW=06:30–08:30` (по [data-note](artifacts/data-note.md): 16 активных ТС, 10 с прогнозами). При ×5 показ ≈24 мин.
- **Часы и прогон принадлежат Backend, единый владелец — новый `transport_backend/run.py` (`RunRegistry`).** Он хранит `run_id`, lifecycle, mapping, список ТС, manifest и метрики драйвера; `NDTPServer` (вместо `mapping` при сборке), clock, `Orchestrator`, `/ready`, `/v1/ingest`, `/v1/vehicles`, `/v1/route` читают mapping и часы только через него. До регистрации: `clock()` возвращает `None`, tick и snapshot не вызывают `Schedule`, snapshot отдаёт `run.state=waiting_driver` и `vehicles=[]`, NDTP-кадры отклоняются со счётчиком `rejected_no_run` (handshake разрешён, чтобы не было reconnect-шторма). Tick и snapshot вызывают `clock()` и `_vehicle` под `Orchestrator._lock` (детектор остановок не допускает часов назад). `ClockMapping` получает `rate` (по умолчанию 1; `to_epoch` при `rate≠1` запрещён). В `SOURCE_CLOCK=simulation` Backend стартует в состоянии `waiting_driver` без mapping; `POST /v1/run` создаёт единственный на процесс прогон: canonical `run_id` генерирует Backend, mapping `(epoch_origin=сейчас, dataset_origin=dataset_start, rate=speedup)`, список ТС и path-manifest. Повторная регистрация → 409; до регистрации кадры отклоняются с явным счётчиком. Драйвер синхронизирует время данных по возвращённому mapping. Зашитый `03:20` удаляется.
- **Lifecycle** `waiting_driver → starting (зарегистрирован, кадров ещё нет) → running → completed | failed | stalled`: `completed/failed` сообщает драйвер (`POST /v1/run/{run_id}/state`), `stalled` Backend ставит сам, если в `running` нет принятых кадров > 30 с wall. Progress = (dataset_time − start)/(end − start).
- **Эмулятор в compose:** `image: ${EMULATOR_IMAGE:-ndtp-telemetry-emulator:1.0}`, `pull_policy: never` (без `docker load` — понятная ошибка, никакого pull из Docker Hub), порт `127.0.0.1:18080:18080` только для диагностики; драйвер обращается по внутренней сети `http://emulator:18080`.
- **Сброс = recreate стека** командой из Result examples. Состояние Backend/consumer in-process, поэтому recreate даёт чистое состояние и новый `run_id`; UI сбрасывает события/историю/выбор/трек при смене `run_id` в snapshot. Endpoint сброса не делаем. Второй драйвер получает 409 и завершается с ошибкой, конфиг эмулятора не трогает (регистрация до первого `POST /api/config`).
- **Прогнозы не зависят от открытого UI:** сейчас постановка ML-задач происходит только внутри `GET /v1/vehicles` (`orchestration.py:231-263`), т.е. при опросе consumer. Backend получает собственный периодический tick (≈1 с wall) в `Orchestrator`, который оценивает ТС прогона тем же кодом; `predict_interval_s` остаётся во времени данных.
- **Семантика актуального прогноза в живом потоке (владелец — статус строки ТС в Backend `_vehicle`).** Новый кадр той же цели не делает прогноз «отставшим»: если последний успешный прогноз относится к текущей цели и его возраст во времени данных ≤ `PREDICTION_FRESH_S` (90 с данных), строка остаётся `status="normal"` с `prediction_updating=true`, значением и возрастом прогноза; `prediction_behind_input`/`prediction_aging` → `degraded` только при смене цели или возрасте > `PREDICTION_FRESH_S`. UI `assess()` по смыслу не меняется (normal → уровень прогноза) и показывает бейдж «обновляется» с возрастом. Событие от реального alert не переключается `active↔monitoring_lost` на каждом кадре.
- **Стабильность событий при смене цели (цель меняется ≈ раз в минуту данных, ≈12 с wall при ×5).** Смена цели сразу ставит новый прогноз (уже due в `orchestration.py:257-264`); порог свежести успешного прогноза — `PREDICTION_FRESH_S = 1.5 × predict_interval_s` (90 с данных), чтобы плановое обновление на 60 с не создавало разрыв. Пока новый прогноз для новой цели в работе (`prediction_pending` после смены цели), строка — `degraded` с причиной `prediction_pending` и честной подписью «прогноз обновляется для новой цели», прежнее значение не выдаётся за прогноз новой цели. Владелец устойчивости событий — `dashboard/incidents.js`: эпизод переходит в `monitoring_lost` только если `nodata` длится непрерывно ≥ `LOST_AFTER_S=15` с wall; кратковременный `pending` не пишет строку истории и не ставит unread.
- **Мигание при переподключении** (spike: окно ~4 мс, max 219 мс на каждый POST): `TelemetryState` считает ТС подключённым, если активная сессия есть или последняя закрылась < `RECONNECT_GRACE_S=3` с wall назад; счётчики `connections/disconnects` остаются честными.
- **Повтор точки** при отсутствии новой сохраняет исходные координаты и скорость; детектор остановок фиксирует только первое наблюдение каждого планового прибытия, поэтому повтор не создаёт новых наблюдений; доля повторов пишется в trace драйвера.
- **Snapshot:** конверт `/v1/vehicles` получает `run`; `vehicles` — только ТС текущего прогона; строка ТС — `target_lon/target_lat`. Consumer пропускает новые поля без изменений; новый proxy `GET /api/route/{tr_id}` по образцу `SnapshotReader` (ошибка → честный `status:"offline"`/404, без выдуманных данных).
- **Маршрутный контекст** отдельной ручкой, не внутри snapshot; цель, `cur_dev_s`, `prediction_s`, `model_version` и `revision` route берёт из последней посчитанной строки ТС (той же, что в snapshot), без собственного пересчёта `Schedule`, и отдаёт `vehicle_revision` для сверки: `path` из manifest драйвера (display-only; подпись «путь по GPS прогона», не официальная трасса, не вход модели); `passed` — valid GPS из `TelemetryState.history` текущего run; `stops` — `Schedule.by_vehicle[tr_id]` по времени в окне `[сейчас − 5 мин, цель + 15 мин]` (без цели — `[сейчас − 5, сейчас + 30]`), не более 40, **цель всегда включена** (при переполнении отбрасываются самые ранние); роли: `passed` (детектор уже наблюдал или план + `cur_dev_s` < сейчас — только плановое время, серым), `before_target`, `target`, `after_target`, либо `planned` без цели; stop без конечной координаты в пределах bbox карты исключается и считается в `stops_dropped`. На карте все остановки окна — точки; подписи времени только у цели и ближайшей будущей, остальные — по hover и в карточке.
- **Отображение прогноза (решение пользователя):** текущее опоздание ТС = `cur_dev_s` (факт); остановки до цели = план + `cur_dev_s` с подписью «по факту, не прогноз»; цель = план + `prediction_s` модели, выделена; после цели = план + `prediction_s` с подписью «допущение: тот же сдвиг» — переключаемо (по умолчанию включено; решение о default после визуального сравнения). Коды причин Backend/ML (`ml_unreachable_or_timeout`, `ml_http_*`, `ml_schema_mismatch`, `prediction_queue_full`, `unsupported_vehicle`, `unsupported_day`, `stale_or_missing_telemetry`, `no_target_in_horizon`, `no_confident_observed_stop`, …) получают русские подписи; неизвестный код показывается как есть.
- **Один сценарий:** удалить `dashboard/scenario.js`, `scenario.test.mjs`, режимы/`?mode=`, `#scenario`, `mode-switch`, сценарные направления/каталог, `ui-demo`, `replay` и `simulation` profiles в compose; `scenario_label` Backend заменить на `run.source`. Диспетчерские функции M1 (события, карточка, ack/reopen, заметки, история) работают на живых данных. Ошибка Backend → честный offline/last-known статус.
- **Карта (W7):** в существующем inline-стиле MapLibre: casing + иерархия `highway > major > minor`, контраст к фону, здания приглушены и видимы только с z15; внешних tiles/CDN нет. Иконки: bundled SVG из лицензируемой библиотеки (напр. Lucide `bus`, ISC) с сохранением LICENSE/attribution в `dashboard/` и README; ТС рисуются в существующем transport-слое как текстурные иконки; остановка — кружок с белой заливкой и тёмной обводкой, цель — отдельный флаг/ромб. Состояния не только цветом: warning — бейдж «!», selected — кольцо + увеличение, stale/offline — полая/серая иконка с пунктирным кольцом, invalid GPS — серая иконка с «?» на последней валидной позиции (нет валидной — ТС не рисуется на карте, но есть в списке). Новые маркеры входят в `obstacles` раскладки подписей.
- **Build identity (W8):** `Dockerfile` `ARG SOURCE_COMMIT` → env; consumer `/api/build` отдаёт `{files, source_commit, dashboard_bundle_sha256, consumer_static_sha256}` по рецепту T-6 (`m2.md:21-22`, те же относительные пути), ключ `files` сохранён; diagnostics показывает все поля; отсутствие `SOURCE_COMMIT` → `unknown`, не выдуманный hash. Команда запуска передаёт `SOURCE_COMMIT=$(git describe --always --dirty --abbrev=40)`, поэтому грязное дерево видно как `<sha>-dirty`.
- **Actors и write boundaries.** Coordinator — Claude Code (exact `claude-opus-5-5`): интеграция, запуск стека, browser evidence, commits. Implementation agents — только Opus 5.5, с непересекающимися write sets: **A (runtime)** `transport_backend/**`, `consumer/service.py`, `Dockerfile`, `compose.yaml`, `scripts/emulator_driver.py`, удаление `scripts/start_ndtp_simulation.py` (заменён драйвером), `tests/**` (кроме `tests/system_probe.py`), `docs/api/**` (только A); **B (UI)** `dashboard/**` (кроме generated), `consumer/index.html`, `consumer/static/**` только через `npm --prefix dashboard run build`; **C (docs)** `README.md`, `dashboard/README.md`, `docs/runbooks/**`, `docs/index.md` (без `docs/api/**`); **D (QA)** read-only, пишет только task artifacts. Agents не откатывают чужие изменения и не коммитят; commits делает coordinator после проверки exact staged paths. GPT-6 не участвует.
- **Amendment 2026-09-27 (пользователь): маршрут, сверка с ним, направление, обзорная карта.**
  - **Что называем маршрутом (подтверждено пользователем: «остановки по наряду — это и есть маршрут»).** `route_id` в данных нет; маршрут ТС = плановая последовательность остановок его наряда `tr_id` из `schedule_plan` (наряд на день из нескольких кругов, поэтому берётся окно по времени) (линия через остановки по времени, подпись «маршрут по плану остановок», не дорожная трасса). Серая линия «путь по GPS прогона» — собственный GPS ТС из окна данных; это разные слои.
  - **Сверка с маршрутом (владелец — Backend).** Для каждой строки ТС: `route_offset_m` — расстояние (м, округление до 10 м, чтобы не менять revision на каждом тике) от последней валидной позиции до ближайшего сегмента линии через **все** плановые остановки наряда `tr_id` за день (пространственная сверка; линия статична, считается один раз при старте). `off_route=true`, если `route_offset_m > OFF_ROUTE_M=400` (env); снимается при `< OFF_ROUTE_CLEAR_M=250` (гистерезис против мигания). Без плана (<2 остановок) или валидной позиции — `null`, не `false`. Основание — офлайн-распределение по окну 06:30–08:30 ([offroute-distribution](artifacts/offroute-distribution.txt)): у 10 нормальных ТС медиана 8–16 м, P90 ≤ 102 м, доля > 400 м = 0 (кроме 122048 — 4 %); у 122658 26 % точек > 400 м (хвост до 18 км — случай пользователя), у 130072 100 % (~3,4 км; наряд начинается в 20:25), у 122613 49 %. Сверка «по времени» (плановая позиция в момент t) отвергнута: даже у нормальных ТС P90 до 1,7 км из-за отклонения от графика. Прогноз не скрывается и статус не подменяется: UI показывает отдельный маркер и подпись «вне маршрута ~N км — координаты не совпадают с маршрутом наряда»; если у ТС есть прогноз — добавка «прогноз может быть неверен»; если наряд в окне ещё не начался (нет плановых остановок в окне отображения) — «наряд ещё не начался» вместо предупреждения о прогнозе.
  - **«Впереди» на маршрутах туда-обратно:** ближайшая точка линии ищется только среди сегментов, чьё плановое время попадает в `[сейчас − 10 мин, сейчас + 20 мин]` (с учётом `cur_dev_s`, если он есть), чтобы не прилипнуть к обратному рейсу; проверяется fixture-тестом туда-обратно.
  - **Направление движения.** Строка ТС получает `heading` (градусы 0–360, целое) из последнего валидного кадра со скоростью > 3 км/ч в пределах последних 120 с данных, иначе `heading=null` (стоит или давно нет движения). Иконка ТС несёт стрелку направления только при `heading != null`; при `null` стрелки нет, ТС показано как стоящее.
  - **Одно окно отображения маршрута:** `[сейчас − 15 мин, сейчас + 45 мин]` по плановому времени — и для обзора, и для выбранного ТС (список остановок в карточке остаётся в своём окне `[сейчас − 5, цель + 15]`, которое в него входит). Сверка `off_route` использует весь наряд (см. выше) — это сознательно другое правило: она про «где вообще ездит ТС», а не про отрисовку.
  - **Маршруты на обзорной карте.** Новый лёгкий endpoint `GET /v1/routes` (consumer `GET /api/routes`) → `{run_id, window_start, window_end, routes:[{tr_id, line:[[lon,lat]...], off_route, route_offset_m}]}` для всех ТС прогона (линия — остановки окна по времени, без остановок вне bbox данных); UI опрашивает его ≈ раз в 10 с. На обзоре маршруты — тонкие приглушённые линии под ТС.
  - **Слои выбранного ТС (пользователь, 2026-09-27; сверху вниз):** иконка ТС со стрелкой → **впереди** — маршрут (линия между плановыми остановками) от точки ТС на маршруте до конца окна, **ярко** → **пройдено** — тот же маршрут от начала окна до точки ТС, **тускло** → остановки и цель. Подсвечивается только маршрут между остановками, не GPS: ни `passed`, ни `path` (GPS прогона) по умолчанию не рисуются (в API остаются).
  - **Точка ТС на маршруте (владелец — Backend).** Проекция последней валидной позиции на линию окна, ближайшая среди сегментов со временем в `[сейчас − 10, сейчас + 20]` мин (с `cur_dev_s`). Небольшое отклонение GPS от линии (`off_route=false`) — норма: ТС считается на маршруте и едущим, делится по проекции. Сильное (`off_route=true`) — отдельный случай: маршрут окна рисуется целиком тускло без деления на пройдено/впереди, от ТС к ближайшей точке маршрута — тонкая пунктирная выноска с подписью «вне маршрута ~N км». Нет сегмента в интервале или нет позиции — деления нет, маршрут тускло. `/v1/route` отдаёт `route_line: {passed:[[lon,lat]...], ahead:[[lon,lat]...], split:[lon,lat]|null, split_reason: 'on_route'|'off_route'|'no_segment'|'no_position', nearest:[lon,lat]|null, off_route, route_offset_m}`; `nearest` и `route_offset_m` — по линии **всего наряда** (как сверка), поэтому выноска есть и когда линии окна нет (пример 130072: наряд с 20:25).
  - **Иконки:** ТС и остановка различимы с первого взгляда (см. «Карта (W7)»), направление видно на иконке ТС.
- **Viewport** только 1920×1080. Finding T-6 про 1366×768 — out of scope. `docker pause/unpause` не выполняется; offline-путь проверяется recreate/stop consumer→backend только в пределах стека проекта.
- Commits небольшие, после проверенных slices. По разрешению пользователя от 2026-09-27 каждый проверенный этап пушится в `origin/dev` и сливается в `main` с push `origin/main` (перед слиянием — `git fetch`, чужие коммиты в `main` сливаются без force; force-push запрещён). PR, deploy, publication и submission запрещены. Concurrent commit `e3015b9` не откатывать. Загрузка решения на платформу хакатона — действие пользователя вне T-7.

## Boundary

- **Included:** W1–W13 ниже (W11–W13 — amendment 2026-09-27: маршрут наряда на обзоре и у выбранного ТС, сверка `off_route`, направление `heading`, доработки по UI-review): traceability matrix; data note и spike (готово); Backend `rate`/прогон/lifecycle/route endpoint/`target_lon/lat`/фильтр ТС; драйвер эмулятора и compose profile `demo`; consumer route proxy и build identity; удаление UI-only сценария; UI прогона, ускорения, маршрута и прогноза; реальный ML gate; road-first карта и иконки; документация; browser evidence 1920×1080; независимый Opus 5.5 QA.
- **Excluded:** модификация эмулятора; переобучение/новый score; изменение горизонта модели (10–15 мин) на «следующую остановку»; полный импорт маршрутов Москвы и map-matching; использование `time_fact_begin` как входа или «факта» в UI; production auth/multi-user history; endpoint сброса без recreate; внешние tiles/CDN; другие viewport; `docker pause/unpause`; действия с контейнерами вне стека проекта; PR/deploy/publication/submission и force-push (push в `origin/dev` и слияние в `main` разрешены пользователем 2026-09-27, см. Decisions); изменения T-5, `.idea/`, `tests/system_probe.py`, `data/**`.

## Work items

- [x] W1: Baseline и traceability matrix (baseline-версия).
  - Deliverable: [baseline](artifacts/baseline.md) и [requirements-traceability](artifacts/requirements-traceability.md) на `e3015b9` (148 требований; met 46 / partial 53 / missing 24 / blocked 4 / out of scope 21). Финальная актуализация статусов с evidence-ссылками — часть W9.
  - Contribution: фиксирует, что T-7 должна закрыть, без завышенных claims.
  - Proxy result: наличие файла/checkbox как «met».
- [x] W2: Исследование данных эмулятора и CSV.
  - Deliverable: [data-note](artifacts/data-note.md): поля совпадают кроме времени (ставит эмулятор) и идентификаторов пакета; `unit_id↔tr_id` 1:1; маршрутной группировки выше `tr_id` нет; модель прогнозирует первую плановую остановку в (T+10, T+15] мин; окно 06:30–08:30 и focus ТС 132430/133300/134040.
  - Contribution: выбор ТС, окна и честной семантики маршрута/прогноза.
  - Proxy result: предположения о полях без проверки.
- [x] W3: Backend-прогон и драйвер официального эмулятора (agent A).
  - Deliverable: `ClockMapping.rate`; simulation без зашитого 03:20; `POST /v1/run`, `POST /v1/run/{id}/state`, `run` в `/ready` и `/v1/vehicles`, lifecycle со `stalled`; фильтр ТС прогона; `RunRegistry`; собственный tick прогнозов в `Orchestrator`; семантика `prediction_updating`; reconnect grace; `scripts/emulator_driver.py` (регистрация → поток POST с эхо-проверкой и heartbeat метрик → `completed/failed` → очистка конфига эмулятора); удалён `scripts/start_ndtp_simulation.py`; compose profile `demo` = `emulator` + `driver`, `backend` по умолчанию `SOURCE_CLOCK=simulation`; удаление `ui-demo`/`replay`/`simulation` profiles; spike-evidence ([emulator-spike](artifacts/emulator-spike.md), готово).
  - Contribution: реальный поток официальный эмулятор → Backend с управляемой скоростью и прогоном.
  - Proxy result: `autoGenerate`/прямой replay под видом эмулятора; ускорение только в драйвере без rate в Backend; второй драйвер, тихо перетирающий конфиг.
- [x] W4: Единый сценарий, прогон и ускорение в UI (agent B).
  - Deliverable: удалены сценарий/режимы; шапка с источником, `run_id`, «Ускорение ×N: 1 мин показа = N мин данных», временем данных, lifecycle и progress из `snapshot.run`; сброс UI-состояния при смене `run_id`; русские подписи причин; browser-check переписан на live-данные (fixture-интерцепция допустима только в regression-проходах и так подписана).
  - Contribution: единственный понятный показ без второго режима.
  - Proxy result: скрытый scenario-код или default-ветка; hardcode коэффициента.
- [x] W5: Маршрутный контекст и прогноз (agents A + B).
  - Deliverable: A — `GET /v1/route/{tr_id}` + `target_lon/lat` + consumer `GET /api/route/{tr_id}`; B — слои path/passed/stops/target с легендой и карточка с фактом/прогнозом/допущением и переключателем.
  - Contribution: «Google Maps с прогнозом задержек по маршруту» в честном упрощении.
  - Proxy result: весь дневной план; линия как «трасса»; `[0,0]`; прогноз модели на остановках, для которых модель его не давала, без подписи допущения.
- [x] W6: Реальный ML gate (coordinator).
  - Deliverable: на поднятом стеке ≥2 новых model results от разных inputs текущего run (разные `prediction_input_frame_id`/`prediction_context_revision`, один `model_version`/`artifact_sha256`) с теми же `prediction_s` в `/api/snapshot`, `/api/route` и UI того же ТС; evidence `artifacts/ml-gate.md` + snapshots JSON + скриншоты; non-success путь: ML остановлен (`docker compose stop ml` в стеке проекта) → `ml_unreachable_or_timeout` с русской подписью, не зелёный статус; ML снова запущен → прогнозы вернулись.
  - Contribution: доказательство сквозной цепочки на новом прогоне.
  - Proxy result: ML stub, interception, переизданный старый result, `/ready`/revision growth как «прогноз».
- [ ] W7: Road-first карта и символы (agent B, после W4/W5).
  - Deliverable: стиль и иконки по Decisions; LICENSE/attribution иконок; before/after скриншоты 1920×1080; collision checks из T-6 проходят; pan/zoom/selection без регрессии.
  - Contribution: читаемая карта, где ТС, остановка и цель не путаются.
  - Proxy result: перекраска без скриншотов; внешние tiles/CDN; различие состояний только цветом.
- [x] W8: Build identity (A — consumer/Dockerfile/compose; B — diagnostics UI).
  - Deliverable: `/api/build` с полной identity и `files`; diagnostics показывает все поля; regression tests (pytest на форму/рецепт; JS/browser на отображение).
  - Contribution: проверяемая связь показанной сборки с commit.
  - Proxy result: hardcode hash в UI; поломка `files`.
- [ ] W9: Документация и финальная matrix (agent C + coordinator).
  - Deliverable: `README.md`, `dashboard/README.md`, `docs/runbooks/local-demo.md`, `docs/runbooks/geography-foundation.md`, `docs/runbooks/integration-handoff.md` (API-документы `docs/api/**` обновляет agent A в W3/W5/W8): prerequisites (`docker load -i data/emulator/ndtp-telemetry-emulator.tar`, данные, модель `.local/validate-tuning-2026-09-26`, PMTiles), одна команда запуска/перезапуска, `DEMO_SPEEDUP/DEMO_WINDOW/DEMO_POST_PERIOD_S`, lifecycle, семантика слоёв маршрута и прогноза, troubleshooting (нет tar, 409, `stalled`, `future simulation event`, нет прогноза), ограничения; UI-only/replay/`autoGenerate` инструкции удалены или помечены историческими; cold-reader прогон команд; matrix обновлена по фактическому evidence.
  - Contribution: воспроизводимый показ для жюри и команды.
  - Proxy result: docs, не проверенные запуском; статусы matrix без evidence.
- [ ] W11: Маршрут по плану остановок и сверка с ним (agent A: Backend `route_offset_m`/`off_route`, `heading`, `GET /v1/routes` + consumer `/api/routes`, docs/api; agent B: слой маршрутов на обзоре, подсветка маршрута выбранного ТС, пройденное/впереди разными цветами и пунктиром, маркер и подпись «вне маршрута»).
  - Deliverable: на обзоре 1920×1080 видны маршруты всех ТС прогона; 122658 помечено «вне маршрута» с расстоянием; ТС на маршруте такой пометки не имеют.
  - Contribution: пользователь видит, где ТС должно ехать, и отличает сбой координат от нормы.
  - Proxy result: маршрут выдан за дорожную трассу; `off_route=false` при отсутствии плана/позиции; скрытие прогноза без подписи.
- [ ] W12: Направление движения и понятные иконки (agent B вместе с W7, данные от agent A).
  - Deliverable: иконка ТС со стрелкой/поворотом по `heading`; остановка — другой символ; легенда объясняет оба.
  - Contribution: видно, куда едет ТС, и ТС не путается с остановкой.
  - Proxy result: стрелка при `heading=null`; ТС и остановка одинаковой формы.
- [ ] W13: Доработки по независимому UI-review (agent B после W7/W11/W12): пересечения, иерархия, типографика, тексты по `artifacts/ui-review.md` (создаёт отдельный read-only review-агент; если файла нет — W13 заблокирован до него). Пункт review M-1 (слои по GPS `path`/`passed`) заменён решением пользователя «Слои выбранного ТС»: из M-1 берутся только стрелки направления на «впереди»; приёмка — `#map-pane[data-route-layers="route-passed,route-ahead"]` при `on_route` и `"route-dim,offroute-leader"` при `off_route`.
  - Deliverable: закрыты все high и medium пункты review, не противоречащие Decisions (отклонённые — с записью причины в impl-B.md), каждый с автоматической проверкой в `browser-check.mjs`; low — по решению coordinator.
  - Contribution: интерфейс без пересечений и с понятной иерархией для показа жюри.
  - Proxy result: исправление без измерения пересечений.
- [ ] W10: Независимая финальная QA (agent D).
  - Deliverable: `artifacts/qa-final.md` — Opus 5.5 QA agent, не участвовавший в реализации, на реальном стеке 1920×1080 после product commit с новой build identity; verdict `ACCEPTED/FINDINGS`; findings → исправление → полный повтор QA.
  - Contribution: независимое подтверждение Outcome.
  - Proxy result: самопроверка coordinator/implementer вместо QA.

Порядок: W3 → (W5-A, W8-A) → стек поднят → W4 → W5-B → W6 → commit slice 1+2 → (W7 ∥ W11-A) → W11-B + W12 → W13 → commit → W9 (дополнение) → commit → W10. Каждый проверенный этап: commit → push `origin/dev` → слияние в `main` → push `origin/main` (разрешение пользователя 2026-09-27). A и B могут идти параллельно после фиксации контракта (Result examples); B до готовности A работает на fixture по тому же контракту.

## Verification

- **Plan gate:** независимый review плана (profile `standard`, отдельный Opus 5.5 reviewer) favorable до первого product edit.
- **Backend (pytest):** `ClockMapping(rate=5).from_epoch` масштабирует; `to_epoch` при `rate≠1` падает; `POST /v1/run` → 201 и `run` в `/ready`/`/v1/vehicles`; повторный → 409; кадры до регистрации отклоняются со счётчиком; lifecycle `starting→running→completed`, `stalled` по таймауту (инъецируемые часы); прогнозы ставятся tick-ом без вызова `/v1/vehicles`; до регистрации snapshot `waiting_driver`/`[]`, кадры → `rejected_no_run`, без 500; новый кадр той же цели при прогнозе младше `PREDICTION_FRESH_S` оставляет `status=normal` + `prediction_updating=true`, смена цели → `degraded/prediction_pending` и немедленная постановка нового прогноза, старение > `PREDICTION_FRESH_S` → `degraded`; reconnect в пределах grace не даёт `disconnected`; route возвращает цель, прогноз и `vehicle_revision` той же строки, что snapshot; stops содержат цель при 40+ кандидатах, роль `passed` у прошедших; snapshot содержит только ТС прогона и `target_lon/lat`; `/v1/route/{tr_id}`: `passed` только valid и только текущего run, stops ≤40 по времени в окне `[сейчас − 5 мин, цель + 15 мин]`, цель всегда включена, роли `passed/before_target/target/after_target/planned`, stop без координаты исключён и посчитан в `stops_dropped`; неизвестный `tr_id` → 404.
- **Драйвер (pytest):** порядок по `event_time`, пропуск `is_hist_data` и немонотонных строк, выбор последней точки за период, повтор не дольше `DEMO_REPEAT_MAX_S` и удаление ТС из конфига после, `thinned_ratio/repeat_ratio`, clamp `course`, биты валидности, формат `fields`, отказ при несовпадении эха, выход с ошибкой при 409, `completed` в конце окна (эмулятор и Backend — fake HTTP).
- **Consumer (pytest):** `/api/route/{tr_id}` proxy (online/offline/404); `/api/build` содержит `files` и identity-поля, hash совпадает с host-рецептом T-6 на тех же файлах; без `SOURCE_COMMIT` → `unknown`.
- **Dashboard:** `npm --prefix dashboard test` (без `scenario.test.mjs`; новые тесты: `nodata` короче `LOST_AFTER_S` не переводит эпизод в `monitoring_lost`, не пишет историю и unread, сброс по `run_id`, форматирование ускорения, классификация остановок до/на/после цели, подписи причин); `npm ci --prefix dashboard && npm --prefix dashboard run build`; `consumer/static` только из build; `map-worker.js` byte-identical (иначе объяснение); `rg -n "scenario|mode=demo|ui-demo" dashboard consumer compose.yaml` → только допустимые упоминания (объяснены).
- **Compose:** `docker compose config --quiet`; команда из Result examples поднимает стек; `docker compose ps` healthy; через ≤2 мин `snapshot.run.state=running`, ≥8 ТС с позициями; повторная команда → новый `run_id`, UI очистил историю; ручной запуск второго драйвера (`docker compose run --rm driver`) → 409 и неизменный `GET /api/config` эмулятора; отсутствующий образ проверяется как `EMULATOR_IMAGE=ndtp-telemetry-emulator:absent docker compose --profile demo up -d emulator` → ошибка «image not found», pull не происходит. **Настраиваемость:** второй прогон с `DEMO_SPEEDUP=10 DEMO_POST_PERIOD_S=1` → `snapshot.run.speedup=10`, индикатор «×10», Δ`dataset_time`/Δwall = 10 ± 5 % за ≥60 с, `thinned_ratio` виден. **Живой поток 5 мин при ×5:** у ТС с успешным прогнозом ≥80 % опросов `status=normal` (с уровнем прогноза), 0 строк `disconnected` у активных ТС, ≥1 событие от реального alert, у которого за 5 мин нет ни одного перехода в `monitoring_lost` из-за смены цели или планового обновления (история событий проверяется по строкам); ML latency и queue drops записаны (остаточный риск нагрузки 16 ТС).
- **ML gate (W6):** см. W6; evidence связывает `run_id → frame_id → prediction_input_frame_id → prediction_s → /api/snapshot → /api/route → UI`.
- **UI/map 1920×1080 (встроенный browser, реальные requests):** скриншоты: обзор, выбранное ТС с путём/остановками/целью, карточка с фактом/прогнозом/допущением и переключателем, нет прогноза, stale/invalid, diagnostics; **M1 на живых данных:** открыть событие → перейти к ТС → карточка → «Взять в работу» → заметка (HTML не исполняется) → reopen → история; recreate → история очищена по новому `run_id`. Assertions: индикатор ускорения = `snapshot.run.speedup`, нет элементов сценария, stop/target не в `[0,0]`, иконка ТС ≠ символ остановки ≠ символ цели, состояния различимы без цвета, подписи без пересечений (T-6 collision checks), консоль без ошибок, внешних запросов нет.
- **Docs:** cold-reader прогон команд из README/runbook на чистом recreate; ошибки в troubleshooting воспроизводимы (нет образа эмулятора → понятное сообщение).
- **Failure paths:** нет tar/образа эмулятора, данных, модели или PMTiles → точный prerequisite; Backend недоступен → consumer offline/last-known, UI без подмены; драйвер упал → `failed`/`stalled` в UI; ML недоступен → причина, не зелёный статус; нестабильный эмулятор → стоп и вопрос пользователю.
- **Amendment (W11–W13):** pytest — `route_offset_m` на синтетическом плане (точка на сегменте → ≈0, в 1 км → `off_route=true`, гистерезис 400/250 м), `null` без плана/позиции, `heading` только при скорости > 3 км/ч за последние 120 с данных, иначе `null`, `/v1/routes` форма и окно `[сейчас − 15, сейчас + 45]`, `route_line` деление: точка в 50 м от сегмента → `on_route`, passed+ahead = линия окна, fixture туда-обратно выбирает сегмент текущего рейса, `off_route` → без деления; live 5 мин при ×5 — у 130072 `off_route=true` во всех опросах с позицией, у 122658 — хотя бы в части опросов, у 132430/133300/134040/129964/133957 `off_route=false` во всех опросах; browser 1920×1080 — маршруты всех ТС на обзоре, стрелки направления у движущихся ТС, маркер «вне маршрута», нет пересечений подписей (collision checks), закрытые UI-review пункты со своими проверками.
- **Final QA (W10):** новая build identity после commit; verdict ACCEPTED или findings с повтором.

## Execution log

- 2026-09-27: plan review T7-plan-r1/r2 `revise` → исправлено; T7-plan-r3 `ready_with_residual_risk`. Исполнительские уточнения из r3: PR-019 — JS-тест: короткий `nodata` не ведёт ни в `monitoring_lost`, ни в `resolved`; PR-020 — проверку отсутствующего образа эмулятора делать до основного прогона или повторять команду запуска после.
- 2026-09-27: intake принят пользователем; research W1/W2/W3-spike/code-recon завершён agents (Opus), artifacts в `artifacts/`; решение пользователя по отображению прогноза записано.

## Closure
