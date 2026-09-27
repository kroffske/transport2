---
schema: task.v3
id: T-8
title: "Пакет сдачи формы и долговечные доказательства C1/C3"
status: planning
review_required: human
plan_review_profile: light
plan_review_gate: required
type: feature
priority: p0
owner: claude
created_at: "2026-09-27T14:29:03.176Z"
updated_at: "2026-09-27T14:39:49.652Z"
parent: null
depends_on: []
gstack_refs: {}
goal_contract: v1
stream: T
---
# T-8: Пакет сдачи формы и долговечные доказательства C1/C3

## Outcome

Primary goal: К 22:30 MSK 27.09 в репозитории (dev и main на origin) лежит рабочий код, с которого по README поднимается стек из чистого clone, если положить внешние файлы по путям и SHA-256 из README. Рядом, в `docs/submission-form.md`, лежат готовые тексты всех полей формы «Загрузка решения», C1-подтверждение и актуальный PyDoc. Куда хостить репозиторий и файлы и когда отправлять форму (до 23:59 MSK), решает пользователь.
Direction: on-track
Comment: решение пользователя от 18:00 MSK: «нужен рабочий код закомиченный в репо, дальше я сам разберусь куда и как его залить». Поэтому T-8 не занимается хостингом, публичными ссылками и Release. Цель — проверяемый коммит, README и текст формы. Критерии C1/C3 — [score-plan](../T-7-2026-09-27-ml/artifacts/score-plan.md) §0, §2.

### Result examples

Фрагмент README для T-7 W9 (§«Быстрый путь для жюри», вместо строки «Один раз подготовить…»). Значения SHA реальные, сняты 2026-09-27 17:40 MSK:

```text
Внешние файлы (не в Git). Положить по путям от корня репозитория и проверить `shasum -a 256 -c`:
| путь | байт | sha256 | источник |
| .local/validate-tuning-2026-09-26/final_model.json   | 6436      | 20e62a674136be954d4e6ef82ac8e6e65848efa5e434dd5423ea181424633d10 | модель команды |
| .local/validate-tuning-2026-09-26/final_model.cbm    | 11084152  | dc33437108c3e036089450c9b98771dacd014246fbb91d0df2a89d0c8e247122 | модель команды |
| .local/validate-tuning-2026-09-26/vehicle_origins.csv| 988       | cb5d80f1546a793494c80e108642418d330d675ddf616ec9f56815206eb1f3f8 | модель команды |
| consumer/map/moscow.pmtiles                          | 23982185  | 9c9f4964471fba5d5c4b2b9f65354d0766035231486c384a3af13a49420da4c6 | Protomaps extract, см. consumer/map/manifest.json |
| data/validate/traffic.csv                            | 17117773  | 3c74bb9d3cc5e076a2e7f89de7e78fb103c350757d16c9d629de651ee09bf517 | официальная раздача |
| data/validate/schedule_plan.csv                      | 683160    | c9b561743a5cb83616941b02b47c5aded89e75218d93c13a282a2e8c790787c8 | официальная раздача |
| data/emulator/ndtp-telemetry-emulator.tar            | 134284800 | 89399e531f20a508554441f1491be5676a524fa14c05f6e10e48fd22d849a199 | официальная раздача |
Для ML-сервиса достаточно этих трёх файлов модели. Остальное содержимое каталога — evidence обучения, запуску оно не нужно.
```

`docs/submission-form.md` (коммитится; значения иллюстративны):

```text
commit: <final_commit 40-hex>   (/api/build.source_commit на чистом clone = этот commit, без -dirty)
Репозиторий: <REPO_URL — выбирает пользователь>; ниже пути от корня на <final_commit>
1. Система (Docker, README): README.md §Быстрый путь для жюри; compose.yaml; внешние файлы — таблица SHA в README
2. Инструкция для жюри: README.md §Быстрый путь для жюри; docs/runbooks/local-demo.md
3. PyDoc: docs/pydoc/index.html. OpenAPI: docs/api/openapi.json (ML), docs/api/backend-openapi.json, docs/api/consumer-openapi.json.
   Swagger — после запуска по README: http://localhost:8000/docs, :8001/docs, :8002/docs
4. Производительность: <T-10 P50/P95/P99, cold start, recovery на final_commit> | или «сборка T-4, 11 ТС» с явной подписью
5. Доп. возможности: официальный эмулятор + ускорение, маршрут наряда и off_route, heading, build identity, …
C1: score платформы 1,0 — подтверждение пользователя 2026-09-27 17:45 MSK; submission.csv sha256 4c324401d397c0720887c9b5a2b2d0fb931c791df70935e6cea4e670cee7b0ce @ <final_commit>
```

Неудачный путь. Если путь из формы отсутствует в `git ls-tree -r <final_commit>`, поле помечается `BROKEN` и уходит координатору. Если к 22:00 чистый clone не прошёл, форма всё равно финализируется в 22:30 на последнем запушенном commit, а в `docs/submission-form.md` стоит пометка «чистый clone не проверен: <причина>».

## Decisions

- Решение пользователя от 18:00 MSK отменяет из review r1 PR-001, PR-002 (Release), PR-005 (публичные ссылки) и PR-006. Release, публичные ссылки, анонимная проверка `curl`, secret-scan истории и выбор видимости репозитория в T-8 не входят. Хостинг репозитория и файлов — забота пользователя.
- Все материалы для формы коммитятся в tracked-файлы: `docs/submission-form.md` и `docs/pydoc/**`. `git add -f` для `.tasks/**/artifacts/` не нужен, C1 входит в `docs/submission-form.md`.
- C1 = заявление пользователя «платформа показывает 1,0» (заметка от 17:45) плюс SHA-256 `submission.csv` в commit. Скриншот не нужен. Предложение поднять C1 в scorecard не передаётся: источник — заявление пользователя, а не файл.
- Внешние файлы — ровно те, что читает запуск. ML читает `MODEL_DIR` (`compose.yaml:8`), и `FinalModel` открывает только `final_model.json`, `final_model.cbm` и `vehicle_origins.csv` (`transport_ml/final_model.py:33-46`). PMTiles попадает в образ через `COPY consumer` (`Dockerfile`), поэтому файл должен лежать на `consumer/map/moscow.pmtiles` до `--build`. Backend и driver читают `data/validate/*` через `DATA_DIR`. Эмулятор ставится через `docker load` из tar. Полный каталог модели (78 МБ evidence) не требуется.
- README принадлежит T-7 W9. T-8 передаёт фрагмент с таблицей SHA до 19:00. Если к 21:00 фрагмента нет в запушенном README, T-8 вносит его сам: это правка только документации, без product code.
- PyDoc (PR-004, простой вариант) генерируется до финального commit и входит в него. Одна точка идентичности — `final_commit`: `/api/build`, ссылки формы и PyDoc указывают на него. Более поздние commit допустимы, только если `git diff --name-only <final_commit>..origin/dev` затрагивает лишь `.tasks/**`.
- Команда PyDoc (PR-007):
  `cd docs/pydoc && PYTHONPATH=../.. ../../.venv/bin/python -m pydoc -w transport_ml.final_model transport_ml.service transport_ml.data transport_ml.features transport_backend.service transport_backend.orchestration transport_backend.run transport_backend.ingest transport_backend.ndtp transport_backend.schedule transport_backend.state consumer.service`.
  Затем `index.html` получает ссылки на сгенерированные файлы. Абсолютные пути host вырезаются так: `sed -i '' "s#$(cd ../.. && pwd)/##g" *.html`. Старые snapshot-файлы (`inference`, `neural`, `validation`) удаляются: `index.html` их не описывает, и на них нельзя ссылаться как на актуальные.
- `SOURCE_COMMIT` в README берётся из `git describe --dirty`. Изменённые tracked-файлы `.tasks/**` в рабочем checkout дают `-dirty`. Поэтому build identity для формы снимается со стека, собранного из чистого clone (W5), а не из рабочего дерева.
- Commit и push в dev и main выполняет координатор по указанию пользователя от 18:00. T-8 сам не коммитит и не пушит.
- Срок (PR-003). W1–W3 — сейчас. Полный черновик формы — к 21:00. Финальный текст на последнем запушенном commit — к 22:30. W5 не ждёт T-10 и T-7 W10: он идёт в первое окно эксклюзивного стека после push финального product commit. Если к 22:00 W5 не прошёл, это пометка в форме, а не блокер. Perf берётся из T-10, если тот готов к 22:30; иначе из T-4 QA с подписью «сборка T-4, 11 ТС».

## Boundary

- **Included:** таблица внешних файлов с SHA для README (передача в T-7 W9, запасной путь — правка самим T-8); `docs/submission-form.md` со всеми полями и C1; `docs/pydoc/**`; проверка чистого clone; проверка, что `final_commit` запушен в origin/dev и origin/main.
- **Excluded:** GitHub Release и любая публикация или хостинг файлов; видимость репозитория и доступ жюри; анонимная проверка ссылок; secret-scan истории; отправка формы; commit и push (их делает координатор); правки product code, dashboard, compose, Dockerfile; `docs/prd/evaluation-scorecard.md`; новый ML-score; benchmark (T-10); lead time (T-9); презентация (с формой не загружается).

## Work items

- [ ] W1: C1 в форме (сейчас, до 18:30).
  - Deliverable: блок C1 в `docs/submission-form.md`: «1,0 — подтверждение пользователя 2026-09-27 17:45 MSK» и `sha256 submission.csv` на `final_commit`.
  - Contribution: C1 проверяем в самом репозитории, без файлов вне Git.
  - Proxy result: «score 1,0» без SHA или SHA рабочего дерева вместо commit.
- [ ] W2: Таблица внешних файлов для README (сейчас, передать в T-7 W9 до 19:00).
  - Deliverable: фрагмент README по образцу из Result examples: 7 строк — путь, байты, SHA-256, источник — плюс фраза о трёх файлах модели. Если к 21:00 фрагмента нет в запушенном README, T-8 вносит его сам.
  - Contribution: пользователь знает, какие файлы и куда хостить, а жюри может проверить их по SHA (C3).
  - Proxy result: путь к каталогу модели целиком без списка файлов; таблица без SHA; SHA, снятые не с тех файлов, что использует стек.
- [ ] W3: Актуальный PyDoc (черновик сейчас, повторная генерация на финальном коде до финального commit).
  - Deliverable: `docs/pydoc/*.html` по команде из Decisions и `index.html` со ссылками на все файлы; без абсолютных путей host; без устаревших snapshot-файлов.
  - Contribution: закрывает обязательный артефакт №4 (C3).
  - Proxy result: старые snapshot-файлы только `transport_ml`; HTML со ссылками `file:/Users/...`.
- [ ] W4: Текст формы (полный черновик к 21:00, финал к 22:30).
  - Deliverable: `docs/submission-form.md` — 5 полей и C1, пути от корня репозитория, строка `commit: <final_commit>`, OpenAPI как файлы в `docs/api/`, Swagger с подписью «после запуска по README».
  - Contribution: пользователь копирует текст и отправляет форму, подставив свой URL репозитория.
  - Proxy result: плейсхолдеры кроме `<REPO_URL>` в финале; числа perf без указания сборки; ссылки на localhost как единственный способ открыть OpenAPI.
- [ ] W5: Проверка чистого clone (первое окно эксклюзивного стека после push финального product commit; не ждёт T-10).
  - Deliverable: `artifacts/clean-clone.md`. В нём: `git clone` origin во временный каталог на `final_commit`; копирование внешних файлов по таблице README с `shasum -a 256 -c`; запуск команды из README; readback `docker compose ps`, `/api/build`, `snapshot.run.state`. После проверки основной стек поднимается снова командой из README.
  - Contribution: доказывает, что закоммиченный код поднимается по одной инструкции (C3).
  - Proxy result: проверка в рабочем checkout; `source_commit` с `-dirty`; модель смонтирована из исходного `.local/` вместо копии в clone.

## Verification

- W1: `git show <final_commit>:submission.csv | shasum -a 256` = `4c324401d397c0720887c9b5a2b2d0fb931c791df70935e6cea4e670cee7b0ce` = значение в `docs/submission-form.md`. Источник 1,0 назван как «подтверждение пользователя» с датой.
- W2: для каждой строки таблицы в README `shasum -a 256 <path>` и `stat -f %z <path>` совпадают. Достаточность модели: скопировать только 3 файла модели в пустой каталог `$D`, затем `PYTHONPATH=. .venv/bin/python -c "from transport_ml.final_model import FinalModel; FinalModel('$D')"` → без исключения. Неудачный путь: без `vehicle_origins.csv` → `ArtifactUnavailable`.
- W3: `ls docs/pydoc` содержит 12 HTML-файлов из команды и `index.html`. `grep -l '/Users/' docs/pydoc/*.html` пусто. На `final_commit` повторная генерация даёт `git status --porcelain docs/pydoc` пусто.
- W4: каждый путь из формы есть в `git ls-tree -r --name-only <final_commit>`. В финале `grep -nE '<[a-z_]+>' docs/submission-form.md` находит только `<REPO_URL>`. `git branch -r --contains <final_commit>` выводит `origin/dev` и `origin/main`. `git diff --name-only <final_commit>..origin/dev | grep -v '^\.tasks/'` пусто.
- W5: в clone `git rev-parse HEAD` = `final_commit`; `shasum -a 256 -c` по таблице README → все OK; команда из README → `docker compose ps` все сервисы healthy; `curl -s :8002/api/build` → `source_commit` = `final_commit` без `-dirty`; не позже чем через 2 мин `snapshot.run.state=running`; `curl -sf -o /dev/null http://localhost:{8000,8001,8002}/docs` → 200 для каждого. Неудачный путь: если без `consumer/map/moscow.pmtiles` или без модели результат расходится с README troubleshooting, это finding.
- Приёмка: пользователь подтверждает, что текст формы готов к отправке (review `human`).

## Execution log

## Closure
