# Viewer AI evaluation corpus, live harness, labelling and study tooling

Tooling for P21 and U01 ([#6928](https://github.com/LTplus-AG/ifc-lite/issues/6928), part of [#6812](https://github.com/LTplus-AG/ifc-lite/issues/6812)). It builds the corpus, the harnesses and the instruments for human judgment. **It does not perform human judgment.** The independent claim and grouping labels, the human sign-off of the privacy and licence review, a repeatable live quality evaluation, and the coordinator study with existing users are still open and need people. The first live runs below are single samples, not a quality, usability or acceptance result.

## Corpus manifest

`tests/ai-eval/manifest.json` (schema `manifest.schema.json`) is the versioned corpus: privacy policy, ten acceptance journeys, ten scenes, fixtures and tasks.

| Scene | Real model and native evidence |
|---|---|
| `clash-rev-b` | Committed rev-B sample parsed natively, with the CLI clearance result (9 findings) pinned to the sample bytes |
| `validation-sample` | Committed SketchUp sample in Edit mode with a native IDS run of the committed sample IDS |
| `validation-fzk-haus` | ArchiCAD AC20-FZK-Haus (`pnpm fixtures`) against the same IDS; skipped with a stated note when not fetched |
| `authoring-sample` | The sample in Edit mode with its native load report |
| `flow-empty` | A new Flow graph validated against the standard registry |
| `flow-ai-paused` | Native wall classification with a bounded fixed response, review checkpoint and paused downstream application |
| `review-rev-b` | Both native clash and IDS analyses loaded; one current validation Review card pinned without a human decision |
| `lists-sample` | Native four-wall list; source Length values and absent Height cells |
| `selection-sample` | Source roof slab #425 with native attributes, property sets and quantity units |
| `document-reimported` | Native file import assigns fresh document/block identities and retains unresolved template bindings |

Every fixture records origin, SHA-256, size, schema, source tool, licence status and privacy review. `node scripts/ai-eval/check-ai-eval-manifest.mjs` recomputes each committed fingerprint, cross-checks catalogued fixtures against `tests/models/manifest.json`, pins native results to the model bytes they came from, scans for e-mail addresses, credential-like tokens and STEP author/organisation fields, ties every recording to a task and scene, requires an evaluation task and release recording for every charter journey, and validates label sheets and study records. The gate prints unfetched fixtures and **all privacy reviews pending** as notes. The SketchUp base fixture exactly matches an immutable buildingSMART Certification-datasets download under [CC BY 4.0 dataset terms](https://github.com/buildingSMART/Certification-datasets/blob/05585e04cecbc6b67d397284bbc54d9163027023/LICENSE). Its derived revision retains the publisher attribution and records the repository changes in the [SketchUp provenance receipt](https://github.com/LTplus-AG/ifc-lite/blob/main/tests/ai-eval/native/sketchup-licence-provenance.json). The ArchiCAD FZK fixture records the [KIT publisher terms](https://www.ifcwiki.org/index.php?title=KIT_IFC_Examples&oldid=552) and required publication credit, with [download and DATA fingerprints](https://github.com/LTplus-AG/ifc-lite/blob/main/tests/ai-eval/native/fzk-licence-provenance.json). The publisher download and evaluation fixture have identical DATA after CRLF-to-LF normalization; their full-file bytes differ. Recording these terms does not complete a human licence or privacy approval. The automated scan is not a privacy review.

## Recorded-response CI harness

`tests/ai-eval/recordings/*.json` holds 27 provider responses stored as SSE `data:` events: 18 release recordings and 9 negative ones, over the proxy, Anthropic and OpenAI routes. They are authored offline, say so in `provenance`, and test **IFClite behaviour on a fixed answer, never model quality**.

- The viewer suite (`apps/viewer/src/lib/assistant/ai-eval-replay.test.ts`) seeds each recording's real-model scene, serves the events to the real Assistant path (`sendAssistant`, request service, SSE client, route resolution) through a `fetch` stub, and asserts the request routing, the output ceiling, frozen evidence in the request, outcome (completed, truncated, error), usage receipt, typed-proposal classification and the native review: clash partition counts, model-change and authoring previews, Flow patch counts, report-draft citation checks. Additional scenes exercise a native classification checkpoint before writes, a current validation card in a two-analysis Review snapshot, a four-wall list with absent Height quantities, a source-identified roof selection and document file reimport with independent owned identities. The pinned Review card does not represent every finding; the document scene does not establish backup recovery. Frozen evidence must equal what the scene captures today; after an adapter or model change run `pnpm --dir apps/viewer ai-eval refresh --recordings tests/ai-eval/recordings` and review the diff.
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
2. sends it with fixed settings (temperature 0 on the direct provider routes, while the viewer proxy applies its own server-side sampling, so proxy receipts record `temperature: null`; the manifest's 4096-token ceiling, the manifest timeout, at most three repeats) inside the manifest's root budget (24 requests, 98,304 reported output tokens), stopping before the next request once exhausted;
3. writes unreviewed `corpus: "live"` recordings, usage receipts (provider-reported counts only; unreported usage stays unreported) and a per-answer invariant summary to the gitignored `tests/ai-eval/results/<run>/`;
4. refuses output containing any configured provider credential, including opaque short values, JSON Unicode escapes in error strings, and decoded SSE text split across events, before writing a recording or usage receipt. HTTP response inspection is limited to 1 MiB of body bytes; combined output inspection is limited to 32 MiB of serialized text. Quoted strings are decoded individually, without a recursive JSON object walk. These checks cover supported JSON/SSE representations; they do not certify arbitrary encodings. It also refuses generic credential-like tokens and e-mail addresses. The key goes into one request header; refusals expose only a fixed diagnostic and no response body.

Run `pnpm --dir apps/viewer ai-eval review --recordings <run>/recordings --out <run>/review.json` to judge live answers with the same native code the CI harness uses. Promoting a live recording into the corpus is a human act: review it, add `expect` from the review output, set `corpus: "release"`, and keep its receipt. A reviewed run can be kept as evidence without promoting it: copy the run folder to `tests/ai-eval/live-runs/<run>/` with its `recordings/`, `summary.json` and `review.json`. The manifest gate then requires every recording to stay `corpus: "live"` with its receipt, the summary receipts to match the recordings one for one, the review to cover exactly those recordings, every file to pass the privacy scan, and recording ids to be unique across the corpus and live runs (a promoted copy takes a new id). CI never replays these files. Recordings may be rewritten as compact JSON before committing; the events stay verbatim.

### First live runs, 15 October 2026

Three runs over all twelve tasks, committed under `tests/ai-eval/live-runs/`: two through the production free-model proxy (`https://www.ifclite.com/api/chat`, no credential) and one direct to Anthropic with a BYOK key. The proxy applies its own sampling and current Claude models take no temperature, so these are samples, not a stable quality measure. The Anthropic run used the per-provider capture from [#7649](https://github.com/LTplus-AG/ifc-lite/pull/7649); before it, every request was refused with a 400 for its temperature.

| Run | Model | Requests | Completed | Empty answer | Truncated | Invariant flags | Native refusals or conflicts | Median output tokens, completed |
|---|---|---|---|---|---|---|---|---|
| `20261015t110523` | `z-ai/glm-5.3-flash` | 24 (2 repeats) | 16 | 7 | 1 | 4 in 2 answers | 0 | 2,229 |
| `20261015t111451` | `qwen/qwen3.7-flash` | 12 | 12 | 0 | 0 | 0 | 1 | 2,028 |
| `20261015t113459` | `claude-sonnet-5-5` (direct) | 24 (2 repeats) | 24 | 0 | 0 | 1 | 3 | 1,263 |

- **glm-5.3-flash returns nothing on 7 of 24 requests.** It streams reasoning until the output ceiling and finishes with `length` before writing any answer text, so the Assistant shows an empty-output error. It hit this on `selected-roof-properties` and `validation-corrections` both times.
- **Four of the five count flags are detector false positives** ([#7652](https://github.com/LTplus-AG/ifc-lite/issues/7652)). glm's "121 elements", "13 walls" and "13 elements" (IfcWallStandardCase) and Sonnet's "arch (14 elements)" are correct: they come from the model summary in the system prompt, which `count-claims-match-facts` does not see because recordings keep only the evidence payload. glm's "~86 entities" is genuinely unsupported.
- **Native review.** Every clash grouping that parsed covered all 9 findings with no unclassified rows; every authoring proposal previewed as 1 ready operation; every Flow patch built the same 3-node graph. qwen's `validation-corrections` model-change proposal was refused at parse ("Change 2 attribute values must be text"): the native parser stopped a malformed edit before preview.
- **Sonnet's correct boolean fix previews as a conflict, both repeats.** Asked to correct the failing `IsExternal` on the plumbing wall, it proposed `expected: "false"`, `value: "true"`. The evidence row shows the current value as the text `"false"` and the prompt says `expected` must be the value shown in the evidence; the stored value is boolean `false`, so the native preview reports a conflict. Any model that follows the instructions hits this; the authored recording writes a JSON boolean, so CI never did ([#7650](https://github.com/LTplus-AG/ifc-lite/issues/7650)).
- **One Sonnet grouping was refused whole for a 103-character group name.** The parser caps names at 100 characters, which the prompt does not state; all 9 findings were otherwise grouped correctly. The second repeat passed ([#7651](https://github.com/LTplus-AG/ifc-lite/issues/7651)).
- **The direct OpenAI route has not run live.** It is tested against a local OpenAI-compatible server, which proves the plumbing, not a provider.

## Human labelling

Label units: **claims** (one verdict per sentence of a prose answer: supported, unsupported, not-factual, cannot-judge) and **grouping** (the reviewer groups the captured clash findings first, then rates each proposed group and counts the corrections the proposal needed).

```sh
node scripts/ai-eval/label.mjs sheet --recording clash-summary-release --kind claims --reviewer r01 --out sheet.json
# open scripts/ai-eval/label-tool.html in a browser, load the sheet, label it, save it
node scripts/ai-eval/label.mjs check sheet.r01.json
node scripts/ai-eval/label.mjs score a.json b.json   # Cohen's kappa (claims), adjusted Rand index (grouping)
```

Sheets can label a corpus recording or a committed live-run recording; the live ones hold what a real model answered. Completed sheets go under `tests/ai-eval/labels/` and are validated by the manifest gate: schema, a pseudonymous reviewer id, the recorded answer's SHA-256 and claim text, no negative recordings. The page keeps the model's proposal hidden until every finding has the reviewer's own group; the JSON itself still contains it, so reviewers should use the page. Scores report denominators and give no agreement figure below two completed reviewers. Kappa excludes not-factual and cannot-judge items. No sheet is committed: the labels are for people to produce.

## U01 coordinator study

`tests/ai-eval/study/protocol.json` (status **proposed**) defines twelve tasks spanning all ten charter journeys: the original discovery, evidence, clash, BCF, Flow and saved-output tasks, plus correction with concurrent conflict, native authoring/export, paused Flow AI, revision-aware review, universal analysis coverage and artifact/view restoration, three roles, the `current` and `assisted` variants, a within-subject design, the measures and time caps. Each task names the verbatim participant prompt, start state, observable success criteria and its expected entry group and workspace panels; the viewer suite checks those are real registry panels in the registry's group. `node scripts/ai-eval/study.mjs script` prints the facilitator script. Protocol validation rejects a missing charter journey before sessions can be scored. The expanded set is scheduled in counterbalanced blocks with breaks; facilitators independently prepare and verify the native inputs and oracles described in each start state. Unprepared or unavailable inputs are blocked attempts, not successes. These scripts define work still to perform, not observed end-to-end acceptance.

Facilitators write one `tests/ai-eval/study/sessions/<id>.json` per participant, task and variant (schema `session.schema.json`; participants are `p01`-style pseudonyms; the identity key stays outside the repository). `study.mjs check` validates them and `study.mjs summary` reports completion, unaided completion, median time, backtracks, panel switches and scope errors per task and variant. Thresholds are the plan's proposed pilot targets (90% unaided completion, assisted not below current, no wrong-target effects). The verdict is `insufficient-data` until every role has three participants, and `met` carries the caveat that the thresholds are not yet ratified. No sessions are committed.

## Still open for people

- Independent claim and grouping labels, ideally on the committed live answers.
- Human sign-off of the fixture privacy and licence review prepared in [`tests/ai-eval/native/fixture-review-2026-10-15.md`](https://github.com/LTplus-AG/ifc-lite/blob/main/tests/ai-eval/native/fixture-review-2026-10-15.md).
- Promoting reviewed live recordings into the release corpus.
- The twelve-task study with coordinator, author and occasional participants, and ratifying the thresholds from the pilot.
- Independent viewport acceptance for authoring and Flow; the committed native render/pick recording demonstrates ordinary rendering only.
- The full-program acceptance that closes P21 and U01.

The [native viewport capture](https://github.com/LTplus-AG/ifc-lite/blob/main/tests/ai-eval/native/viewport-2026-10-08/provenance.json) retains three screenshots and a recorded TOP-view roof pick from the shared T3 browser on a qualified production build. The committed SketchUp sample visibly renders; GPU picking identifies the same source slab (`#425`, GlobalId `12UVOn4wvAJPMUExKdZLb8`) used by the selection scene. Adapter, model and asset fingerprints are recorded. This is ordinary rendering evidence; forced device-loss recovery, fixture approvals and independent human acceptance remain pending.
