# Viewer AI evaluation corpus, live harness, labelling and study tooling

Tooling for P21 and U01 ([#6928](https://github.com/LTplus-AG/ifc-lite/issues/6928), part of [#6812](https://github.com/LTplus-AG/ifc-lite/issues/6812)). It builds the corpus and the recorded-response harness, with the live runner, labelling and study tooling following in stacked changes. **It does not perform human judgment.** The independent claim and grouping labels, the privacy and licence review, the live quality evaluation against a provider, and the coordinator study with existing users are still open and need people. Nothing here is a quality, usability or acceptance result.

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

## Still open for people

- Independent claim and grouping labels and a privacy and licence review of every corpus fixture.
- A live evaluation against a configured provider and promotion of reviewed recordings.
- Evaluation tasks for the five journeys that have none, and a viewport screenshot for the authoring and Flow tasks.
- The coordinator study and the full-program acceptance that closes P21 and U01.
