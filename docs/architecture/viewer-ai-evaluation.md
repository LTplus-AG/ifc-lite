# Viewer AI evaluation corpus, live harness, labelling and study tooling

Tooling for P21 and U01 ([#6928](https://github.com/LTplus-AG/ifc-lite/issues/6928), part of [#6812](https://github.com/LTplus-AG/ifc-lite/issues/6812)). It builds the corpus and the recorded-response harness, and the opt-in live runner, with labelling and study tooling following in a stacked change. **It does not perform human judgment.** The independent claim and grouping labels, the privacy and licence review, the live quality evaluation against a provider, and the coordinator study with existing users are still open and need people. Nothing here is a quality, usability or acceptance result.

## Corpus manifest

`tests/ai-eval/manifest.json` (schema `manifest.schema.json`) is the versioned corpus: privacy policy, ten acceptance journeys, five scenes, fixtures and tasks.

| Scene | Real model and native evidence |
|---|---|
| `clash-rev-b` | Committed rev-B sample parsed natively, with the CLI clearance result (9 findings) pinned to the sample bytes |
| `validation-sample` | Committed SketchUp sample in Edit mode with a native IDS run of the committed sample IDS |
| `validation-fzk-haus` | ArchiCAD AC20-FZK-Haus (`pnpm fixtures`) against the same IDS; skipped with a stated note when not fetched |
| `authoring-sample` | The sample in Edit mode with its native load report |
| `flow-empty` | A new Flow graph validated against the standard registry |

Every fixture records origin, SHA-256, size, schema, source tool, licence status and privacy review. `node scripts/ai-eval/check-ai-eval-manifest.mjs` recomputes each committed fingerprint, cross-checks catalogued fixtures against `tests/models/manifest.json`, pins native results to the model bytes they came from, scans for e-mail addresses, credential-like tokens and STEP author/organisation fields and ties every recording to a task and scene. Gaps are printed as notes: unfetched fixtures, journeys without tasks (five of ten have none yet), licences recorded as `unrecorded` for the two SketchUp samples and the ara3d house, and **all privacy reviews pending**. The automated scan is not a privacy review.

## Recorded-response CI harness

`tests/ai-eval/recordings/*.json` holds 22 provider responses stored as SSE `data:` events: 13 release recordings and 9 negative ones, over the proxy, Anthropic and OpenAI routes. They are authored offline, say so in `provenance`, and test **IFClite behaviour on a fixed answer, never model quality**.

- The viewer suite (`apps/viewer/src/lib/assistant/ai-eval-replay.test.ts`) seeds each recording's real-model scene, serves the events to the real Assistant path (`sendAssistant`, request service, SSE client, route resolution) through a `fetch` stub, and asserts the request routing, the output ceiling, frozen evidence in the request, outcome (completed, truncated, error), usage receipt, typed-proposal classification and the native review: clash partition counts, model-change and authoring previews, Flow patch counts, report-draft citation checks. Frozen evidence must equal what the scene captures today; after an adapter or model change run `pnpm --dir apps/viewer ai-eval refresh --recordings tests/ai-eval/recordings` and review the diff.
- `node scripts/ai-eval/check-ai-eval-invariants.mjs` runs the deterministic release invariants over the same files with no viewer: release recordings must have zero violations, negative recordings must produce exactly the violations they name, and every invariant must be proven to fire by at least one negative recording.

| Invariant | Checks | Cannot see |
|---|---|---|
| `citations-valid` | Every `E<n>` names a captured row | Whether the claim it supports is true |
| `findings-accounted` | A grouping cites each finding at most once, only complete rows, within the native population | Native preview re-checks against the live result |
| `no-duplicate-topics` | No two groups share a name (case and spacing) or membership | Semantically overlapping topics |
| `count-claims-match-facts` | Each "N counted-noun" claim is a number in the evidence | A real number from the wrong field still passes |
| `no-effect-claims` | The answer never claims to have applied or created anything | Paraphrased claims |
| `proposal-kind-allowed` | A declared typed kind is offered for the evidence source | Whether the proposal is valid |
| `budget-respected` | Provider-reported output stays within the ceiling and run budget | Unreported usage is counted, never estimated |

The remaining release invariants in the plan (concurrent-edit conflicts, undo and export preservation, BCF duplicate suppression, resumed-job budgets) are covered by the owning packages' own suites and are not duplicated here.

## Live evaluation runner

`scripts/ai-eval/run-live-eval.mjs` is **opt-in and never run by CI**. It needs `IFCLITE_AI_EVAL_LIVE=1`, a provider URL and model per provider (`IFCLITE_AI_EVAL_{PROXY,ANTHROPIC,OPENAI}_{URL,MODEL}`) and, for BYOK providers, the standard key variable. A provider missing any of these is skipped with the reason. The runner:

1. asks the viewer (`pnpm --dir apps/viewer ai-eval requests`) for the exact request the Assistant would send for each task, so live runs see the production system prompt and frozen evidence;
2. sends it with fixed settings (temperature 0, the manifest's 4096-token ceiling, the manifest timeout, at most three repeats) inside the manifest's root budget (24 requests, 98,304 reported output tokens), stopping before the next request once exhausted;
3. writes unreviewed `corpus: "live"` recordings, usage receipts (provider-reported counts only; unreported usage stays unreported) and a per-answer invariant summary to the gitignored `tests/ai-eval/results/<run>/`;
4. refuses to write anything containing a credential-like token or e-mail address. The key goes into one request header and nowhere else.

Run `pnpm --dir apps/viewer ai-eval review --recordings <run>/recordings --out <run>/review.json` to judge live answers with the same native code the CI harness uses. Promoting a live recording into the corpus is a human act: review it, add `expect` from the review output, set `corpus: "release"`, and keep its receipt. **No live run has been performed for this change**: the development machine has no provider configured. The runner is tested end to end against a local OpenAI-compatible server, which proves the plumbing, not any model.

## Still open for people

- Independent claim and grouping labels and a privacy and licence review of every corpus fixture.
- A live evaluation run against a configured provider, reviewed, with promoted recordings.
- Evaluation tasks for the five journeys that have none, and a viewport screenshot for the authoring and Flow tasks.
- The coordinator study and the full-program acceptance that closes P21 and U01.
