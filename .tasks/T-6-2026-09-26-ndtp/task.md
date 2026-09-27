---
schema: task.v3
id: T-6
title: "Длительный поток NDTP и интерактивная карта задержек Москвы"
status: doing
review_required: qa
plan_review_profile: standard
plan_review_gate: required
type: feature
priority: p1
owner: codex
created_at: "2026-09-26T16:29:38.759Z"
updated_at: "2026-09-26T16:42:01.848Z"
parent: null
depends_on: []
gstack_refs: {}
goal_contract: v1
stream: T
workflow: feature
---

# T-6: Длительный поток NDTP и интерактивная карта задержек Москвы

## Outcome

Primary goal: Довести текущую локальную сборку до главного объёма нового roadmap — M1: красивый и честно маркированный диспетчерский demo-path «обзор карты → предупреждение → направление и карточка → взять в работу → история», затем локально подготовить M2 (репетицию и пакет сдачи) без зависимости от 15-минутного потока.
Direction: on-track
Comment: Принятый пользователем roadmap от 2026-09-27 теперь authoritative для T-6. Он сохраняет долгосрочные правила честности проекта, но заменяет прежний обязательный 15-минутный поток главным gate: M1 обязателен, D02B проверяется отдельно, D08–D09 не блокируют показ.

### Result examples

- На реальной локальной сборке при основном viewport 1920×1080 диспетчер сразу видит спокойную 2D-карту Москвы, 6–12 машин, заметную проблему и постоянную подпись режима; за примерно пять секунд можно назвать проблемный объект, состояние данных и следующий клик.
- «Начать демо» воспроизводимо проводит через новое предупреждение, панель событий, два демонстрационных направления, карточку с прогнозом/целью/свежестью, «Взять в работу», заметку и последующий возврат задержки в норму. Reset создаёт новый `scenario_run_id` и не переносит локальную историю прошлого запуска.
- В режиме «Демо-сценарий» значения подписаны как заданные сценарием. Ошибка Backend не включает заглушки молча. В отдельном режиме «NDTP + ML» надпись `prediction_source=model` допустима только после связи нового входа с реальным результатом модели и snapshot consumer.
- Если D02B не проходит отдельный короткий gate, M1 остаётся честным интерфейсным прототипом и D03–D07 продолжаются; 15-минутный прогон и восстановление остаются D09 и не задерживают M1/M2.
- M2 локально подготовлен: есть одна команда сценарного запуска, повторяемый рассказ на 2–3 минуты, контрольные кадры/резервная запись, сохранённый submission-кандидат с provenance и честный pitch. Никакая внешняя отправка не выполняется.
- До первого product edit сохранён attribution manifest, например: `baseline_commit_sha=<40-hex>`, `preflight_head=<тот же SHA>`, `allowed_product_write_set=[dashboard/app.js, ...]`, `status_before=<clean product tree + перечисленный known non-product status>`, `runtime_asset_sha256={consumer/map/...:<hash>, ...}`. Пустой/неполный SHA, wildcard вместо точного write-set или неучтённый dirty product path блокирует запуск.
- Workflow review связывает неизменный baseline HEAD, точный product diff и served build в `pre_commit_build_identity={baseline_source_commit:<SHA>, product_diff_sha256:<hash>, dashboard_bundle_sha256:<hash>, consumer_static_sha256:<hash>}`. После завершения workflow Manager коммитит только эти проверенные product paths и фиксирует `status_after` и `final_build_identity={source_commit:<новый SHA>, dashboard_bundle_sha256:<тот же проверенный hash>, consumer_static_sha256:<тот же проверенный hash>}`. Только эта final identity передаётся GPT-6; после любого Opus remediation создаётся новая identity, а прежняя QA не переносится.

## Decisions

- `.locus/roadmap.md` дословно обновлён новым roadmap и является текущим источником порядка D01–D09. Обязательный порядок одного implementation owner: D01 → D02A → D03 → D04 → минимальный D05 → D06; D07 готовится параллельно только в непересекающихся локальных материалах. D02B — отдельный проход после стабильного M1. D08 и D09 исключены из closure gate этой T-6.
- Сохранить и переиспользовать совместимый результат прежнего workflow, не переписывая его автоматически: [root run `20260926-163549-febd`](../../.locus-pi/runs/20260926-163549-febd/README.md), [child delivery `20260926-164143-df6d`](../../.locus-pi/runs/20260926-163549-febd/children/20260926-164143-df6d/outputs/README.md), `artifacts/workflow/{stream,map,technical-review}.md` и скриншоты. Старый run завершился `failed` до Opus review/QA; его код и evidence — baseline, не подтверждение завершения новых work items. Старый favorable plan review относится к прежнему hash и не закрывает новый plan gate.
- Существующие владельцы сохраняются: `transport_backend` владеет ingest/clock/schedule/orchestration; `consumer` — `/api/snapshot`, last-good snapshot и локальной раздачей; `dashboard` — картой, событиями и действиями. Browser продолжает путь `consumer /api/snapshot → Backend /v1/vehicles → Orchestrator`; модель не переносится в UI.
- D02 разделён. **D02A** — фиксированный локальный UI-сценарий с `scenario_run_id`, 4–6 фазами и явным `prediction_source=scenario`; он обязателен для M1. **D02B** — короткий реальный NDTP → Backend → ML → consumer → UI фрагмент с минимум двумя связанными модельными результатами; он не блокирует M1 и не подменяется accepted frames, HTTP polling или ML-stub в browser.
- Основной экран остаётся 2D-картой сверху. Текущие MapLibre, локальные PMTiles, consumer и совместимый Three.js-слой сохраняются; удаление Three.js и большой UI/backend refactor не являются целью. Схематическая линия подписывается «Схема последовательности; не трасса по дорогам». Причины и вероятности не выдумываются; observed deviation, prediction и свежесть различаются.
- **Workflow owner — `$locus-pi-workflow-create`.** До round-2 plan review он обязан создать и провалидировать новый workflow source с этой actor/write-attribution политикой; reviewer проверяет фактический source и source-validation evidence. Старый `transport-live`, его source и failed run нельзя resume/replay как исполнитель этой задачи. Product implementation разрешается только после favorable round 2; authoring/validation нового workflow source выполняется до него и не меняет product source.
- **Manager уже создал recoverable baseline checkpoint `07abbbfc467aef64784bfc91d3344595212f8275` до favorable round 2.** Этот преждевременный локальный commit принимается только как сохранение совместимого product work старого run, а не как пройденный gate, attribution реализации D01–D07 или разрешение продолжать product work. После favorable round 2 и непосредственно перед workflow read-only preflight `openai-codex/gpt-5.6-sol` заново подтверждает существование commit, `HEAD == baseline_commit_sha`, его exact path manifest, clean product state либо полный known non-product status, точный `allowed_product_write_set` и SHA-256 runtime assets. Несовпадение блокирует workflow; новый baseline commit только ради восстановления прежнего порядка не требуется.
- **Единственный implementation/fix actor product source — `claude-code/opus55-review`; только он может менять paths из `allowed_product_write_set`.** Фактический route обязан дать `responseModel: claude-opus-5-5`; selector trace подтверждает только доступность транспорта, но не будущую атрибуцию. Любой иной, отсутствующий или неоднозначный response model блокирует stage.
- **GPT-5.6 и GPT-6 read-only для product worktree.** Они могут писать только task workflow artifacts внутри `.tasks/T-6-2026-09-26-ndtp/artifacts/`; после каждого Opus stage отдельный GPT-5.6 read-only guard сравнивает pre/post HEAD, status, точный write-set, uncommitted product diff и actual response model. Каждый guard связывает exact writer call label/call identity именно с adapter receipt/trace этого вызова, а не с неопределённым latest trace. Изменение вне allowlist, commit/HEAD transition внутри workflow, wrong/missing/ambiguous model либо изменение product diff во время GPT-5.6/GPT-6 stage блокирует run; read-only actor не может принять или исправить собственное нарушение.
- **Постановка среза, guard и technical review — `openai-codex/gpt-5.6-sol`; commits внутри workflow запрещены.** Opus меняет product paths только uncommitted и не вызывает `git commit`; последний Opus writer также выполняет требуемый source build и оставляет generated product output в том же проверяемом diff. Последующие GPT-5.6 stages выполняют readback/non-mutating checks, фиксируют `pre_commit_build_identity` на неизменном baseline HEAD и точном diff, получают accepted technical review и отдельный immutability guard, затем workflow завершается complete handoff без новых model calls или product mutations.
- **Финальный product commit принадлежит Manager и выполняется вне workflow.** Только после успешного handoff Manager детерминированно коммитит exact verified product paths, не включая artifacts/unrelated status, затем вычисляет committed path list, `status_after` и `final_build_identity`; hashes served dashboard/consumer assets обязаны совпасть с проверенной pre-commit identity. Только после этого запускается browser QA.
- Отдельная browser QA выполняется моделью `openai-codex/gpt-6-sol` с `thinking: high`: только реальная локальная сборка, основной viewport 1920×1080 и главный путь M1, без подмены `/api/snapshot`; QA read-only и пишет только task artifacts. Любой fix требует нового authored/validated и favorable-reviewed Opus workflow: Opus оставляет исправления uncommitted, GPT-5.6 заново выполняет guard, technical review, immutability check и pre-commit identity, Manager вне workflow коммитит новые exact paths и вычисляет новую final identity, после чего GPT-6 полностью повторяет QA. Незакрытый blocker/high либо повторно видимый дефект оставляет QA pending и work item открытым.
- Разрешены только локальные scoped commits Manager вне workflow и без включения чужих изменений. Push, PR, merge, deploy, публикация и внешняя отправка submission запрещены. Сохранить пользовательские изменения и совместимый код прошлого run; `.idea/`, runtime-файлы и T-5 остаются вне product commit/write-set.

## Boundary

- **Included:** D01–D07 по новому roadmap; обязательный M1, отдельный D02B, локальная подготовка M2; до round 2 — authoring/validation нового source владельцем `$locus-pi-workflow-create`; после favorable gate — post-gate revalidation уже существующего checkpoint `07abbbfc467aef64784bfc91d3344595212f8275`, fail-closed write attribution, uncommitted Opus product edits, реальная локальная сборка, scenario assets, карта/направления/события/локальные действия, runbook, pitch/submission provenance, accepted workflow technical review, immutability guard, verified pre-commit identity и complete handoff; затем вне workflow — детерминированный scoped commit Manager, final identity/status и отдельная read-only browser QA.
- **Excluded:** resume/replay старого `transport-live`; product implementation до favorable round 2; любой commit от Opus или иного product agent внутри workflow; product edits от GPT-5.6/GPT-6 или вне exact allowlist; commit model-call или workflow JavaScript; D08 real route shape, D09 15-минутный extended stream/recovery, industrial reliability, новый ML-training/score, server-side multi-user action history, полный импорт маршрутов Москвы, push/PR/merge/deploy/publication/platform upload и любые изменения T-5 или `.idea/`.

## Work items

- [ ] W1: D01 — основной экран и проверенный baseline.
  - Deliverable: GPT-5.6 фиксирует краткую постановку/сравнение текущего baseline со сценарием D01; Opus 5.5 сохраняет полезный MapLibre/PMTiles/Three.js код прошлого run и доводит реальную сборку до desktop-компоновки карты, выбора, списка/фильтров, карточки, диагностики и явной маркировки режима.
  - Contribution: даёт M0 и визуальную основу обязательного M1.
  - Proxy result: новый mock, screenshot без раздаваемого bundle или переписывание карты при уже совместимом baseline не принимаются.
- [ ] W2: D02A — повторяемый интерфейсный сценарий.
  - Deliverable: локальный сценарий с 6–12 объектами, 4–6 фазами, `scenario_run_id`, Start/Pause/Next/Reset и состояниями «нет прогноза / обновляется / новое предупреждение / данные недоступны» через обычные UI-компоненты.
  - Contribution: гарантирует управляемую и честную историю M1 независимо от доступности ML.
  - Proxy result: статичный первый snapshot, скрытый fallback при ошибке Backend или сценарные числа без постоянной подписи не принимаются.
- [ ] W3: D02B — отдельный сквозной ML-фрагмент.
  - Deliverable: один-два поддерживаемых ТС и короткий воспроизводимый вход, минимум два новых связанных model results с `prediction_input_frame_id`/context revision, model version/hash и тем же значением в `/api/snapshot`/UI, либо точная диагностика, почему gate не пройден.
  - Contribution: готовит дополнительный честный ML-фрагмент M2, не задерживая интерфейс.
  - Proxy result: accepted packet, `/ready`, revision growth, тестовый ML-stub или один переизданный prediction не считаются D02B.
- [ ] W4: D03 — остановки, два направления и честная подсветка.
  - Deliverable: два demo-направления, общий каталог route/stop IDs, выбор/фильтр, target marker из проверенной координаты и пунктирная схема последовательности; реальные ТС без mapping остаются «Без привязки».
  - Contribution: связывает предупреждение, транспорт и цель в M1.
  - Proxy result: arrival ID под видом физической остановки, произвольный официальный route number или линия под видом реальной трассы не принимаются.
- [ ] W5: D04 — центр событий и жизненный цикл инцидента.
  - Deliverable: непрочитанные/активные события, один toast на эпизод, группировка по `(source_mode, route_key)` с направлением, переход к объекту и состояния `active / monitoring_lost / resolved` без дубликатов polling.
  - Contribution: делает проблему заметной и управляемой в M1.
  - Proxy result: цвет точки без центра событий, повторный alert на каждый poll или offline, показанный как resolution, не принимаются.
- [ ] W6: D05 — минимальное рабочее действие диспетчера.
  - Deliverable: «Взять в работу / Вернуть в новые», безопасная заметка и локальная история по стабильному incident ID; preview связи с водителем только если остаётся время и всегда с подписью «Прототип · отправка не подключена».
  - Contribution: завершает обязательный M1 действием, а не наблюдением.
  - Proxy result: primary CTA без изменения состояния, прочтение вместо обработки или ложное «отправлено/устранено» не принимаются.
- [ ] W7: D06 — реальная сборка, полировка и репетиция M2.
  - Deliverable: одна локальная команда сценарного запуска, отдельная команда D02B при его готовности, три повторяемых reset-run, рассказ на 2–3 минуты, обзор/инцидент/обработка и резервная запись.
  - Contribution: превращает M1 в подготовленный к показу M2.
  - Proxy result: dev-server, stale bundle, внешние CDN или ручная правка `consumer/static` вместо source build не принимаются.
- [ ] W8: D07 — локальный пакет сдачи и честный pitch.
  - Deliverable: сохранённый существующий `submission.csv` с hash/model provenance, локальный checklist двух форм, инструкция без абсолютных путей, финальные кадры и pitch с маркировкой UI/scenario/model/prototype.
  - Contribution: готовит M2 и защищает уже имеющийся ML-кандидат.
  - Proxy result: перезапуск notebook с перезаписью кандидата, неподтверждённый score или внешняя отправка не принимаются.

## Verification

- **Plan/workflow gate:** `$locus-pi-workflow-create` до round 2 создаёт новый source и source-validation evidence. Independent reviewer профиля `standard` проверяет текущий plan hash и фактический workflow source: post-gate baseline revalidation; пять uncommitted Opus slices; каждый guard с исполнимым `pass`/`blocked`; exact call-label-to-receipt correlation; review на named pre-commit identity; immutability guard; complete handoff; завершение workflow до Manager commit; запрет resume старого `transport-live`. До favorable round 2 нет product implementation. Старые run/review не переиспользуются как новый verdict.
- **Baseline/preflight evidence:** checkpoint `07abbbfc467aef64784bfc91d3344595212f8275`, созданный до favorable round 2, допустим только как recoverable starting point. После favorable gate GPT-5.6 preflight заново подтверждает commit existence и exact path list, `HEAD == baseline_commit_sha`, clean product state либо исчерпывающий known non-product status, exact `allowed_product_write_set`, SHA-256 runtime assets и отсутствие `.idea/`, T-5, task/runtime paths в product scope. Missing/mismatched evidence блокирует run; сам факт раннего checkpoint gate не закрывает.
- **Per-stage attribution/immutability guard:** для каждого Opus stage evidence содержит exact workflow call label/identity, requested selector, receipt именно этого вызова с actual `responseModel: claude-opus-5-5`, HEAD/status до и после, uncommitted changed paths и их принадлежность exact allowlist. Каждый guard имеет runtime-owned `pass`/`blocked`, где `blocked` немедленно завершает non-success до следующего model call. Wrong/missing/ambiguous model, path outside allowlist, любой commit/HEAD transition внутри workflow, необъяснённый status или изменение product diff во время GPT-5.6/GPT-6 stage даёт `blocked`, не warning.
- **Pre-commit build/review/handoff:** последний Opus writer выполняет source build `npm ci --prefix dashboard && npm --prefix dashboard run build`, релевантные Python/JS behavioral tests, `docker compose config --quiet`, consumer image/build и оставляет generated product output uncommitted; GPT-5.6 выполняет non-mutating readback, включая отсутствие ручного расхождения `dashboard` ↔ `consumer/static`. На неизменном baseline HEAD фиксируется `pre_commit_build_identity` с exact diff hash и hashes served dashboard/consumer assets. GPT-5.6 technical review принимает именно эту identity; следующий immutability guard подтверждает отсутствие product mutation. Workflow завершается complete handoff и не выполняет commit, build mutation либо model call после финального guard.
- **Manager commit and final identity:** вне workflow Manager детерминированно добавляет и коммитит только exact verified product paths из handoff. Readback подтверждает новый `source_commit`, exact committed path list, `status_after` с отдельно перечисленным known non-product status и `final_build_identity`; served asset hashes совпадают с `pre_commit_build_identity`. Любой лишний path, изменившийся hash или product status блокирует GPT-6. Remote actions отсутствуют.
- **M1 acceptance:** на реальной локальной сборке и 1920×1080 пройти `overview → Start → warning → Events → direction/object → card → acknowledge → note → return to normal/history`; источник режима виден постоянно, карта/панели не перекрывают выбранный объект, browser console/page errors отсутствуют. Spot-check 1440×900 и 1366×768 сохраняет основные действия.
- **D02A:** три запуска дают одинаковый порядок фаз, reset без reload создаёт новый run ID и очищает только его локальную историю. Потеря Backend показывает unavailable/last known state и никогда автоматически не включает scenario.
- **D02B, отдельный non-blocking verdict:** новый input → новый ML result → consumer snapshot → та же UI-карточка; минимум два разных результата и причины пропуска. Неуспех фиксируется как `not demonstrated` и не блокирует M1, D03–D07 или browser QA сценарного режима.
- **D03–D05:** route key включает direction; target coordinate приходит из проверенного source, отсутствующее значение не становится `[0,0]`; сценарий `normal → >120 → repeated snapshot → <=120` создаёт один эпизод и историю resolution; два ТС одного направления группируются, встречное отдельно; acknowledgement/notes переживают polling, HTML не исполняется, reset не переносит action history.
- **D06–D07:** локальные assets работают без неожиданных внешних запросов; три последовательных повтора воспроизводимы; bundle/version читаемы; submission hash/provenance проверены, pitch не заявляет platform score, доказанное 10–15-минутное упреждение, реальную отправку водителю или все маршруты Москвы.
- **Отдельная browser QA только после Manager commit:** `openai-codex/gpt-6-sol`, `thinking: high`, read-only, реальная локальная сборка, основной viewport 1920×1080, без stubs/interception. Evidence: команда/URL, Manager-produced неизменная `final_build_identity`, HEAD/status до и после, скриншоты ключевых шагов, console/network failures и итоговый verdict по M1. Любой finding запускает отдельный новый favorable-reviewed Opus remediation workflow: uncommitted fix → GPT-5.6 attribution guard/technical review/immutability guard → новая verified pre-commit identity и handoff → Manager scoped commit exact новых paths → новая final identity/status → полный GPT-6 rerun. Product diff после QA немедленно блокирует acceptance.
- **Meaningful failure paths:** нет PMTiles/assets → явная ошибка карты без придуманных точек; Backend недоступен → last-known/unavailable без скрытого scenario; D02B timeout/unsupported model window → диагностика и продолжение M1; Clipboard недоступен → ручное копирование без ложного success; незакрытый review/QA finding → work item остаётся открытым, task status не закрывается.

## Execution log

- 2026-09-26: пользователь принял прежний draft. Был запущен workflow `transport-live`, root run `20260926-163549-febd`, child `20260926-164143-df6d`. Он оставил совместимый Backend/UI baseline и technical review, но завершился `failed` на старом Opus adapter до Opus review, QA, arbitration и finish; W2/W4 не были подтверждены.
- 2026-09-27: пользователь принял новый roadmap как authoritative. T-6 перепланирована под D01–D07: M1 стал главным gate, D02B выделен отдельно, D08–D09 перестали блокировать. Work items намеренно оставлены открытыми; status и frontmatter сохранены.

## Closure

Открыта. Закрытие требует выполненного M1, локально подготовленного M2, favorable current plan review, успешного workflow с accepted GPT-5.6 technical review/immutability guard/pre-commit handoff, последующего scoped commit Manager с проверенной final identity и отдельного полного GPT-6 browser QA после всех Opus remediation cycles. D02B может завершиться честным `not demonstrated`; D08–D09 не входят в gate. Внешняя доставка не разрешена.
