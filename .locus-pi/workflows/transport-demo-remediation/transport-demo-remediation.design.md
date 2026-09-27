# transport-demo-remediation workflow design

## Goal

Repair the two findings from the independent post-commit GPT-6 browser QA without reopening the accepted D01-D07 scope:

1. At 1920x1080, map labels `Д-104` and `Д-107` overlap in scenario phase 5 in three repeatable reset-runs; a smaller `Д-101`/`Д-105` overlap is also present in phase 4.
2. A fresh browser context requests `/favicon.ico`, receives 404 on both served ports, and records a console error.

The workflow produces an uncommitted, reviewed remediation. The Manager alone makes the subsequent local commit and final build identity. A fresh full GPT-6 Sol high browser QA remains mandatory after that commit; the previous QA verdict cannot be reused.

## Fixed inputs and boundaries

- Task: `.tasks/T-6-2026-09-26-ndtp`.
- Runtime input is not read or forwarded; the executable is lexically bound to that exact task path before the first model call, so a caller cannot substitute another task.
- Finding source: `artifacts/transport-demo/gpt6-browser-qa/qa.md` plus its named screenshots and JSON evidence.
- Immutable product baseline: commit `5c9a77c26ed8831f21f747b72b21aaf8e93ca4c4` on branch `dev`.
- Product must be clean at launch; the known workflow/prompt status is non-product and must be classified, not edited.
- Preflight freezes two separate manifests in the remediation workspace: (a) the byte-exact launch `git status --porcelain=v1 --untracked-files=all`, and (b) a sorted SHA-256 manifest covering this design, this executable workflow, final favorable review `workflow-remediation-review-r12.md`, `manager-commit.md`, every regular file in the original `gpt6-browser-qa/` tree, and all seven other known dirty non-product files (two original `transport-demo` workflow files, three `transport-live` workflow files, and two `.locus/prompts` files). Before accepting `READY`, preflight reads the exact design/source SHA-256 values recorded by the R12 review and requires independent current hashes to equal them. The manifest therefore fixes both QA-tree membership and every protected byte. A post-preflight guard verifies both before Opus starts and records anchor hashes for all three preflight artifacts. Every later stage must independently enumerate the same current protected set into temporary storage, recompute every SHA-256, byte-compare the resulting sorted manifest with the frozen manifest, and verify all prior anchor/evidence files remain byte-identical. Merely hashing or comparing the frozen manifest file is insufficient.
- Product writer: exact route `claude-code/opus55-review:high`, whose receipt must report actual `claude-opus-5-5`.
- Read-only scoping, guards, review, and handoff: exact route `openai-codex/gpt-5.6-sol:high`.
- No commit, push, pull request, merge, deploy, publication, platform submission, task-authority edit, or agent launch inside the workflow.
- Primary viewport: exactly 1920x1080. No request interception, mocks, stubs, or replacement of `/api/snapshot`.

## Product write-set

Only the following product paths may change or be created:

```text
consumer/index.html
consumer/static/app.css
consumer/static/app.js
dashboard/app.js
dashboard/browser-check.mjs
dashboard/map-labels.js
dashboard/map-labels.test.mjs
dashboard/package.json
dashboard/style.css
```

Task evidence under the remediation workspace is not product. Existing QA evidence is read-only.

Every model call has an exact write contract. Preflight may create only `remediation-baseline.md`, `remediation-launch-status.txt`, and `protected-input-manifest.sha256`. The post-preflight guard may create only `post-preflight-guard.md`. Opus may change only the nine product paths and create only `remediation.md`, `changed-product-manifest.txt`, `product-content-manifest.txt`, and files under `remediation-evidence/`. Each later read-only stage may create only its one named Markdown artifact. Each call records before/after workspace membership and hashes and blocks itself on any other created, deleted, or modified path. No call may rewrite frozen manifests, launch status, earlier evidence, protected inputs, or another stage's output.

`consumer/static/map-worker.js` is a protected build-touch path, not an allowed changed path: its baseline SHA-256 is `4b1e431c6d6dce4f4137a4630069f43d1b34ae40a32cf8a40768146f32df05ec`. A checkout build may rewrite it only byte-identically. It must never appear in the changed-path manifest or Manager commit.

## Stages

| Node | Owner | Responsibility | Route |
| --- | --- | --- | --- |
| `preflight` | GPT-5.6 | Verify exact baseline, clean product, exact findings, model routes, served identity, and frozen write-set. | `proceed` / `blocked` |
| `post-preflight-guard` | GPT-5.6 | Verify preflight made no product change and freeze/read back exact launch/protected-input manifests before the writer. | `pass` / `blocked` |
| `write-remediation` | Opus 5.5 | Repair collision/readability and favicon 404, rebuild served assets, test three resets and both ports, write a new pre-commit identity. | next guard |
| `guard-remediation` | GPT-5.6 | Correlate the exact writer call and adapter receipt; require actual Opus 5.5, unchanged HEAD, no commit, write-set confinement, and complete evidence. | `pass` / `blocked` |
| `technical-review` | GPT-5.6 | Independently re-run/read the real browser evidence, inspect the diff, and judge both findings plus regressions against the new identity. | `ready` / `blocked` |
| `review-guard` | GPT-5.6 | Prove the reviewer made no product or identity change. | `pass` / `blocked` |
| `compose-handoff` | GPT-5.6 | Produce exact Manager commit/readback instructions and the mandatory full GPT-6 rerun contract. | opaque handoff |
| `final-guard` | GPT-5.6 | Prove composer immutability and validate the complete handoff artifact against the exact composer output byte-for-byte. | `pass` / `blocked` |

## Required evidence

- Before/after HEAD, branch, index, complete status, exact changed product paths, and product diff hash.
- Every stage forbids delegation and sub-agent launch. The one named Opus call is the only product writer.
- Every stage requires branch `dev`, baseline HEAD, empty index, the original non-product status subset unchanged, and the protected-input manifest byte-identical.
- Exact adapter diagnostic/trace receipt for `write-remediation`, not an unqualified latest trace.
- Real served build at 1920x1080 with three independent Reset-to-phase-5 repetitions.
- Every visible vehicle label remains individually readable; specifically, `Д-104` and `Д-107` have zero bounding-box intersection after animation settles. Phase-4 `Д-101`/`Д-105` must also have zero intersection.
- Fresh contexts on `:8002/?mode=live` and `:8003/?mode=demo` produce no favicon 404 and no console/page/failed-request errors attributable to the application.
- A recorded complete HTTP(S) request inventory contains zero external requests, successful or failed; no request interception/mocking is used.
- Existing full M1 browser path and tests remain green.
- A named refreshed `pre_commit_build_identity` with the exact fields `baseline_source_commit`, `branch`, `complete_changed_product_path_manifest`, `product_diff_sha256`, `dashboard_bundle_sha256`, `consumer_static_sha256`, `protected_input_manifest_sha256`, `served_8002_file_hashes`, and `served_8003_file_hashes`. Both served maps are captured from the accepted real build and independently verified against local bytes.
- `complete_changed_product_path_manifest` embeds the complete LC_ALL=C-sorted changed product path list derived from porcelain status, including allowed untracked files. `product_diff_sha256` hashes an LC_ALL=C-sorted manifest of `status<TAB>content_sha256-or-DELETED<TAB>path` for every changed product path, so tracked, staged, deleted, and untracked content are all covered. The identity records the manifest files and their SHA-256 values.
- Source/build consistency is checked with temporary output or an immutable post-build diff. `consumer/static/map-worker.js` remains byte-identical to its protected baseline hash and is excluded from the changed/commit manifests.
- The Manager handoff is non-empty and contains the accepted nine-field pre-commit identity and exact Manager commit gates described above. Immediately before `git add`, Manager must independently enumerate the complete current protected path set into temporary storage, recompute every current file SHA-256, generate the same sorted path/hash format, and byte-compare it with frozen `protected-input-manifest.sha256`; it must also verify the frozen manifest file and preflight anchor hashes themselves remain unchanged. Comparing only `protected_input_manifest_sha256` is insufficient.

The post-commit GPT-6 QA output path is fixed to the previously absent `.tasks/T-6-2026-09-26-ndtp/artifacts/transport-demo/gpt6-browser-qa-rerun/`; QA may create files only below that directory and must publish a sorted file/hash manifest. Immediately before QA, and again after QA excluding only that new directory, exact state must be: `branch=dev`; `HEAD=final_build_identity.source_commit`; empty index; full porcelain status byte-equal to the frozen launch non-product status; zero tracked or untracked product diff; dashboard/consumer/protected hashes and both served maps equal the final identity; and a fresh protected-set enumeration equal to the accepted protected manifest. The original `gpt6-browser-qa/` tree and every protected input remain byte-identical.

The full fresh `openai-codex/gpt-6-sol:high` contract requires: the complete 1920x1080 M1 path; three independent Reset runs with zero intersections for both named pairs; exactly 8 scenario objects and 5 ordered deterministic phases with Start/Pause/Next/Reset, three byte-equivalent runs, a new `scenario_run_id` per reset, and no prior notes/actions/history after reset; honest persistent scenario/source/prototype labels, live unavailable/offline behavior with no silent scenario fallback, and diagnostics matching final identity; two separately keyed directions, catalog-owned targets, honest schematic-route text, and no fabricated target/marker for missing target or invalid GPS; event unread/active state, one toast per episode, source+direction grouping, opposite directions kept separate, stable incident IDs, repeated-snapshot deduplication, and correct active/monitoring_lost/resolved transitions; acknowledge/reopen, literal plain-text/hostile-HTML-safe notes, note/action/history persistence across phase/polling updates, and reset isolation; fresh `:8002/?mode=live` and `:8003/?mode=demo` contexts with zero favicon/console/page/failed-network errors and zero external HTTP(S) requests whether successful or failed; actionable 1440x900 and 1366x768 spot-checks; and no interception/mocks/stubs. `final-guard` validates the exact composer output/artifact and every required value before publication.

## Control flow and failure policy

All stages are sequential. Every choice gate continues only on its named positive value and otherwise returns failed immediately, before another model call. The sole writer runs once. Any failed prerequisite, ambiguous/wrong writer receipt, outside path, commit, missing browser evidence, remaining overlap, favicon failure, regression, reviewer mutation, or identity mismatch returns failed. There is no optimistic fallback and no second writer pass inside this workflow. The final published artifact is the accepted Manager/browser-QA handoff, unchanged after `final-guard`.

Worst case: 8 model calls. The workflow source itself performs no file reads or writes; children use their tools and workspace artifacts. Success does not close T-6.

Status: DRAFT — requires source validation and favorable GPT-5.6 design/source review before launch.
