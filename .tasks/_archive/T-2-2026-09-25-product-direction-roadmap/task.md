---
schema: task.v3
id: T-2
title: "Оформить product direction, критерии и roadmap"
status: done
review_required: none
plan_review_profile: none
plan_review_gate: none
type: feature
priority: p2
owner: manager
created_at: "2026-09-25T19:26:18.251Z"
updated_at: "2026-09-25T19:49:29.178Z"
parent: null
depends_on: []
gstack_refs: {}
goal_contract: v1
stream: T
workflow: feature
---

# T-2: Оформить product direction, критерии и roadmap

## Outcome

Primary goal: Сделать официальные требования задачи, критерии успеха и порядок работ читаемой Locus-системой: канонический Markdown, `soul.md`, near-term goal, roadmap и готовые задачи для ML и системного контура.

Direction: on-track

Проект получает единую стратегическую опору: официальный PDF остаётся источником, Markdown становится рабочим представлением, а задачи и roadmap ссылаются на измеримые критерии вместо пересказа по памяти.

## Goal alignment

Direction: on-track

Пользователь явно поручил оформить оставшуюся документацию, создать `soul.md`, roadmap и отдельные задачи для модели и системных компонентов. Это owner intake для направления текущего проекта.

## Decisions

- Полное рабочее изложение официального PDF живёт в `docs/prd/transport-delay-predictor.md`; исходный PDF сохраняется рядом как неизменяемый источник.
- Операционная таблица критериев живёт отдельно в `docs/prd/evaluation-scorecard.md`: она связывает максимум баллов, требуемое доказательство, текущую подтверждённую оценку и owning task.
- `.locus/soul.md` описывает долговременную миссию и ловушки, но не дублирует весь PRD; он ссылается на scorecard.
- `.locus/goal.md` фиксирует ближайшую цель: сначала получить честный воспроизводимый ML-результат на полном датасете.
- `.locus/roadmap.md` разводит документацию, ML и системный контур по отдельным этапам и задачам.
- Astra выполняет read-only adversarial review уже подготовленного комплекта; решения и правки остаются у текущего владельца.

## Boundary

### Included

- **Product documentation** — полный Markdown официальной постановки, отдельный scorecard и навигация.
- **Project direction** — `.locus/soul.md`, `.locus/goal.md`, `.locus/roadmap.md`.
- **Execution portfolio** — планируемая ML-задача с дочерними срезами и отдельная задача системного контура.
- **Independent review** — review Astra с исходным PDF, Markdown, soul, roadmap и task contracts.

### Excluded

- **ML execution** — EDA, обучение, подбор модели и создание submission не выполняются в T-2.
- **System implementation** — Backend, dashboard, Docker/infra и NDTP-интеграция не реализуются в T-2.
- **External actions** — загрузка сабмита, публикация, push, pull request и merge не разрешены.

## Work items

- [x] W1: Переписать официальный PDF в канонический Markdown
  - Deliverable: `docs/prd/transport-delay-predictor.md` покрывает все материальные разделы, требования, лимиты, обязательные артефакты и pitch-критерии исходного PDF.
  - Contribution: Astra, агенты и люди могут читать требования как текстовый source-of-truth.
  - Proxy result: краткое резюме без деталей критериев или условий сдачи.
- [x] W2: Создать критерий-ориентированную стратегию
  - Deliverable: `docs/prd/evaluation-scorecard.md`, `.locus/soul.md`, `.locus/goal.md` и `.locus/roadmap.md` связывают миссию, баллы, доказательства и этапы.
  - Contribution: приоритеты можно проверять по официальной оценке и реальной готовности.
  - Proxy result: общий roadmap без баллов, доказательств или стратегических ловушек.
- [x] W3: Создать следующие задачи и структуру исполнения
  - Deliverable: отдельная ML-задача с дочерними срезами для аудита, baseline, моделирования и оценки; отдельная системная задача для Backend/NDTP, dashboard и Docker/infra.
  - Contribution: документация сразу превращается в исполнимый портфель, а не остаётся статичной.
  - Proxy result: один монолитный task «сделать всё» без владельцев и проверяемых срезов.
- [x] W4: Провести независимый review Astra
  - Deliverable: task-local review проверяет полноту переноса PDF, соответствие soul/roadmap критериям и исполнимость ML-плана; применимые замечания reconciled владельцем.
  - Contribution: снижает риск оптимизации под неверный proxy или пропуска обязательного требования.
  - Proxy result: общий отзыв без ссылок на конкретные файлы и критерии.
- [x] W5: Проверить документационный и task-контракты
  - Deliverable: `locus docs lint --strict` и task lint проходят, ссылки разрешаются, суммы баллов составляют 26 за основной этап и 36 с pitch.
  - Contribution: подтверждает структурную целостность нового source-of-truth.
  - Proxy result: документы выглядят завершёнными, но не проходят Locus-валидацию.

## Verification

- Покрытие PDF -> сопоставить шесть страниц с заголовками и таблицами PRD -> все материальные разделы присутствуют, числовые пороги и лимиты совпадают.
- Scorecard -> проверить арифметику и ownership -> максимум основного этапа 26, pitch 10, общий максимум 36; каждый критерий связан с доказательством и задачей.
- Strategy -> проверить soul contract -> присутствуют identity, why, strategic outcome, traps, principles, durable rules, decision slugs и direction log; scorecard связан ссылкой, а не скопирован целиком.
- Portfolio -> `locus task state` для новых задач -> ML и system задачи имеют непустые Outcome, Boundary, Work items и Verification; ML children сохраняют parent goal/contribution/proxy result.
- Independent challenge -> Astra review содержит verdict, file-cited findings, обязательные правки и residual questions; владелец проверяет каждую применённую правку по источнику.
- Documentation -> `locus docs lint --strict` -> 0 ошибок и предупреждений.

## Execution log

- 2026-09-25: официальный PDF переписан в source-faithful PRD; score thresholds, лимиты, пять обязательных артефактов и pitch сохранены.
- 2026-09-25: созданы soul, near-term goal и criteria-driven roadmap.
- 2026-09-25: созданы T-3 с четырьмя full subtasks и draft T-4.
- 2026-09-25: Astra review `artifacts/astra-review.md` вернул `revise`; четыре required edits проверены по источникам и применены владельцем.
- 2026-09-25: `locus docs lint --strict` и task lint T-2/T-3/T-3 children/T-4 прошли без ошибок и предупреждений; арифметика scorecard подтверждена как 26 + 10 = 36.

## Closure

Официальный PDF получил полное рабочее Markdown-представление и отдельный доказательственный scorecard. Созданы `soul.md`, near-term goal и roadmap. T-3 запланирован с последовательными full subtasks для data audit, baseline, modeling и evaluation; T-4 оставлен draft до фиксации model contract. Astra проверила все шесть страниц PDF и портфель, после чего исправлены exposed `labels_test`, контракт C2, порядок submission и владельцы обязательной документации. Внешние загрузки, публикация и реализация ML/system компонентов не выполнялись.
