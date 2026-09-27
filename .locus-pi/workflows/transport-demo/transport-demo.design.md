# Design: transport-demo

Purpose: implement the accepted T-6 D01–D07 demo with Opus 5.5 as the only product writer, then fail closed on attribution or technical-review violations.
Input: task directory, normally `.tasks/T-6-2026-09-26-ndtp`.
Primary output: `workflow-result.md`.
Evidence boundary: agents inspect the current repository, task, authoritative roadmap, prior-run evidence, Git state, and the workflow workspace supplied by the host.
Pattern: fixed graph with five known product slices, per-slice attribution gates, and one bounded correction with fresh recheck.
Brief detail: outcome-led, with procedural attribution checks because the dirty-baseline and model-route failures were observed.
Context: run in `/Users/ravius/projects/transport2`; output under the T-6 artifact workspace; task/runtime artifacts are evidence, not product source.
Executors: `openai-codex/gpt-5.6-sol:high` for preflight, guards, reviews and decisions; `claude-code/opus55-review:high` for every product edit. The Opus adapter route was live-probed as `claude-opus-5-5`.

Namespace: `runnable root`.

## Entries

| Ref | Entry kind | Responsibility | Invoked by |
| --- | --- | --- | --- |
| `transport-demo` | runnable root | reconcile baseline, implement D01–D07, guard attribution, review, and perform at most one correction | operator |

1. Before launch, Manager supplies product checkpoint `07abbbfc467aef64784bfc91d3344595212f8275`, post-review execution baseline `20be8e1512ab5cd0f9540db4a2bf9a8a8dae14a8`, and a favorable current round-2 plan review. GPT-5.6 preflight requires HEAD to equal the execution baseline, verifies that approved product roots have no diff from the product checkpoint, then validates status, exact allowed product paths, runtime asset hashes, model routes, and build prerequisites; it writes `baseline.md` and returns `proceed` or `blocked`.
2. Five ordered Opus 5.5 calls implement D01, D02A, D03–D05/M1, D02B, and D06–D07 without committing. Each is followed immediately by a GPT-5.6 attribution guard returning `pass` or `blocked`; `blocked` exits before another slice or review. Every guard correlates the exact workflow call label/call identity with that call's adapter diagnostic and trace receipt, never an unqualified latest trace, and blocks a wrong, missing, or ambiguous `responseModel`. D02B then gets a read-only outcome/immutability gate whose report distinguishes `demonstrated` from evidence-backed `not demonstrated`; both continue, dishonesty or mutation blocks.
3. GPT-5.6 technical review is explicitly bound to the current named `pre_commit_build_identity`, writes its complete report, and returns `ready`, `fix`, or `blocked`. A following GPT-5.6 immutability guard must pass before the route is consumed.
4. `fix` gives the review artifact to one fresh Opus 5.5 correction call. That call rebuilds and records a new named `pre_commit_build_identity`; a fresh attribution guard verifies it before review-2. Review-2 is explicitly bound to that refreshed identity and is followed by its own immutability guard. Exhaustion is non-success.
5. `ready` invokes GPT-5.6 to compose a complete Manager/browser-QA handoff from the accepted review and named `pre_commit_build_identity`. A final GPT-5.6 immutability guard verifies that composer made no product edit and returns `pass` or `blocked`. With `pass`, workflow JavaScript publishes the handoff unchanged; no model call follows the final guard. Manager then performs the deterministic scoped local commit and computes the final identity outside this workflow.

| Node | Responsibility | Receives | Returns | Next |
| --- | --- | --- | --- | --- |
| `preflight` | pin baseline, routes, write-set, and prerequisites without product edits | task input and repository | `proceed` or `blocked`, plus `baseline.md` | implementation or fail |
| `slice-d01` | implement D01/M0 | task, roadmap, baseline evidence | product state and slice handoff | guard-d01 |
| `guard-d01` | verify Opus 5.5 receipt and exact write-set | repository and call evidence | `pass` or `blocked`, plus artifact | slice-d02a or fail |
| `slice-d02a` | implement deterministic UI scenario | task and accepted D01 state | product state and slice handoff | guard-d02a |
| `guard-d02a` | repeat attribution/write-set proof | repository and call evidence | `pass` or `blocked`, plus artifact | slice-m1 or fail |
| `slice-m1` | implement D03, D04 and minimal D05 | task and accepted prior slices | complete M1 product state | guard-m1 |
| `guard-m1` | repeat attribution/write-set proof | repository and call evidence | `pass` or `blocked`, plus artifact | slice-d02b or fail |
| `slice-d02b` | bounded real NDTP+ML attempt | task and M1 | product/evidence state | guard-d02b |
| `guard-d02b` | repeat attribution/write-set proof | repository and call evidence | `pass` or `blocked`, plus artifact | d02b-outcome or fail |
| `d02b-outcome` | classify honest demonstrated/not-demonstrated result and verify own immutability | D02B evidence and repository | `continue` or `blocked`, plus artifact | slice-m2 or fail |
| `slice-m2` | implement D06 and local-only D07, run final build/checks, record named `pre_commit_build_identity` | accepted M1 and D02B evidence | prepared M2 product state | guard-m2 |
| `guard-m2` | repeat attribution/write-set proof | repository and call evidence | `pass` or `blocked`, plus artifact | review-1 or fail |
| `review-1` | full technical review and route | final current implementation, guards, and exact current `pre_commit_build_identity` | `ready`, `fix`, or `blocked`, plus artifact naming that identity | review-guard-1 |
| `review-guard-1` | verify technical reviewer made no product edits | repository and review evidence | `pass` or `blocked` | consume review route or fail |
| `correct` | sole-writer targeted correction, rebuild, and refreshed identity | task plus round-1 findings | corrected product state and new `pre_commit_build_identity` | guard-2 |
| `guard-2` | repeat attribution proof and verify refreshed identity after correction | current repository and exact correction-call receipt | `pass` or `blocked`, plus artifact naming the refreshed identity | review-2 or fail |
| `review-2` | fresh full review and route after correction | current implementation, guard, and exact refreshed `pre_commit_build_identity` | `ready` or `blocked`, plus artifact naming that identity | review-guard-2 |
| `review-guard-2` | verify reviewer made no product edits | repository and review evidence | `pass` or `blocked` | consume final route or fail |
| `compose-handoff` | produce complete Manager commit and post-workflow QA handoff without product edits | accepted review and `pre_commit_build_identity` | opaque final handoff | final-guard |
| `final-guard` | verify composer immutability and unchanged pre-commit identity | repository and composer-call evidence | `pass` or `blocked` | publish unchanged handoff or fail |

Concurrency: none; sole-writer attribution requires ordered stages.
Loop bounds: five initial slices and at most one correction/recheck after whole-change review.
Budgets: none; launch defaults apply and undeclared axes are unbounded.
Declared sizes: none.
File boundary: workflow source performs no file reads. Children inspect and write permitted files through their own tools.
Worst-case calls: 20 logical calls: preflight (1), five writer/guard pairs (10), D02B outcome (1), review and immutability guard (2), correction/guard/review/review-guard (4), compose-handoff/final-guard (2).
Failure exits: failed launch prerequisite, wrong/missing/ambiguous response model, changed path outside the exact allowlist, failed guard, product mutation by a read-only stage, dishonest D02B claim, failed required check, blocked review, or exhausted correction returns `{ ok: false, status: "failed" }`.
Mechanisms: orchestration-only route. Git/hash/trace checks are child-owned semantic evidence gates because this DSL cannot inspect bytes or sandbox tools; this residual boundary is explicit. Product commits are forbidden inside the workflow. Manager performs the scoped commit and final identity readback after workflow success. Shaped choices control routing; reports are written by children; there are no remote actions. Workflow success leaves T-6 open: separate read-only `openai-codex/gpt-6-sol:high` browser QA must use the Manager-published final identity at 1920×1080. Browser findings require a newly reviewed Opus 5.5 remediation workflow/stage, fresh GPT-5.6 guards/review, a new Manager commit/identity, and a full GPT-6 rerun; they do not reuse this correction allowance.
Status: REVIEWED — ready for build. Findings WDR-001–WDR-006 closed in `artifacts/workflow-design-review-r4.md`.
