## Q0: Goal alignment

Question: Служит ли перепланированная T-6 текущей цели проекта без нарушения стратегии и принятого пользователем нового приоритета?
Source check: `.locus/soul.md`; `.locus/goal.md`; authoritative `.locus/roadmap.md`, обновлённый из `/Users/ravius/Downloads/transport2-demo-tasks/Roadmaps/roadmap.md`; все `/Users/ravius/Downloads/transport2-demo-tasks/tasks/*/task.md`; текущий task state; прежний plan/run evidence по ссылкам ниже.
Answer: Да. Явный intent пользователя от 2026-09-27 делает новый demo-roadmap authoritative для T-6: сначала законченная диспетчерская история M1, затем локальная подготовка M2. Это меняет непосредственный gate, но не отменяет правила `soul.md` о честных claims, point-in-time данных и разделении ML/system evidence. `.locus/goal.md` и прежний T-6 ещё описывают 15-минутный поток как главный результат; для этой задачи эта часть superseded новым intent и перенесена в D09. Долгосрочный strategic outcome остаётся историческим направлением, а не условием приёмки demo-slice.
Status: accepted-by-user
Direction: on-track
Consequence: task.md теперь требует D01–D07, обязательный M1 и подготовку M2; D02B имеет отдельный verdict, D08–D09 не блокируют; старый plan review стал stale и нужен новый independent review текущего hash.

## История и baseline, которые нельзя потерять

- Сохранённая lifecycle history остаётся в `.tasks/T-6-2026-09-26-ndtp/events.jsonl`; task status остаётся `doing`, frontmatter не изменён.
- Прежний root workflow: [`.locus-pi/runs/20260926-163549-febd/README.md`](../../.locus-pi/runs/20260926-163549-febd/README.md). Terminal `result.json`: `ok:false`, `disposition.status:failed`.
- Child delivery: [`.locus-pi/runs/20260926-163549-febd/children/20260926-164143-df6d/outputs/README.md`](../../.locus-pi/runs/20260926-163549-febd/children/20260926-164143-df6d/outputs/README.md). Он завершил stream/map implementation и GPT-5.6 technical review, затем упал на старом adapter в Opus branch; QA/arbitration/finish не исполнялись.
- Полезный baseline: `artifacts/workflow/stream.md`, `map.md`, `technical-review.md`, `map-browser.png`, `map-live.png`; текущие dirty product changes, локальные PMTiles и bundle. Их сохраняют и сравнивают с новым контрактом, но ни один новый work item заранее не отмечается выполненным.
- Старый plan review `artifacts/plan-review/independent-r1.md` относится к hash `373aa9…` и прежнему outcome. Он остаётся историческим evidence, не current gate.
- Подтверждённый selector для нового implementation owner: `claude-code/opus55-review`; trace `/Users/ravius/.local/state/locus-pi-claude-code-adapter/runs/2026-09-27T01-41-23-453Z-24405-407b48ab-a85b-4e54-9b70-e73fe6cc724c.latest.json` фиксирует `responseModel: claude-opus-5-5`. Это отменяет прежнюю неопределённость транспорта, но не является review продукта.

## Round-2 repair: PR-001 / PR-002

- **PR-001 — accepted.** Planner принимает finding: одной prompt-policy недостаточно. Owner нового executable source — `$locus-pi-workflow-create`; новый source и его validation должны существовать до round-2 review, чтобы reviewer проверил фактические stages и guards. Старый `transport-live` и failed run не resume/replay. Product implementation начинается только после favorable round 2. Fail-closed attribution ниже делает Opus 5.5 единственным writer, а GPT-5.6/GPT-6 — read-only.
- **PR-002 — accepted и уточнён по факту.** Manager уже создал локальный checkpoint `07abbbfc467aef64784bfc91d3344595212f8275` до favorable round 2. Planner принимает его как recoverable snapshot совместимого old-run product work, а не как пройденный gate или attribution новой реализации. После favorable round 2 GPT-5.6 preflight обязан заново подтвердить commit/exact path manifest, `HEAD`, clean/known non-product status, exact allowed product write-set и hashes runtime assets; mismatch блокирует workflow. Создавать второй baseline commit только ради восстановления первоначально задуманного порядка не нужно.
- **Round-2 design review reconciliation — accepted.** Finding `workflow-design-review-r2.md` о владельце и порядке закрывается в binding plan так: Opus stages только оставляют uncommitted product edits; ни Opus, ни другой model/product agent не создаёт commits внутри workflow. Workflow заканчивается accepted GPT-5.6 technical review на named `pre_commit_build_identity`, отдельным immutability guard и complete handoff. После workflow Manager детерминированно коммитит exact verified paths, вычисляет `status_after`/`final_build_identity` и только затем запускает GPT-6 browser QA. Это planner reconciliation, не favorable round-2 verdict и не разрешение строить текущий DRAFT source.
- Эти dispositions закрывают planner response на findings, но не являются favorable verdict. Round-2 reviewer заново проверяет изменённый plan и фактический новый workflow source; review artifact `artifacts/plan-review/roadmap-r1.md` остаётся неизменным.

## Q1: Как заменить прежний 15-минутный gate

Question: Должен ли старый W2 с минимум 15 минутами новых прогнозов по-прежнему блокировать T-6?
Source check: новый roadmap, разделы 1–3 и 6; D02 и D09; `artifacts/workflow/stream.md`; `technical-review.md` finding 1.
Answer: Нет. Новый roadmap явно заменяет R03 коротким повторяемым сценарием D02/D06, а полную длину переносит в резерв D09. M1 обязан работать без ML через честно маркированный D02A. D02B получает отдельный короткий end-to-end gate и не блокирует интерфейс.
Status: accepted-by-user
Direction: on-track
Consequence: D02A — обязательный M1 slice; D02B — отдельный work item/verdict; отсутствие 15-минутного evidence больше не делает M1 неготовым. Старое simulation-clock решение сохраняется только там, где совместимо и реально нужно D02B; не расширять его ради D02A.

## Q2: Что именно гарантирует M1

Question: Какой минимальный завершённый пользовательский путь нельзя сокращать?
Source check: roadmap M1; D01, D02A, D03, D04, D05 acceptance; текущий map baseline.
Answer: `обзор → сценарное изменение → предупреждение → события → направление/объект/цель → карточка → взять в работу → заметка/история → возврат в норму`. Обязательны два demo-направления, одна новая тревога, режимная подпись и одно настоящее локальное действие. Preview связи с водителем можно отложить; primary CTA без поведения нельзя.
Status: source-proven
Direction: on-track
Consequence: W1, W2A, W3, W4 и минимальный W5 образуют неделимый closure gate M1. Исследование, красивый screenshot или отдельный ML trace не заменяют основной путь.

## Q3: Как обращаться с кодом прошлого workflow

Question: Переписывать ли существующую карту/clock integration из-за нового roadmap и новых model boundaries?
Source check: `artifacts/workflow/{stream,map,technical-review}.md`; roadmap разделы 1, 5, 6; D01 «Что уже есть»; текущий dirty worktree.
Answer: Нет. Новый roadmap прямо требует сохранять существующие MapLibre, PMTiles, Three.js points и consumer. Старый код — непроверенный baseline: Opus 5.5 сначала сравнивает его с новым task contract и меняет только необходимые места. Новая visual реализация с нуля допустима лишь при конкретном блокере совместимости, подтверждённом GPT-5.6 comparison/review.
Status: source-proven
Direction: on-track
Consequence: первая implementation операция — scoped diff и build/readback, а не cleanup. Нельзя удалять совместимый код, чужие незакоммиченные изменения или исторические runtime artifacts.

## Q4: Владельцы и интерфейсы

Question: Где должны жить новые обязанности без второго источника истины?
Source check: D02–D05; текущий call path из прежнего планирования; technical review «Проверенные решения без finding».
Answer:
- `transport_backend`: NDTP/clock/schedule/orchestration, проверенные target coordinates и model linkage.
- `consumer`: `/api/snapshot`, last-good snapshot, локальная доставка build/assets.
- `dashboard`: source-mode adapter, карта, scenario reducer, incident reducer, filters/cards/actions/local history.
- Scenario catalog: один локальный versioned source для demo routes/stops/phases; он не участвует в real ML inference.
- Browser: только consumer API и UI-state; не вызывает ML, не угадывает stop/route geometry и не превращает свежий HTTP в свежую телеметрию.
Status: source-proven
Direction: on-track
Consequence: target marker берёт координату из Schedule/API либо честно отсутствует; route line остаётся schematic. Alert/activity имеет одного owner: выбранный UI incident reducer или узкое Backend исправление, но не оба одновременно.

## Binding decisions

1. **Authority.** `.locus/roadmap.md` — текущий roadmap T-6. D01–D07 входят; D08–D09 не блокируют.
2. **Milestones.** M1 — обязательный product gate. M2 в этой задаче означает локально подготовленные D06/D07; platform submission и публикация запрещены.
3. **Modes.** `demo-scenario` и `NDTP+ML` разделены, видимо подписаны и никогда не включаются друг вместо друга автоматически. Переключение сбрасывает локальную историю текущего scenario run.
4. **Truth semantics.** `prediction_source=scenario` только для заданных значений; `prediction_source=model` только после реального model linkage. Unknown не становится 0/green; причина/вероятность не выдумываются; opened/read/acknowledged/resolved — разные состояния.
5. **Map semantics.** Вид сверху, одна MapLibre camera, локальные PMTiles; Three.js можно сохранить для транспорта. Demo line — schematic dotted line. D08 владеет verified real shape позднее.
6. **Workflow source gate.** Owner — `$locus-pi-workflow-create`. Новый source с post-gate baseline revalidation, sole-writer guards, review/immutability gates, named pre-commit identity и commit-free handoff создаётся и валидируется до round-2 review; round 2 проверяет source фактически. Старый `transport-live` не resume/replay. До favorable round 2 product implementation запрещён.
7. **Preservation checkpoint.** Manager уже создал recoverable baseline commit/checkpoint `07abbbfc467aef64784bfc91d3344595212f8275` из совместимого product work old run до favorable round 2. Он сохраняется как стартовый snapshot с exact committed path list; он не закрывает plan gate и не считается реализацией D01–D07. После favorable gate preflight повторно валидирует commit, HEAD, manifest, known non-product status и runtime hashes. Unrelated `.idea/`, T-5, task/runtime materials и иные non-product изменения остаются вне product scope.
8. **Fail-closed uncommitted attribution.** GPT-5.6 preflight фиксирует baseline HEAD, clean product state либо исчерпывающий known non-product status, exact `allowed_product_write_set` и SHA-256 runtime assets. Только `claude-code/opus55-review` с actual `claude-opus-5-5` меняет allowed product paths, всегда uncommitted. После каждого Opus stage отдельный GPT-5.6 guard сверяет неизменный HEAD/status/diff/write-set/model и exact writer call label/call identity с receipt/trace именно этого вызова; commit/HEAD transition, неоднозначный latest trace или иное несоответствие немедленно блокирует run.
9. **Read-only actors.** GPT-5.6 и GPT-6 могут писать только workflow evidence внутри `.tasks/T-6-2026-09-26-ndtp/artifacts/`. Любое изменение product diff во время их stage — blocker, как и wrong/missing/ambiguous response model или изменение outside allowlist. Каждый routing guard возвращает runtime-owned `pass`/`blocked`; `blocked` ведёт прямо в non-success до следующего model call.
10. **Workflow terminal contract.** Последний Opus writer выполняет source build/tests и оставляет generated product output uncommitted; последующие GPT-5.6 stages выполняют только non-mutating readback. Результат формирует `pre_commit_build_identity={baseline_source_commit,product_diff_sha256,dashboard_bundle_sha256,consumer_static_sha256}`. GPT-5.6 technical review принимает именно её; отдельный immutability guard подтверждает отсутствие последующей product mutation. Workflow затем публикует complete handoff и завершается: без commit, без ещё одного product-capable/model stage и без remote actions.
11. **Commit, QA and remediation authority.** Только Manager вне workflow после успешного handoff детерминированно коммитит exact verified product paths, вычисляет exact committed path list, `status_after` и `final_build_identity={source_commit,dashboard_bundle_sha256,consumer_static_sha256}`, затем разрешает GPT-6 browser QA. Browser finding требует нового authored/validated и favorable-reviewed Opus remediation workflow: uncommitted fix → GPT-5.6 guard/review/immutability → новая pre-commit identity/handoff → новый Manager scoped commit → новая final identity → полный GPT-6 rerun. Push/PR/merge/deploy/publication/upload запрещены.

## Model and actor boundaries

| Stage | Actor/model | Authority | Forbidden |
|---|---|---|---|
| New workflow authoring/validation | `$locus-pi-workflow-create` | До round 2 создать новый source с post-gate revalidation, commit-free writer stages, guards, pre-commit review/identity и complete handoff; получить source-validation evidence | Менять product source; использовать/resume старый `transport-live`; запускать implementation до favorable round 2 |
| Existing baseline checkpoint | Manager | Сохранить уже созданный recoverable checkpoint `07abbbfc467aef64784bfc91d3344595212f8275`, его exact paths и known non-product inventory | Считать ранний commit favorable gate/новой implementation attribution; включать unrelated paths; remote actions |
| Post-gate preflight / slice brief | `openai-codex/gpt-5.6-sol` | После favorable round 2 read-only заново подтвердить commit/HEAD/status/allowlist/runtime hashes, сопоставить roadmap/task с baseline, выпустить bounded brief | Менять product source; принимать mismatch; расширять allowlist после writer stage без blocked/restart |
| Implementation and fixes | `claude-code/opus55-review`, actual `claude-opus-5-5` | Единственный product-source writer; менять только exact allowed product paths и оставлять diff uncommitted | `git commit` или иной HEAD transition; делегировать edits GPT/Codex; менять paths outside allowlist; менять task/workflow authority |
| Post-Opus attribution guard | отдельный `openai-codex/gpt-5.6-sol` stage | Read-only связать exact call label/identity с receipt этого вызова, сравнить pre/post HEAD, status, uncommitted write-set и actual response model; вернуть `pass`/`blocked` fail closed | Использовать unqualified latest trace; самому исправлять нарушение; продолжать после `blocked` |
| Technical review in workflow | `openai-codex/gpt-5.6-sol` | Read-only verdict по design/contracts/tests на named `pre_commit_build_identity` | Самоисправление, product edits, commit или browser-QA verdict |
| Workflow immutability/handoff | `openai-codex/gpt-5.6-sol` guard, затем workflow JavaScript | Подтвердить неизменность reviewed diff/identity; на `pass` опубликовать complete handoff и завершить workflow | Любой следующий model/product stage, commit, build mutation или remote action |
| Scoped final commit outside workflow | Manager, deterministic local commands | После успешного handoff добавить и commit только exact verified product paths; вычислить committed paths, `status_after` и `final_build_identity` с теми же served-asset hashes | Коммитить artifacts/unrelated paths; допускать model agent к commit; push/PR/merge/deploy |
| Post-commit browser QA | `openai-codex/gpt-6-sol`, `thinking: high` | Read-only проверить real local build именно final identity, 1920×1080 и main path; писать task artifacts | Запуск до Manager identity, stubs, request interception, product edits |
| Remediation cycle | новый reviewed workflow: Opus 5.5 uncommitted fix → GPT-5.6 guards/review/handoff; затем Manager commit → GPT-6 full rerun | Замкнуть defect на новой committed identity | Fix/commit от GPT-6/GPT-5.6, commit внутри workflow или reuse старой QA identity |

Runtime evidence каждого agent stage фиксирует requested selector и actual executed/response model. Для writer guard evidence также связывает exact call label/call identity с adapter receipt/trace именно этого вызова; unqualified latest trace не является доказательством. GPT-5.6/GPT-6 могут писать только task workflow artifacts; изменение product tree во время read-only stage блокирует run. Новый source обязан реализовать каждый guard как runtime-owned `pass`/`blocked` stage boundary с прямым fail exit и сохранить baseline HEAD неизменным до завершения workflow. Старый route (`gpt-6-sol` как visual writer, `opus5-review`) несовместим и не запускается снова.

## Slice order

### Slice 0A — новый workflow source до round 2; без product implementation

- `$locus-pi-workflow-create` исправляет/создаёт source, который реализует post-gate baseline preflight, exact allowlist, sole uncommitted Opus writer, отдельный post-Opus GPT-5.6 guard, read-only GPT stages, review на named pre-commit identity, immutability guard и complete commit-free handoff.
- Каждый guard, включая correction guard, возвращает runtime-owned `pass`/`blocked`; `blocked` идёт прямо в explicit non-success. Writer guard связывает exact call label/identity с receipt именно этого вызова.
- Source проходит обязательную validation/readback; round-2 reviewer читает фактический source и evidence. Старый `transport-live` не меняется для возобновления и не resume/replay.
- До favorable round 2 никакой stage не меняет product source. Допустимы только workflow source и task workflow artifacts.

### Slice 0B — post-gate revalidation существующего baseline

- Сохраняется уже созданный Manager checkpoint `07abbbfc467aef64784bfc91d3344595212f8275` с exact committed path list и known non-product inventory. Он является recoverable starting point, а не favorable gate; повторный baseline commit ради порядка не создаётся.
- Только после favorable round 2 GPT-5.6 read-only preflight подтверждает existence/manifest commit, `HEAD == baseline_commit_sha`, фиксирует status before, exact `allowed_product_write_set` и SHA-256 для runtime assets (включая используемые map/bundle/submission assets).
- GPT-5.6 читает old-run handoffs и сопоставляет baseline с D01–D07; T-5, `.idea/`, `.locus-pi` runtime и task artifacts исключаются из product write-set.
- Missing/unrecoverable baseline, unclassified product diff, wildcard allowlist или asset hash mismatch дают `blocked` до вызова Opus.

Для slices 1–5 каждый Opus writer stage оставляет изменения uncommitted и заканчивается отдельным GPT-5.6 attribution guard. Следующий slice не начинается, пока guard не подтвердит exact writer receipt, actual `claude-opus-5-5`, неизменный baseline HEAD, объяснённый status и отсутствие changed paths outside exact allowlist.

### Slice 1 — D01 / M0

- Opus 5.5 доводит существующий экран, не переписывая уже полезные MapLibre/Three/consumer owners.
- Основной viewport 1920×1080; дополнительно 1440×900 и 1366×768.
- Результат: обзор, выбор, фильтры, карточка, diagnostics disclosure, режимная подпись, loading/empty/map unavailable.

### Slice 2 — D02A / repeatable UI scenario

- Один versioned scenario с 6–12 object IDs, 4–6 phases и deterministic controls.
- Обычные map/card/incident components получают scenario snapshots через один data adapter.
- Reset создаёт новый run ID и очищает только локальное состояние этого run.

### Slice 3 — D03 → D04 → minimal D05 / complete M1

- D03: два directions, stops, schematic line, target marker, unknown mapping behavior.
- D04: incident lifecycle, unread/active counters, dedupe/grouping/navigation.
- D05: acknowledge/reopen и safe note history. Driver-contact preview — только после обязательного CTA.
- После slice выполняется реальный main-path smoke, но это ещё не независимая post-workflow QA.

### Slice 4 — D02B, separate and non-blocking

- Короткий bounded attempt на существующем backend/ML seam.
- Success: два различимых linked predictions, model version/hash, snapshot/UI equality.
- Failure: точная reason/evidence и `not demonstrated`; нельзя расширять slice до D09 или задерживать D06/D07.

### Slice 5 — D06 and D07 / prepare M2

- Source build → consumer static/image; одна scenario command, отдельная D02B command только при success.
- Три repeat/reset, 2–3 minute script, screenshots and backup recording.
- Preserve submission candidate; verify hash/schema/provenance; local upload checklist and honest pitch.

### Slice 6 — pre-commit review/handoff, Manager commit, then browser QA

- Последний Opus writer выполняет source build/tests и оставляет generated product output uncommitted. На неизменном baseline HEAD последующий GPT-5.6 non-mutating readback фиксирует `pre_commit_build_identity={baseline_source_commit,product_diff_sha256,dashboard_bundle_sha256,consumer_static_sha256}` и exact verified product paths.
- GPT-5.6 technical review read-only compares full result to current task именно на этой identity, включая релевантные старые findings: clean-host assets, clock reasons только если D02B их затронул, browser recovery, target marker, licenses.
- После accepted technical review отдельный immutability guard подтверждает, что review не изменил product tree, diff или identity. На `pass` workflow публикует complete handoff и заканчивается; внутри workflow нет commit, следующего model call или product mutation.
- Вне workflow Manager детерминированно добавляет и коммитит только exact verified product paths из handoff, затем фиксирует exact committed paths, `status_after` и `final_build_identity={source_commit,dashboard_bundle_sha256,consumer_static_sha256}`. Served hashes должны совпасть с pre-commit identity; mismatch блокирует QA. Remote actions отсутствуют.
- Только после Manager readback GPT-6 high read-only открывает exactly эту real local build на 1920×1080 и проходит полный M1 path без stubs; pre/post HEAD/status также сохраняются.
- Любой finding требует нового authored/validated и favorable-reviewed Opus remediation workflow. Opus оставляет fix uncommitted; GPT-5.6 выполняет attribution guard, fresh technical review, immutability guard и новую pre-commit identity/handoff; Manager коммитит exact новые paths и вычисляет новую final identity; GPT-6 повторяет весь main path. Failing final QA leaves T-6 open.

## Verification plan

### Contract and provenance

- Compare `.locus/roadmap.md` byte-for-byte with the accepted source roadmap.
- Verify task frontmatter/status/history unchanged and all work-item boxes unchecked after replanning.
- До round 2 проверить фактический новый workflow source и source-validation evidence; подтвердить owner `$locus-pi-workflow-create`, отсутствие resume/replay старого `transport-live`, невозможность product implementation до favorable gate и отсутствие commit stage/model внутри workflow.
- Record old root/child run IDs and new model traces; do not rewrite old runtime evidence.
- Existing baseline evidence: checkpoint `07abbbfc467aef64784bfc91d3344595212f8275`, `git show --name-status`/equivalent exact path list and known non-product inventory. После favorable gate preflight заново подтверждает commit existence, `HEAD`, `status_before`, `allowed_product_write_set` и runtime asset SHA-256. Неучтённый product path или mismatch блокирует старт.
- Каждый post-Opus guard записывает exact workflow call label/identity, adapter receipt именно этого вызова, pre/post HEAD/status, actual response model, uncommitted changed paths и allowlist comparison. Любой commit/HEAD transition, unqualified latest trace, path outside allowlist или изменение product diff во время read-only agent stage блокирует run.
- Workflow evidence связывает accepted technical review и immutability guard с `pre_commit_build_identity={baseline_source_commit,product_diff_sha256,dashboard_bundle_sha256,consumer_static_sha256}` и complete handoff. Затем Manager вне workflow коммитит только exact verified product paths. Readback связывает `status_after`, exact final commit path list и `final_build_identity={source_commit,dashboard_bundle_sha256,consumer_static_sha256}`; served hashes обязаны совпасть с pre-commit identity.

### Deterministic checks

- `npm ci --prefix dashboard`
- `npm --prefix dashboard run build`
- Relevant JS/browser behavioral tests registered in an actual test command.
- Relevant Python tests for Backend/consumer contracts only where touched.
- `docker compose config --quiet`; consumer build/readback; local asset/manifest/hash/license checks.
- No manual source-of-truth edits only in generated `consumer/static`.

### Behavioral M1 checks

1. Start the documented real local scenario profile and open the served URL at 1920×1080.
2. Confirm no external CDN/tile requests and no browser/page errors.
3. Identify source mode, one problem, affected object and next action in about five seconds.
4. Run Start/Next through warning; open Events; select group/object; verify map/card/target synchronization.
5. Acknowledge, add text containing HTML-like characters, verify escaped rendering and persistence over polling.
6. Advance to normal; verify one historical incident, no duplicate toast, resolved separate from handled.
7. Reset without reload; verify new run ID, deterministic phases and no inherited action history.
8. Break Backend availability; verify unavailable/last-known and no hidden switch to scenario. Restore and verify next revision.
9. Repeat three complete runs; inspect build identity and screenshots.

### D02B checks

- Use real NDTP sender/emulator path chosen for this bounded slice, not browser interception.
- Capture input/frame identity, context, model request/result identity, model version/hash and consumer-visible value for two results.
- A failed stop observation, target window or model availability emits a concrete reason. Timeout ends `not demonstrated`, not success.
- No 15-minute requirement; no claim about onset lead time, C1/C2 or model accuracy.

### Independent review and QA

- Plan round 2: current task hash, standard profile, independent reviewer; фактически прочитать новый validated workflow source и проверить enforcement PR-001/PR-002 и reconciliation из `workflow-design-review-r2.md`: existing-checkpoint revalidation, pass/blocked guards, exact receipt correlation, pre-commit review identity, commit-free terminal handoff и Manager commit outside workflow. Historical review cannot satisfy it; product implementation waits for favorable gate.
- Technical review: GPT-5.6 read-only, after implementation/fixes, on named `pre_commit_build_identity`; report findings by severity and owner. Post-review immutability guard доказывает отсутствие product edits, после чего workflow заканчивается complete handoff.
- Manager commit readback: exact handoff paths only, new source commit, exact committed path list, `status_after`, matching served hashes and no remote action. Только этот readback разрешает browser QA.
- Browser QA: GPT-6 Sol high after Manager commit, read-only, real build, no stubs, 1920×1080; capture command/URL/final build identity, pre/post HEAD/status, overview/incident/action evidence, console/network failures and verdict.
- Любой QA fix выполняет только Opus в новом reviewed workflow и остаётся uncommitted до fresh GPT-5.6 review/handoff; затем Manager делает новый scoped commit, создаётся новая final identity и GPT-6 выполняет full rerun. Screenshot comparison alone is insufficient.

## Failure paths and stop conditions

| Failure | Required behavior | Must not happen |
|---|---|---|
| Old code conflicts with D01–D05 | GPT-5.6 identifies concrete delta; Opus makes minimum compatible change | Delete/rewrite the whole baseline or lose user changes |
| Wrong/missing implementation response model или receipt не связан с exact writer call | Немедленно `blocked`; сохранить evidence; не принимать diff | Accept code because selector name looked close, брать unqualified latest trace или исправлять attribution задним числом |
| Любой commit/HEAD transition внутри workflow, необъяснённый status или path вне exact allowlist | Немедленно `blocked`; сохранить baseline и stage evidence; вернуть owner workflow/Opus | Продолжить review с warning, расширить allowlist постфактум или разрешить model agent commit |
| GPT-5.6/GPT-6 оставил product diff | Немедленно `blocked`; read-only actor не исправляет нарушение | Считать diff частью Opus work или разрешить self-acceptance |
| PMTiles/assets absent or corrupt | Visible map-unavailable state; repair local asset provenance before M1 QA | Fetch public tiles silently or draw fake map points |
| Backend unavailable | Last-known/unavailable with source state; manual mode choice only | Auto-enable scenario or show green/0 |
| D02B fails | Save IDs/reason; mark only D02B `not demonstrated`; proceed to M1/M2 | Expand into D09, block M1 or claim end-to-end |
| Target coordinate absent | Textual target remains honest; D03 acceptance stays open until verified source added | Guess location, use `[0,0]`, infer route shape from basemap |
| Polling repeats same alert | Incident reducer updates one episode | New toast/count every poll |
| Clipboard unavailable | Selectable fallback text and explicit manual copy | False success toast |
| Manager scoped commit/readback не совпал с handoff | Block QA; preserve evidence; reconcile exact paths/status/hashes without model-owned commit | Start GPT-6 on an unverified commit или silently include artifacts/unrelated paths |
| Browser QA finds defect | Новый reviewed workflow: Opus uncommitted fix → GPT-5.6 guard/review/immutability/handoff → Manager scoped commit/new identity → GPT-6 full rerun | GPT-6/GPT-5.6 edits product, commit внутри workflow, reuse старой identity или author self-accepts |
| Blocker/high remains after review/QA | Keep work item and task open; hand back with evidence | Change status, tick item or weaken criterion |
| External action requested implicitly by tooling | Stop at local artifacts/commits | Push, PR, merge, deploy, publish or upload |

## Plan-review focus

Independent reviewer should challenge these points first:

1. Does the contract truly make M1 complete without smuggling D02B/D09 back into its gate?
2. Are D01–D05 sufficiently concrete to prevent a pretty but non-operational mock?
3. Реализует ли фактический новый workflow source sole-writer policy: only Opus 5.5, exact allowlist, exact call-to-receipt model check, отдельный `pass`/`blocked` guard и fail-closed реакцию на product edits read-only stages?
4. Доказывает ли post-gate preflight, что ранний Manager checkpoint `07abbbf…` по-прежнему является точным recoverable baseline, без ложной атрибуции или повторного commit ради порядка?
5. Завершается ли workflow на accepted pre-commit technical review + immutability guard + complete handoff, оставляя scoped commit и final identity исключительно Manager вне workflow?
6. Are D06/D07 enough to prepare M2 while respecting the prohibition on external submission/publishing?
7. Can post-commit GPT-6 browser QA reproduce the main path on the actual served build without stubs and route every defect through a new reviewed Opus workflow, Manager commit and full rerun?

Новый workflow source должен быть authored/validated до round 2, чтобы reviewer проверял код, а не обещание. Favorable round 2 разрешает post-gate revalidation существующего checkpoint и последующую product implementation; это не отмечает work item выполненным и не меняет task status. Этот planning repair сам favorable verdict не записывает.
