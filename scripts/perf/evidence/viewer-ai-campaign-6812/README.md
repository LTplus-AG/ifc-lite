# Viewer AI campaign: recovery qualification

This is bundle and interaction qualification, not an end-to-end loading performance or live-provider quality claim.
Measured source: `b133b0a2cb9faeda4851ca8c8c597d15d5875eff`; main base:
`935c278ae535ae5f69bedb8387abfd09d50c2437`. The source is retained in
`evidence/viewer-ai-campaign-6de1b059` and landed through [#7080](https://github.com/LTplus-AG/ifc-lite/pull/7080).

The candidate combines the canonical FZK/native-oracle/first-party starter repair
(#7073), split Assistant preflight host preservation (#7077), and current answer/source-host test contracts (#7078).
It also repairs the constrained Assistant host exposed when Flow opens beneath the default split placement (#6926):
evidence keeps readable space and the whole panel scrolls, leaving controls pointer-accessible.
Whole-file fixture integrity and existing review/permission gates remain enforced.

The generated [measurement](bundle.json) and [ratchet report](bundle-check.md)
pass all existing ceilings, including the previously approved U02 ceiling and unchanged tolerance.
No new ceiling is introduced. The local build uses the workflow’s proxy model setting;
recorded responses are intercepted, and no paid provider request is required.

Verification of this candidate’s production tree:

- Nine native/mounted viewer cases pass with no skips, including the fetched real ArchiCAD fixture.
- Root `pnpm typecheck` passes all 119 tasks, covering 3,681 test sources.
- Both recorded-provider browser journeys pass: native evidence/report/graph review and native Flow creation/preflight/debugging/tracked rerun.
- A surgical browser mutation reverses only the Assistant layout change: the one-case green baseline becomes one assertion failure at the pointer-access invariant. Restoration is verified clean.
- The canonical starter-download repair was independently verified at its unchanged prerequisite commit: 113 starter tests and a three-case native/scaffold oracle whose reverted templates produce two assertion failures.

The last change is test-only: the recipe review assertion gives the documented quota GET a controlled response while forbidding every generation request. All six recipe cases pass under the CI model setting; root typecheck passes with the correction. Its scoped [review-render mutation](clash-review-render.patch) changes six green cases into five passing and one assertion failure, with clean restoration.
The production tree is identical to `880fa7c78eb93e18e9f0e019b7a25c2881a72a34`, where the nine native cases and both local/CI browser journeys above passed. That full CI run passed every lane except the recipe test’s overbroad quota counter; the corrected head subsequently passed its complete gate: [Test 37709976561, attempt 2](https://github.com/LTplus-AG/ifc-lite/actions/runs/37709976561/attempts/2), including all eight viewer shards and 79 browser cases (41 + 38).

The [layout mutation](assistant-short-host.patch) is written broken-to-fixed for reverse application.
The oracle prints the broader branch-derived production list even with a custom patch;
the actual mutation touches only `AssistantPanel.tsx`. Browser artifacts are retained locally for review.
Passing these interaction assertions does not establish independent geometry correctness, live-provider usefulness or coordinator acceptance.

Earlier qualification at `103c37c7f19a7d8e57681e32925d5fbab7e898d7`
passed 95 viewer cases, 134 Flow cases, 159 Flow-node cases and 1,334 CLI cases (15 fixture-dependent skips).
That source includes landed P19, U03, U04 and P20 plus their recovery follow-ups.
U04’s collective production-revert proof has 19 green baseline cases and seven assertion failures;
P20’s has 17 green cases and six assertion failures. A separate P20 mutation hides only the actual native clash-review component,
turning six green cases into five passing and one failing while the recipe label remains present.
These earlier runs remain historical evidence rather than new counts for the recovery candidate.

The recovery was merged by another session as `5682fa28a422454b5e10a40c2b59a79cdff6ca7d` before that full rerun finished. Its [post-merge main Test run](https://github.com/LTplus-AG/ifc-lite/actions/runs/37710963823) passes every applicable lane, including all eight viewer shards. The three prerequisite PRs (#7073/#7077/#7078) were explicitly closed as superseded; this does not claim that they merged individually. Later main commits have separate CI verdicts and are outside this source-stamped measurement.

Exact-head CI remains a merge prerequisite for future campaign work. Independent labels, privacy/licence review,
live evaluation and coordinator/extension acceptance remain open under #6928/#6812.

Reproduce against the measured source:

```sh
VITE_LLM_FREE_MODELS=openai/gpt-4o-mini pnpm build:e2e
node scripts/perf-ratchet/measure-bundle.mjs --out /tmp/campaign-bundle.json
node scripts/perf-ratchet/perf-ratchet.mjs check --measured /tmp/campaign-bundle.json
PLAYWRIGHT_PORT=4196 E2E_GPU_STRICT=0 pnpm test:e2e:ci tests/e2e/assistant-context.e2e.spec.ts tests/e2e/flow-assistant-context.e2e.spec.ts
VITE_LLM_FREE_MODELS=openai/gpt-4o-mini PLAYWRIGHT_PORT=4196 E2E_GPU_STRICT=0 node scripts/check-test-revert-oracle.mjs --base origin/main --mutation scripts/perf/evidence/viewer-ai-campaign-6812/assistant-short-host.patch --test tests/e2e/assistant-context.e2e.spec.ts
```

Rust source is unchanged by this recovery. WASM artifacts came from the canonical build and its Turbo cache;
compressed WASM size can differ from CI as documented in the performance guide.
Raw viewer bytes carry the bundle verdict.
