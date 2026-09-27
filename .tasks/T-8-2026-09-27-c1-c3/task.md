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
updated_at: "2026-09-27T14:29:03.176Z"
parent: null
depends_on: []
gstack_refs: {}
goal_contract: v1
stream: T
---
# T-8: Пакет сдачи формы и долговечные доказательства C1/C3

## Outcome

Primary goal: К 23:00 MSK 27.09 у пользователя есть проверенный локальный пакет для формы «Загрузка решения»: текст каждого поля с работающими ссылками, долговечное подтверждение C1 (score платформы + SHA файла), manifest внешних артефактов с SHA-256, актуальный PyDoc и проверка README с чистого clone на финальной сборке T-7. Пользователь отправляет форму сам.
Direction: on-track
Comment: soul — criteria-first и source-traceability. По PRD форма сохраняет последнюю версию, дедлайн 27.09, 23:59 MSK. Без неё C2–C5 могут остаться без оценки. Обоснование — [score-plan](../T-7-2026-09-27-ml/artifacts/score-plan.md) §0, §2 C1/C3.

### Result examples

`artifacts/c1-platform-readback/readback.md`:

```text
score_platform: 1,0 (Data Science, 2026-09-27 HH:MM MSK)
source: platform-result.png (sha256 <hex>)  | или «сообщение пользователя 2026-09-27», если скриншота нет
uploaded_file_sha256: 4c324401d397c0720887c9b5a2b2d0fb931c791df70935e6cea4e670cee7b0ce
repo_submission_sha256: 4c324401…b0ce  (shasum -a 256 submission.csv @ <commit>)
match: yes
```

`artifacts/submission-form.md` (поля формы; значения иллюстративны):

```text
1. Система (Docker, README): https://github.com/kroffske/transport2/tree/<40-hex> → README §Запуск
2. Инструкция для жюри: README §Инструкция для жюри / docs/runbooks/local-demo.md
3. PyDoc: docs/pydoc/index.html; OpenAPI: docs/api/backend-openapi.json, docs/api/consumer-openapi.json; Swagger :8000/docs, :8001/docs
4. Производительность: таблица T-10 (P50/P95/P99, cold start, recovery), сборка <source_commit>
5. Доп. возможности: официальный эмулятор + ускорение, маршрут наряда и off_route, heading, build identity, …
build: source_commit=<40-hex> dashboard_bundle_sha256=<hex> consumer_static_sha256=<hex>
```

`artifacts/external-artifacts.md`:

```text
| path | bytes | sha256 | как получить |
| .local/validate-tuning-2026-09-26/final_model.cbm | … | … | решение Q3 |
| consumer/map/moscow.pmtiles | … | … | решение Q3 |
| data/emulator/ndtp-telemetry-emulator.tar | … | … | официальная раздача |
```

Неудачный путь: если скриншота нет, `readback.md` пишет источник «сообщение пользователя», а предложение повысить C1 в scorecard не передаётся (правило 2). Если ссылка из формы не открывается в чистом clone, поле помечается `BROKEN` и уходит вопросом координатору.

## Decisions

- `.tasks/**/artifacts/` находится в `.gitignore` (`.gitignore:15`), поэтому readback C1, manifest и текст формы в свежий clone не попадут. Для долговечности C1-readback (`readback.md` и скриншот, <1 МБ) коммитится через `git add -f` вместе с задачей. Commit делает координатор по действующему разрешению. Остальные artifacts остаются локальными.
- Агент не заходит на платформу, не заполняет и не отправляет форму и ничего не публикует (Release, LFS push, upload). Это делает пользователь или агент по его явному отдельному разрешению (score-plan Q1, Q3).
- Числа в форме берутся только из readback: perf — из T-10 или, пока T-10 нет, из T-4 QA с явной подписью «сборка T-4, 11 ТС»; lead time — из T-9 или честное «не измерено».
- PyDoc: `python -m pydoc -w` (тот же генератор, что у `docs/pydoc/*`) для `transport_ml.*`, `transport_backend.*`, `consumer.service` плюс `docs/pydoc/index.html` со списком модулей. Генерация — после финального commit T-7, чтобы документировать код формы.
- Проверка чистого clone занимает стек эксклюзивно (конфликт портов): только после T-10 и T-7 W10. Затем основной стек поднимается снова командой из README.
- `docs/prd/evaluation-scorecard.md` и файлы T-7 W9 (`README.md`, `docs/runbooks/**`, `docs/index.md`) T-8 не правит. Предложение по scorecard — score-plan §7, применяет владелец doc stream. Нужные правки README (раздел для жюри, строка про score) передаются в T-7 W9 как findings.

## Boundary

- **Included:** C1 readback и SHA; manifest внешних артефактов; `docs/pydoc/**`; черновик и финал текста формы; проверка чистого clone; передача правок scorecard и README их владельцам.
- **Excluded:** отправка формы и submission; публикация артефактов; правки product code, dashboard, compose и README; новый ML-score; benchmark (T-10); lead time (T-9).

## Work items

- [ ] W1: C1 durable proof (можно сейчас).
  - Deliverable: `artifacts/c1-platform-readback/` — скриншот или экспорт пользователя и `readback.md` с двумя SHA и `match`.
  - Contribution: делает C1 = 6/6 проверяемым для scorecard, формы и Q&A.
  - Proxy result: текст «score 1,0» без файла-источника или без сверки SHA.
- [ ] W2: Manifest внешних артефактов и способ передачи (можно сейчас; способ — после Q3).
  - Deliverable: `artifacts/external-artifacts.md` с путём, размером, SHA-256 и способом получения для модели, PMTiles, tar эмулятора и `data/`.
  - Contribution: система запускается вне текущего checkout (C3).
  - Proxy result: список путей без хэшей; ссылка на локальный путь как «способ получения».
- [ ] W3: Актуальный PyDoc (после финального commit T-7).
  - Deliverable: `docs/pydoc/` для `transport_ml`, `transport_backend`, `consumer.service` и `index.html`.
  - Contribution: закрывает обязательный артефакт №4 (C3).
  - Proxy result: старые snapshots только `transport_ml`.
- [ ] W4: Текст формы (черновик сейчас, финал после T-7 W10 и T-10).
  - Deliverable: `artifacts/submission-form.md` — все 5 полей, build identity финальной сборки, каждая ссылка проверена.
  - Contribution: пользователь копирует и отправляет до 23:59 без поиска данных.
  - Proxy result: поля с placeholder'ами в финальной версии; числа без сборки.
- [ ] W5: Проверка чистого clone (после T-10 и W10 T-7).
  - Deliverable: `artifacts/clean-clone.md` — clone финального commit во временный каталог, внешние артефакты по manifest, команда из README, readback состояния.
  - Contribution: доказывает «поднимается по одной инструкции» вне рабочего дерева (C3 → 6).
  - Proxy result: проверка в рабочем checkout.
- [ ] W6: Передача правок.
  - Deliverable: findings для T-7 W9 (README) и предложение scorecard (score-plan §7) с новыми ссылками evidence — владельцам.
  - Contribution: документы не противоречат сданному.
  - Proxy result: правка чужих файлов самим T-8.

## Verification

- W1: `shasum -a 256 submission.csv` = `repo_submission_sha256`; скриншот или экспорт существует и его SHA записан; при отсутствии скриншота источник назван явно.
- W2: для каждой строки manifest `shasum -a 256 <path>` и `stat -f %z <path>` совпадают с таблицей.
- W3: `ls docs/pydoc` содержит `transport_backend.orchestration.html`, `transport_backend.run.html`, `consumer.service.html`; `index.html` ссылается на все файлы.
- W4: каждая ссылка на файл существует на финальном commit (`git ls-tree <commit> <path>` или manifest). Swagger `curl -sf :8000/docs` и `:8001/docs` → 200 на финальном стеке. `source_commit` в форме = `curl -s :8002/api/build` = `git rev-parse HEAD`.
- W5: в чистом clone команда из README → `docker compose ps` healthy; через ≤2 мин `snapshot.run.state=running`; `/api/build.source_commit` = commit. Неудачный путь: без PMTiles или модели сообщение совпадает с README troubleshooting.
- Приёмка: пользователь подтверждает, что форма отправлена (review `human`).

## Execution log

## Closure
