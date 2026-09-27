---
schema: task.v3
id: T-10
title: "Benchmark производительности и восстановления финальной сборки (C5)"
status: planning
review_required: none
plan_review_profile: light
plan_review_gate: required
type: feature
priority: p1
owner: claude
created_at: "2026-09-27T14:29:39.311Z"
updated_at: "2026-09-27T14:29:39.311Z"
parent: null
depends_on: [T-7]
gstack_refs: {}
goal_contract: v1
stream: T
---
# T-10: Benchmark производительности и восстановления финальной сборки (C5)

## Outcome

Primary goal: Для финальной сборки T-7 (официальный эмулятор → Backend → ML → consumer → UI, 16 ТС, ×5) есть свежая таблица производительности и восстановления с сырыми данными: задержки P50/P95/P99, очереди и drops, timed cold start, ML outage → recovery и поведение при рестарте Backend. Таблица подписана build identity и готова для формы (T-8) и pitch.
Direction: on-track
Comment: C5 сейчас 2–3/4: числа T-4 относятся к 11-ТС replay, трём сервисам и commit `036f589`. soul — end-to-end-proof и «не заявлять надёжность без readback». Обоснование — [score-plan](../T-7-2026-09-27-ml/artifacts/score-plan.md) §2 C5.

### Result examples

`artifacts/perf-final.md` (значения иллюстративны):

```text
Сборка: source_commit=<40-hex>, dashboard_bundle_sha256=<hex>; хост Apple M5 Pro, Docker VM <vCPU/RAM>
Прогон run-…: 16 ТС, ×5, DEMO_POST_PERIOD_S=2, 10 мин wall

| Интервал (wall)                                        | N    | P50    | P95    | P99    |
| POST драйвера → кадр ТС виден в /api/snapshot         | 4 700| 1,2 с  | 2,1 с  | 2,4 с  |
| кадр принят Backend → новый прогноз в /api/snapshot   |  310 | 160 мс | 610 мс | 1,2 с  |
| ML request latency (Backend counters)                  |  310 | …      | …      | …      |
Очередь прогнозов: max depth …, prediction_queue_full = 0, rejected_* = …
Cold start (down → все healthy → run.state=running → первый прогноз), 3 повтора: … / … / … с
ML stop 60 с → ml_unreachable_or_timeout у N ТС → start → первый новый прогноз через … с
Backend restart → run_id потерян (RunRegistry в памяти), драйвер → failed; восстановление — команда recreate (… с)
```

Неудачный путь: если стек не становится healthy или появляются drops, это записывается как finding с сырыми логами, без «исправлений на лету».

## Decisions

- Измерение идёт только на сборке, которую приняла или принимает T-7 W10 (тот же `source_commit`). Стек используется эксклюзивно: не во время W10 QA, не во время чистого clone T-8 и не во время показа. Порядок согласует координатор (score-plan §5 п.5).
- Метод — как у T-4 (отправка → наблюдение в consumer API), но от POST драйвера, потому что время NDTP ставит эмулятор. Источники: trace драйвера (wall-время POST), опрос `/api/snapshot` с шагом ≤250 мс (кадр — по изменению позиции или revision ТС, прогноз — по `prediction_input_frame_id`), счётчики Backend из `/ready`. Каждый интервал явно определён в отчёте.
- Переиспользовать readback T-7: live 5 мин (ML latency и queue drops) и ML stop/start из W6. T-10 добавляет percentiles, cold start ×3 и рестарт Backend, не повторяя W6 ради повтора.
- Скрипт замера и сырые данные — в `artifacts/bench/` задачи. Product code, compose и тесты не меняются. Контейнерные действия — только со стеком проекта (`docker compose` из корня репозитория). `docker pause` не используется.
- Потеря `RunRegistry` при рестарте Backend — известное ограничение. Оно фиксируется честно и не чинится здесь.

## Boundary

- **Included:** замеры задержек, очередей, cold start, ML outage/recovery и Backend restart на финальной сборке; таблица и сырые данные; строки для T-8 и предложения scorecard C5.
- **Excluded:** оптимизация производительности; персистентность `RunRegistry`; нагрузка сверх 16 ТС и ×10 (опционально — отдельной строкой, если останется время); изменение кода.

## Work items

- [ ] W1: Задержки и очереди на 10-мин прогоне ×5.
  - Deliverable: `artifacts/bench/latency-*.jsonl` и таблица P50/P95/P99 с N в `artifacts/perf-final.md`.
  - Contribution: свежий ответ на «latency < 1–2 с» для текущей системы.
  - Proxy result: числа T-4 с новой датой; среднее без percentiles.
- [ ] W2: Timed cold start ×3.
  - Deliverable: времена `down → healthy → running → первый прогноз` для каждого повтора.
  - Contribution: «холодный старт предсказуем» с разбросом.
  - Proxy result: один замер или «до healthy» без первого прогноза.
- [ ] W3: ML outage и Backend restart.
  - Deliverable: ML stop 60 с → причина в snapshot → start → время до нового прогноза; Backend restart → наблюдаемое поведение драйвера и UI и способ восстановления.
  - Contribution: failure-path evidence C5 на нынешних 5 сервисах.
  - Proxy result: ссылка только на T-4 или W6 без нового замера restart.
- [ ] W4: Итог.
  - Deliverable: `artifacts/perf-final.md` — build identity, хост, таблица, ограничения, 3 строки для формы T-8 и предложение для C5 в scorecard.
  - Contribution: C5 → 3–4 с проверяемым источником.
  - Proxy result: таблица без build identity.

## Verification

- `curl -s :8002/api/build` в начале и конце замера совпадает с `source_commit` в отчёте и с финальным commit T-7.
- Percentiles воспроизводятся: пересчёт из `artifacts/bench/*.jsonl` скриптом из `artifacts/bench/` даёт те же числа (координатор повторяет расчёт).
- Cold start: 3 строки с временами и логами `docker compose ps`.
- ML outage: в снимке во время остановки у ТС причина `ml_unreachable_or_timeout` и статус не `normal`; после start — новый `prediction_input_frame_id`.
- Неудачный путь: drops или падения записаны сырыми логами и отмечены в отчёте, числа не отфильтрованы.
- Приёмка: прямое доказательство — сырые данные и пересчёт (review `none`); claim для scorecard проходит через владельца doc stream.

## Execution log

## Closure
