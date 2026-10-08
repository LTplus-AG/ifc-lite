# Viewer AI campaign: recovery qualification

This is bundle and interaction qualification, not an end-to-end loading performance or live-provider quality claim.
Measured source: `880fa7c78eb93e18e9f0e019b7a25c2881a72a34`; main base:
`935c278ae535ae5f69bedb8387abfd09d50c2437`. The source is retained in
`evidence/viewer-ai-campaign-6de1b059` and proposed through [#7080](https://github.com/LTplus-AG/ifc-lite/pull/7080).

The candidate combines the canonical FZK/native-oracle/first-party starter repair
(#7073), split Assistant preflight host preservation (#7077), and current answer/source-host test contracts (#7078).
It also repairs the constrained Assistant host exposed when Flow opens beneath the default split placement (#6926):
evidence keeps readable space and the whole panel scrolls, leaving controls pointer-accessible.
Whole-file fixture integrity and existing review/permission gates remain enforced.

The generated [measurement](bundle.json) and [ratchet report](bundle-check.md)
pass all existing ceilings, including the previously approved U02 ceiling and unchanged tolerance.
No new ceiling is introduced. The local build uses the workflow’s proxy model setting;
recorded responses are intercepted, and no paid provider request is required.

Verification on this source:

- Nine native/mounted viewer cases pass with no skips, including the fetched real ArchiCAD fixture.
- Root `pnpm typecheck` passes all 119 tasks, covering 3,681 test sources.
- Both recorded-provider browser journeys pass: native evidence/report/graph review and native Flow creation/preflight/debugging/tracked rerun.
- A surgical browser mutation reverses only the Assistant layout change: the one-case green baseline becomes one assertion failure at the pointer-access invariant. Restoration is verified clean.
- The canonical starter-download repair was independently verified at its unchanged prerequisite commit: 113 starter tests and a three-case native/scaffold oracle whose reverted templates produce two assertion failures.

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

Exact-head CI remains a merge prerequisite. Independent labels, privacy/licence review,
live evaluation and coordinator/extension acceptance remain open under #6928/#6812.

Reproduce against the measured source:

```sh
VITE_LLM_FREE_MODELS=openai/gpt-4o-mini pnpm build:e2e
node scripts/perf-ratchet/measure-bundle.mjs --out /tmp/campaign-bundle.json
node scripts/perf-ratchet/perf-ratchet.mjs check --measured /tmp/campaign-bundle.json
PLAYWRIGHT_PORT=4196 E2E_GPU_STRICT=0 pnpm test:e2e:ci tests/e2e/assistant-context.e2e.spec.ts tests/e2e/flow-assistant-context.e2e.spec.ts
VITE_LLM_FREE_MODELS=openai/gpt-4o-mini PLAYWRIGHT_PORT=4196 E2E_GPU_STRICT=0 node scripts/check-test-revert-oracle.mjs --base origin/main --mutation scripts/perf/evidence/viewer-ai-campaign-6812/assistant-short-host.patch --test tests/e2e/assistant-context.e2e.spec.ts
```

Rust source is unchanged by this recovery. The final local run rebuilt WASM through the canonical script;
compressed WASM size can differ from CI as documented in the performance guide.
Raw viewer bytes carry the bundle verdict.
