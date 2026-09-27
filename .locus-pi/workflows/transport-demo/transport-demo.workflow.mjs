export const meta = {
  name: "transport-demo",
  description: "Implement transport2 D01-D07 with Opus 5.5 sole-writer attribution and GPT-5.6 gates.",
  profile: "standard",
};

const PLANNER = { model: "openai-codex/gpt-5.6-sol:high" };
const WRITER = { model: "claude-code/opus55-review:high" };

export default async function run({ agent, publishPrimaryArtifact }, input) {
  const task = typeof input === "string" && input.trim() ? input.trim() : ".tasks/T-6-2026-09-26-ndtp";

  const preflight = await agent(`Read ${task}, its current favorable plan review, artifacts/baseline-checkpoint.md, the authoritative roadmap, Git status and model registry. Do not edit product source. Write baseline.md in the workflow workspace. Revalidate baseline commit 07abbbfc467aef64784bfc91d3344595212f8275 after the favorable gate; record HEAD/status, exact planned product path list under the approved roots, runtime asset hashes, required build inputs, and both exact model routes. Return proceed only when the product baseline is recoverable, every dirty product path is classified, the allowlist is explicit, and claude-code/opus55-review resolves. Otherwise return blocked.`, {
    ...PLANNER,
    label: "preflight-baseline",
    title: "Проверить baseline и маршруты",
    choice: ["proceed", "blocked"],
    choiceFallback: "blocked",
  });
  if (preflight === "blocked") return { ok: false, status: "failed" };

  await agent(`Implement D01/M0 for ${task}. You are the only authorized product writer. Read baseline.md and preserve compatible prior MapLibre, PMTiles, Three.js and consumer work. Make the real served Full HD 1920x1080 map-first layout, selection, filters, card, diagnostics disclosure, mode label, and honest loading/empty/map-unavailable states. Edit only the exact preflight allowlist. Do not commit, push, publish, edit task authority, or launch agents. Build and test the slice; write d01.md in the workflow workspace with changed paths and checks.`, {
    ...WRITER,
    label: "write-d01",
    title: "Opus 5.5 · реализовать D01",
  });
  const guardD01 = await agent(`Guard writer call label write-d01 for ${task}. Do not edit product source. Correlate this exact workflow call identity with its own adapter diagnostic and trace receipt; never use an unqualified latest trace. Require actual responseModel claude-opus-5-5, no commit, exact allowed paths, explained HEAD/status transition, and valid D01 build evidence. Write attribution-d01.md. Return blocked on wrong, missing or ambiguous receipt, outside path, or any product edit by this guard.`, {
    ...PLANNER,
    label: "guard-d01",
    title: "Проверить авторство D01",
    choice: ["pass", "blocked"],
    choiceFallback: "blocked",
  });
  if (guardD01 === "blocked") return { ok: false, status: "failed" };

  await agent(`Implement D02A for ${task}. Only you may edit product source. Add one versioned deterministic scenario with 6-12 vehicles, 4-6 phases, scenario_run_id, Start/Pause/Next/Reset, and honest scenario marking through ordinary UI components. Reset must not reload and must isolate local history. Backend failure must never silently enable scenario mode. Stay inside baseline.md allowlist; do not commit or edit task authority. Build/test and write d02a.md.`, {
    ...WRITER,
    label: "write-d02a",
    title: "Opus 5.5 · реализовать D02A",
  });
  const guardD02A = await agent(`Guard exact writer call write-d02a for ${task} using that call's own adapter receipt. Do not edit product. Require claude-opus-5-5, no commit, exact allowlist, explained status, deterministic scenario tests and no hidden fallback. Write attribution-d02a.md; return blocked on any ambiguity or violation.`, {
    ...PLANNER,
    label: "guard-d02a",
    title: "Проверить авторство D02A",
    choice: ["pass", "blocked"],
    choiceFallback: "blocked",
  });
  if (guardD02A === "blocked") return { ok: false, status: "failed" };

  await agent(`Complete M1 for ${task}: D03 two directions/stops/schematic route and target marker; D04 incident center, dedupe, grouping and active/monitoring_lost/resolved lifecycle; minimal D05 acknowledge/reopen, safe note and local history. Only you edit product. Preserve honest route/stop semantics and never invent cause, probability or real route geometry. Stay in allowlist, do not commit, build/test the full M1 path, and write m1.md.`, {
    ...WRITER,
    label: "write-m1",
    title: "Opus 5.5 · завершить M1",
  });
  const guardM1 = await agent(`Guard exact writer call write-m1 for ${task} with its own adapter receipt. Do not edit product. Require claude-opus-5-5, no commit, allowlist-only changes, build/tests, working incident lifecycle and local action evidence. Write attribution-m1.md and return blocked on any violation.`, {
    ...PLANNER,
    label: "guard-m1",
    title: "Проверить авторство M1",
    choice: ["pass", "blocked"],
    choiceFallback: "blocked",
  });
  if (guardM1 === "blocked") return { ok: false, status: "failed" };

  await agent(`Attempt bounded D02B for ${task} without delaying M1. Only you may edit product. Reuse existing NDTP/backend/ML seam; seek two distinct linked model results visible through consumer/UI. Never use a browser stub or claim unsupported evidence. If unavailable, preserve exact reason and leave D02B not demonstrated. Stay in allowlist, do not commit, run focused checks and write d02b.md.`, {
    ...WRITER,
    label: "write-d02b",
    title: "Opus 5.5 · проверить D02B",
  });
  const guardD02B = await agent(`Guard exact writer call write-d02b for ${task} with its own adapter receipt. Do not edit product. Require claude-opus-5-5, no commit, allowlist-only changes and truthful evidence. Write attribution-d02b.md and return blocked on attribution or scope violation.`, {
    ...PLANNER,
    label: "guard-d02b",
    title: "Проверить авторство D02B",
    choice: ["pass", "blocked"],
    choiceFallback: "blocked",
  });
  if (guardD02B === "blocked") return { ok: false, status: "failed" };
  const d02bOutcome = await agent(`Read ${task}, d02b.md and attribution-d02b.md. Do not edit product. Write d02b-outcome.md stating demonstrated or not demonstrated with exact evidence. Both honest outcomes continue; return blocked only for a false claim, mutation, or missing attribution. Verify this call leaves product status unchanged.`, {
    ...PLANNER,
    label: "classify-d02b",
    title: "Зафиксировать честный итог D02B",
    choice: ["continue", "blocked"],
    choiceFallback: "blocked",
  });
  if (d02bOutcome === "blocked") return { ok: false, status: "failed" };

  await agent(`Implement D06 and local-only D07 for ${task}. Only you edit product. Produce one scenario launch, three repeatable resets, Full HD polish, demo script/assets, honest pitch and submission provenance without changing submission.csv or performing external submission. Build the real served bundle, run relevant JS/Python checks and docker compose config. Record a named pre_commit_build_identity with source HEAD/status and hashes for dashboard bundle and consumer static. Do not commit or use remote actions. Write m2.md.`, {
    ...WRITER,
    label: "write-m2",
    title: "Opus 5.5 · подготовить M2",
  });
  const guardM2 = await agent(`Guard exact writer call write-m2 for ${task} with its own adapter receipt. Do not edit product. Require claude-opus-5-5, no commit, exact allowlist, successful required checks and a reproducible named pre_commit_build_identity. Write attribution-m2.md and return blocked on any violation.`, {
    ...PLANNER,
    label: "guard-m2",
    title: "Проверить авторство M2",
    choice: ["pass", "blocked"],
    choiceFallback: "blocked",
  });
  if (guardM2 === "blocked") return { ok: false, status: "failed" };

  const review1 = await agent(`Technical review ${task} read-only against D01-D07 and the exact current pre_commit_build_identity in m2.md. Inspect full product diff, builds/tests, all guards and old relevant findings. Write technical-review-1.md with actionable findings. Return ready only with no blocker/high and all required evidence; fix for correctable product gaps; blocked for attribution, dishonest claims or unavailable required evidence. Do not edit product.`, {
    ...PLANNER,
    label: "technical-review-1",
    title: "Техническое review результата",
    choice: ["ready", "fix", "blocked"],
    choiceFallback: "blocked",
  });
  const reviewGuard1 = await agent(`Verify technical-review-1 made no product edit and remained bound to the same pre_commit_build_identity. Write review-guard-1.md. Return blocked on any product status/hash change.`, {
    ...PLANNER,
    label: "guard-review-1",
    title: "Проверить неизменность после review",
    choice: ["pass", "blocked"],
    choiceFallback: "blocked",
  });
  if (reviewGuard1 === "blocked" || review1 === "blocked") return { ok: false, status: "failed" };

  if (review1 === "fix") {
    await agent(`Correct only the actionable findings in technical-review-1.md for ${task}. You remain the sole product writer. Stay inside the exact allowlist, do not commit, rebuild/retest, and record a refreshed named pre_commit_build_identity in correction.md.`, {
      ...WRITER,
      label: "write-correction",
      title: "Opus 5.5 · исправить findings",
    });
    const guard2 = await agent(`Guard exact correction call write-correction with its own adapter receipt. Do not edit product. Require claude-opus-5-5, no commit, allowlist-only changes, passed checks and a refreshed pre_commit_build_identity. Write attribution-correction.md.`, {
      ...PLANNER,
      label: "guard-correction",
      title: "Проверить авторство исправлений",
      choice: ["pass", "blocked"],
      choiceFallback: "blocked",
    });
    if (guard2 === "blocked") return { ok: false, status: "failed" };
    const review2 = await agent(`Fresh read-only technical review of ${task} after correction, explicitly bound to the refreshed pre_commit_build_identity in correction.md. Write technical-review-2.md. Return ready only when current evidence satisfies D01-D07; otherwise blocked. Do not edit product.`, {
      ...PLANNER,
      label: "technical-review-2",
      title: "Повторно проверить результат",
      choice: ["ready", "blocked"],
      choiceFallback: "blocked",
    });
    const reviewGuard2 = await agent(`Verify technical-review-2 made no product edit and retained the refreshed pre_commit_build_identity. Write review-guard-2.md.`, {
      ...PLANNER,
      label: "guard-review-2",
      title: "Проверить неизменность после повторного review",
      choice: ["pass", "blocked"],
      choiceFallback: "blocked",
    });
    if (review2 === "blocked" || reviewGuard2 === "blocked") return { ok: false, status: "failed" };
  }

  const handoff = await agent(`Compose the complete truthful handoff for ${task} from the accepted technical review and current pre_commit_build_identity. Do not edit product. State what works, D02B demonstrated/not demonstrated, checks, exact pending Manager scoped-commit steps, and that T-6 remains open for separate read-only openai-codex/gpt-6-sol:high browser QA at 1920x1080. Browser findings require a newly reviewed Opus 5.5 remediation workflow, fresh guards/review, new Manager commit identity and full rerun. Write manager-handoff.md and return the same complete handoff.`, {
    ...PLANNER,
    label: "compose-manager-handoff",
    title: "Подготовить handoff Manager и browser QA",
  });
  const finalGuard = await agent(`Final immutability guard for compose-manager-handoff. Do not edit product. Verify the composer left the current pre_commit_build_identity and product status unchanged. Write final-guard.md and return blocked on any change.`, {
    ...PLANNER,
    label: "guard-final-handoff",
    title: "Проверить финальную неизменность",
    choice: ["pass", "blocked"],
    choiceFallback: "blocked",
  });
  if (finalGuard === "blocked") return { ok: false, status: "failed" };
  return publishPrimaryArtifact("workflow-result.md", handoff);
}
