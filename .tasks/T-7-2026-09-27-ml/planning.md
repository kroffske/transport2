# T-7 planning

## Q0: Goal alignment

Question: Служит ли T-7 текущей цели проекта и принятому пользователем intent?
Source check: `.locus/soul.md` (раннее предупреждение, point-in-time, end-to-end proof, честные claims); `.locus/roadmap.md` (D01–D09, M0–M2); T-6 task и handoff memo; принятый Prompt Draft 2026-09-27 и поправки пользователя (task notes).
Answer: Да. Пользователь сделал целью одно рабочее демо на официальном эмуляторе вместо разделения UI-сценария и replay. Это усиливает end-to-end proof из `soul.md` (реальный NDTP → Backend → ML → UI) и сохраняет честность claims: путь прогона, факт, прогноз модели и допущение подписаны раздельно. Расхождения с roadmap/T-6 (D02A UI-сценарий, GPT-6 gate, 1366×768) — явное решение пользователя, зафиксированное в traceability matrix как `out of scope` с объяснением.
Status: accepted-by-user
Direction: on-track
Consequence: task.md требует W3–W10; W1/W2 и spike W3 выполнены read-only research.

## Evidence, на котором стоит план

- [data-note](artifacts/data-note.md): поля эмулятора и CSV совпадают по координатам/скорости/курсу/валидности; время ставит эмулятор; `unit_id↔tr_id` 1:1; маршрута выше `tr_id` нет; модель прогнозирует первую плановую остановку в (T+10, T+15] мин (в среднем ~6 остановок впереди); окно 06:30–08:30.
- [emulator-spike](artifacts/emulator-spike.md): повторный `POST /api/config` стабилен при P ≥ 1 с для 12 ТС (327 POST, 0 ошибок); каждый POST переподключает все ТС (~4 мс); `timestamp` — секунда wall, не управляется; честный коэффициент ×5 при P=2 с (~70 % точек), ×10 при P=1 с без запаса.
- [code-recon](artifacts/code-recon.md): ускорения в Backend нет (`ClockMapping` 1:1, origin при импорте, 03:20 зашит); reset только recreate; target coords не отдаются; прогнозы ставятся только внутри `/v1/vehicles`; сценарий связан с ~30 местами `app.js`.
- [requirements-traceability](artifacts/requirements-traceability.md): baseline 148 требований; главные пробелы совпадают с W3–W9.

## Ключевые развилки и выбор

### Где живёт ускорение
Варианты: (a) только драйвер ускоряет подачу; (b) rate в `ClockMapping` Backend + драйвер по тому же mapping; (c) общая env-переменная для обоих без регистрации.
Выбор (b) через регистрацию прогона: эмулятор ставит wall-время, поэтому без rate в Backend задержки против `schedule_plan` ложны (a отвергнут). (c) не решает рассинхрон старта: origin Backend фиксируется при импорте, драйвер стартует позже. Регистрация задаёт origin в момент старта прогона и одновременно даёт canonical run ID, защиту от второго драйвера и path-manifest.

### Кто владеет run ID и сбросом
Backend: всё состояние in-process, `Schedule` не допускает часов назад, поэтому «один прогон на процесс» и сброс через recreate — самый простой честный вариант. Endpoint сброса отвергнут: пришлось бы пересоздавать `Schedule/TelemetryState/Orchestrator` в процессе — это больше кода без пользы для демо. Пользователь сам предложил перезапуск через compose.

### Откуда «путь прогона»
Варианты: Backend читает `traffic.csv`; драйвер передаёт manifest при регистрации. Выбор — manifest: Backend не должен знать будущие строки для модели; manifest — display-only, хранится отдельно от входов модели и так подписан.

### Повтор или удаление ТС без новой точки
Удаление из конфига закрывает TCP → `disconnected` в UI; `cells: []` → валидная [0,0]. Повтор последней точки — наименьшее зло; детектор остановок считает только первое наблюдение планового прибытия, доля повторов в trace.

### Скорость по умолчанию
Пользователь: работать с родным темпом эмулятора, при необходимости замедлять, настройка. Раньше выбирал ×30, но spike показал, что при ×30 теряется 68–84 % точек. Default ×5 (P=2 с), настраивается `DEMO_SPEEDUP`; показ окна 2 ч ≈ 24 мин. Это соответствует поправке «можно медленнее, потом подтюнить».

### Отображение прогноза
Решение пользователя (AskUserQuestion 2026-09-27): факт до цели, модель на цели, после цели — тот же сдвиг как переключаемое допущение.

### Как делить работу между agents
Write sets не пересекаются (A runtime / B UI / C docs / D QA); контракт API зафиксирован в Result examples, поэтому A и B могут идти параллельно, B — на fixture до готовности A. Commits — только coordinator.

## Pressure pass

- Минимальный полезный slice: W3 + W5-A + W4 + W5-B + W6 — демо уже работает без W7/W8/W9. W7 (визуал) и W9 (docs) — следующие независимые слои, но пользователь просил их в этой задаче, поэтому остаются в scope с отдельными commits.
- Риск: amd64-эмулятор на arm64 стартует медленно → драйвер ждёт готовности `GET /api/config` с таймаутом и понятной ошибкой.
- Риск: 16 ТС при P=2 с — spike мерил 12; драйвер пишет в trace латентность POST; при деградации — P=3 с.
- Риск: clock skew эмулятор↔Backend (`future simulation event`) — в одной VM ниже; счётчик `errors_state` выводится в diagnostics.
- Риск: консюмер last-good после recreate — consumer тоже пересоздаётся; при частичном рестарте UI видит старый `run_id` с `offline`, это честно.

## Round-1 review repair (T7-plan-r1 → revise)

Все находки приняты; изменения внесены в task.md Decisions/Work items/Verification.

- PR-001 [high] — accepted. Владелец — статус строки ТС в Backend: прогноз той же цели младше `predict_interval_s` остаётся `normal` + `prediction_updating`; live-проверка 5 мин (≥80 % опросов normal, событие не мигает).
- PR-002 [high] — accepted. Драйвер упорядочивает по `event_time`, монотонно на ТС, пропускает `is_hist_data` и немонотонные строки; задержка доставки эмулятором не воспроизводима — это ограничение фиксируется в docs.
- PR-003 [high] — accepted. Окно остановок по времени до цель + 15 мин, до 40, цель всегда включена, роль `passed`; подписи только у цели и ближайшей будущей.
- PR-004 [medium] — accepted. Повтор ≤ `DEMO_REPEAT_MAX_S=30` с данных, дальше ТС выводится из конфига → честный stale.
- PR-005 [medium] — accepted. `RECONNECT_GRACE_S=3` в `TelemetryState`; проверка 0 `disconnected` у активных ТС.
- PR-006 [medium] — accepted. Единый владелец `RunRegistry` в `transport_backend/run.py`; поведение до регистрации и общий lock описаны.
- PR-007 [medium] — accepted. Route читает последнюю посчитанную строку ТС, отдаёт `vehicle_revision`.
- PR-008 [medium] — accepted. Второй прогон ×10/P=1 с проверкой rate часов.
- PR-009 [medium] — accepted. M1-путь на живых данных в Verification.
- PR-010 [medium] — accepted. `pull_policy: never`, порт эмулятора только на 127.0.0.1.
- PR-011..014 [low] — accepted: `docs/api` только A; `start_ndtp_simulation.py` удаляется; `thinned_ratio` всегда в diagnostics; `SOURCE_COMMIT` через `git describe --dirty`.
- Остаточные риски: нагрузка ML при 16 ТС (измеряется в W6); 16 ТС vs 12 в spike (латентность POST в trace, при деградации P=3 с).

## Round-2 review repair (T7-plan-r2 → revise)

- PR-015 [medium] — accepted. Смена цели → немедленный новый прогноз; `PREDICTION_FRESH_S = 1.5 × predict_interval_s`; `pending` после смены цели честно `degraded` без переноса старого значения; устойчивость событий принадлежит `incidents.js` (`LOST_AFTER_S=15` с wall непрерывного `nodata`); проверки в JS-тестах и live-истории событий.
- PR-016 [medium] — accepted. Verification приведён к Decisions (≤40, цель всегда включена, роли).
- PR-017 [low] — accepted. `replay_ndtp.py` не меняется; у драйвера свой загрузчик по `event_time` с `is_hist_data`.
- PR-018 [low] — accepted. `docs/api/**` только agent A; проверка отсутствующего образа через `EMULATOR_IMAGE`.

Лимит раундов профиля `standard` исчерпан. Решение coordinator: узкий round-3 review только этих четырёх изменений тем же независимым reviewer; при несогласии CLI с round 3 — вопрос пользователю.
