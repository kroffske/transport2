---
schema: task.v3
id: T-9
title: "Раннее предупреждение: onset → первый алерт → lead time (C2)"
status: planning
review_required: qa
plan_review_profile: standard
plan_review_gate: required
type: research
priority: p1
owner: claude
created_at: "2026-09-27T14:29:39.166Z"
updated_at: "2026-09-27T14:29:39.166Z"
parent: null
depends_on: []
gstack_refs: {}
goal_contract: v1
stream: T
---
# T-9: Раннее предупреждение: onset → первый алерт → lead time (C2)

## Outcome

Primary goal: Получить измеренный и честно подписанный ответ на вопрос C2: за сколько минут до наблюдаемого начала инцидента Backend выдаёт первый алерт на потоке. Нужны таблица инцидентов `onset_at → first alert → lead time`, отдельный счёт post-event и лишних алертов и итог в 5 строк для README, формы и pitch. Результат «lead time ≈ 0 / не достигнуто» тоже принимается.
Direction: on-track
Comment: soul — «Would kill it: хороший офлайн MAE без раннего предупреждения»; scorecard, правило 3: C2 требует наблюдаемого onset и фактического упреждения. Сейчас C2 = 0/4, потенциал 1–2. Обоснование — [score-plan](../T-7-2026-09-27-ml/artifacts/score-plan.md) §2 C2.

### Result examples

`artifacts/lead-time.md` (значения иллюстративны):

```text
Окно: <день, интервал>, replay → Backend (алгоритм алерта без изменений) → модель <model_version/sha>
Разметка onset: time_fact_begin (только разметка, не вход). Пометка: день обучения модели → in-sample.
Инцидентов (new, onset по определению D1): 23; known-delay эпизодов: 41
С алертом до onset: 9/23; lead ≥10 мин: 4/23; медиана lead 6 мин 10 с (IQR …)
Post-event алертов (первый алерт после onset): 7; алертов без инцидента в [цель ± 15 мин]: 12 из 38
По kind: new_signal …, known_prior_delay …
Вывод для README: «Раннее предупреждение измерено на одном окне: …; это не доказательство на новых данных».
```

`artifacts/lead-time-incidents.csv`: `tr_id, onset_stop_id, plan_time, fact_time, onset_at, first_alert_at, alert_kind, lead_s, category(early|late|missed)`.

Неудачный путь: если без изменения Backend нельзя проиграть окно с фактами (W1), результат — «офлайн-оценка по point-in-time прогнозам» с явной подписью. C2 в scorecard при этом не повышается (правило 3).

## Decisions

- **D1. Определение инцидента фиксируется до прогона.** Задержка остановки `delay_i = time_fact_begin_i − time_begin_i`. Новый инцидент — первая остановка `i` наряда `tr_id` с `delay_i > 120 с` (тот же порог, что `_consider_alert`, `orchestration.py:634`), если две предыдущие наблюдаемые остановки имели `delay ≤ 120 с`. `onset_at = time_begin_i + 120 с` — самый ранний момент, когда задержка наблюдаема. Иначе это known-delay эпизод, который считается отдельно и в «раннее предупреждение» не входит. Изменение определения допускается только с записанной причиной до просмотра результатов.
- **D2. Сопоставление.** Для инцидента берётся первый алерт того же `tr_id` с `emitted_at ∈ [onset_at − 20 мин, onset_at + 15 мин]` (время данных). `lead_s = onset_at − emitted_at`: `>0` — early, `≤0` — late (post-event), алерта нет — missed. Лишний алерт — алерт, после которого в `[target_time − 15 мин, target_time + 15 мин]` нет инцидента или known-delay.
- **D3. Факт — только разметка.** `time_fact_begin` не попадает во вход Backend или ML и в UI. Replay подаёт только телеметрию (point-in-time).
- **D4. Источник алертов — Backend.** Алгоритм не меняется. Расхождение с правилами UI-событий (`dashboard/incidents.js`, 120/300 с) записывается как finding, не исправляется.
- **D5. Окно и прогон (W1 решает по evidence).** Нужно окно, где есть и телеметрия для replay, и факты: (a) train `traffic.csv` + `schedule.csv` (`time_fact_begin`); (b) validate + восстановленные в T-5 ответы. Выбирается вариант, который Backend `Schedule` загружает без правки кода. Replay — существующий `scripts/replay_ndtp.py` или `scripts/emulator_driver.py` с Backend в `SOURCE_CLOCK=simulation` и реальной моделью. День совпадает с днём обучения, поэтому все числа подписываются «in-sample, один день».
- **D6. Write set:** новый `scripts/eval_lead_time.py` (разметка onset, сбор алертов из опроса `/v1/vehicles` или записанных snapshot, сопоставление, метрики); новый `tests/test_eval_lead_time.py` (синтетические фикстуры D1/D2); task artifacts. Не трогать `transport_backend/**`, `dashboard/**`, `consumer/**`, существующие тесты (write set T-7 agent A), `data/**`.
- **D7. Time box:** к 22:00 MSK 27.09 — минимальный честный результат на одном окне для T-8 или запись «не измерено: <причина>». Продолжение после этого — для pitch.

## Boundary

- **Included:** разметка onset; прогон одного окна (второе — по времени); сопоставление и метрики; итог для README, формы и pitch; finding о расхождении правил UI и Backend.
- **Excluded:** изменение алгоритма алерта, порогов или модели; переобучение; показ `kind` в UI (отдельная задача после T-7); вероятность и причина; правка README и scorecard (передаётся владельцам).

## Work items

- [ ] W1: Spike источника окна (≤1 ч).
  - Deliverable: запись в `artifacts/lead-time.md` §Источник: какое окно, как запущен replay, доказательство, что Backend принял кадры и ставил прогнозы (счётчики и `model_version`).
  - Contribution: выбирает честный путь без правки Backend.
  - Proxy result: окно без фактов или replay со stub-моделью.
- [ ] W2: Разметка инцидентов по D1 с тестом.
  - Deliverable: `scripts/eval_lead_time.py` (часть onset) и `tests/test_eval_lead_time.py`: new vs known-delay, порог ровно 120 с, пропуск остановок без факта.
  - Contribution: независимая «истина» для lead time.
  - Proxy result: onset = момент первого алерта или по прогнозу модели.
- [ ] W3: Сбор алертов на потоке и сопоставление по D2.
  - Deliverable: сохранённые сырые алерты (JSONL) и `artifacts/lead-time-incidents.csv`.
  - Contribution: фактическое упреждение, а не офлайн-предсказания.
  - Proxy result: алерты, пересчитанные офлайн без Backend.
- [ ] W4: Отчёт и итог.
  - Deliverable: `artifacts/lead-time.md` — метрики, разбивка по `kind`, ограничения (in-sample, один день, ускорение и прореживание), 5-строчный вывод для README и pitch, finding UI ≠ Backend.
  - Contribution: даёт C2 измеренное основание и честный ответ жюри.
  - Proxy result: только медиана без missed и post-event.
- [ ] W5: Независимая проверка claim.
  - Deliverable: `qa.md` — отдельный агент пересчитывает метрики из сырых JSONL и CSV и проверяет D3 (факт не во входе).
  - Contribution: soul independent-review для scorecard claim.
  - Proxy result: самопроверка автора.

## Verification

- `.venv/bin/python -m pytest -q tests/test_eval_lead_time.py` проходит. Фикстура: 2 остановки ≤120 → третья 121 с → инцидент с `onset_at = plan + 120 с`; ряд, где уже 130 с, → known-delay; алерт после onset → `late`.
- D3: `rg -n "time_fact_begin" scripts/eval_lead_time.py` встречается только в функции разметки; в конфиге Backend и во входе replay его нет (объяснено в отчёте).
- Повторяемость: повторный запуск `scripts/eval_lead_time.py` на сохранённых сырых алертах даёт тот же CSV (`shasum`).
- Отчёт содержит число missed и post-event, подпись in-sample и `model_version`/`artifact_sha256`.
- Неудачный путь: если W1 не нашёл окна без правки Backend, `lead-time.md` явно говорит «офлайн-оценка» и T-8 получает «не измерено на потоке».
- Приёмка: `qa.md` ACCEPTED (review `qa`).

## Execution log

## Closure
