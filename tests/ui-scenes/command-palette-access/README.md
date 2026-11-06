# Complete command-palette feature access — #8947

This is a separate hillclimb from the accepted general UX in #8946 / PR #8950.
Maximum eight review rounds. No numerical taste score proves completeness.

## Goal and boundary

Every user-facing viewer feature, tool and action must be reachable by a functioning
palette action or a clearly named destination opening its real flow. Use canonical
registry actions and existing tool hosts. A destination must disclose its child
path; simply opening a parent panel does not establish access to every child.
Include ribbon, menus, panels, contextual actions, modeling, settings, exports,
extensions, runtime commands, recovery controls and keyboard-only capabilities.
Record duplicate entry points and display-only controls explicitly.

The access contract ends at real configuration/review/launch controls. It does not
require publishing remote changes or spending money to exercise every parameter.
Applicable prerequisites, cancellation and unavailable/error recovery must work.
Preserve file-picker user activation, canonical model loading and selection channels.

## Independent baseline and evidence

Accepted UX source: `9d476f01e7b2bfc1e69799d39a1b0289d6a6e2d3`, tree
`63f8396b08b2271c02364336e14f8f8acd0b41a4`. Parent branch adds documentation only.
The UX screenshots establish inherited presentation, not feature coverage.
Source preparation identified 39 registry omissions and additional modeling/subflow
gaps. All source-connected mappings start unverified until behavior is observed.
The inventory must retain source control, canonical action, palette ID, ordered
child controls, aliases, prerequisites, observation and remaining gap for each row.

Required contexts: unloaded; loaded without selection; loaded with selection.
Cross applicable rows with single/federated model, renderer/property selection,
editable/read-only role, installed/enabled/disabled/missing extension, and conditional
modules. Use real bundled IFC or parsed STEP fixtures. Explicitly mark unavailable
hardware/provider/build contexts; do not count skipped scenarios as passed.

## Frozen rubric and vetoes

1. Inventory completeness: every source capability maps or has a stated exclusion.
2. Functioning destination: exact canonical flow and named child controls are reachable.
3. Task-language search: clear aliases find the intended action without misleading labels.
4. Context truth: prerequisites and remedies remain visible and update live.
5. Keyboard and grouping: readable labels, discoverable disabled rows, stable focus/selection.
6. UX preservation: accepted #8946 interactions and layout remain intact.

Missing capability, broken destination, silent no-op, stale eligibility execution,
file-picker activation loss or accepted-UX regression veto completion. Fresh Opus
judges taste, Astra reviews reasoning, Codex implements. No competing source writers.
Each round records source, changes, independent objections, test receipts, visual
and behavioral evidence, accept/reject decision and remaining gaps separately.

| Round | Status | Changes / hypothesis | Evidence / verdict |
| --- | --- | --- | --- |
| 1 | Implementation in progress | Unified static projection, visible availability and canonical destinations close omissions | Baseline inventory reconciliation and behavioral evidence pending; no acceptance |

Implementation batches inside a round are not separate acceptance rounds. Keep
reviewable PR layers for #8947 if the implementation exceeds roughly 1500 lines.
Release requires full root Turbo coverage, real UI evidence, post-commit pre-handoff,
required CI and resolved reviews. Mergify only, after base is main. Parent handles
watching and production verification; never claim a merge is a deployment.

## Reproducible context captures

`capture-contexts.mjs` extends the existing real-model GPU capture protocol. Freeze
its six scenes for this campaign and run them against both accepted baseline and
candidate artifacts, in light and dark. The selected fixture is an actual parsed
wall from `/samples/building-architecture.ifc`; setup uses the canonical renderer
selection action. The execution scene clicks the actual Hide Selection option and
requires that the selected wall enters the renderer hidden set before capture.
Other scenes record command labels, availability, selection and context without
asserting that a known baseline omission is correct. Observations are not coverage
credit for unvisited child tools.

```sh
~/build-workers/ifc-gpu-check --limit 10 -- bash -c '
  node tests/ui-scenes/command-palette-access/capture-contexts.mjs \
    --dist "$PALETTE_DIST" --out "$PALETTE_EVIDENCE" --label "$PALETTE_SOURCE" \
    --scenes access-unloaded-hide,access-loaded-hide,access-selected-hide,access-selected-hide-run,access-history,access-settings-privacy \
    --themes light,dark --cdp "$IFC_GPU_CDP_URL"
'
```

Set the three `PALETTE_*` variables to the exact-tree verified built artifact,
owned evidence directory and source identity; export them for the runner. This
is bounded correctness evidence, not a performance benchmark. The helper closes
its own pages and preview server. Preserve `context-observations.json`, image
hashes and `manifest.json`; record failures and never count absent captures as a
pass. Release regenerable downloads after their evidence and all uses settle.

## Baseline observations (accepted UX source, separate access judgment)

Twelve captures passed on the matching `9d476f01` artifact, using the real NVIDIA
GPU and public IFC fixture; zero scene failures or page errors. The same action
shows **Hide Selection enabled with no explanation** both unloaded and loaded
without selection. Selecting the parsed wall (global ID 262 in this single-model
fixture) then clicking Hide Selection actually hides it in both themes. This
working route must survive the new eligibility layer.

Searching `undo` returns unrelated commands, with no Undo destination. Searching
`privacy` returns anonymized export, with no Settings privacy destination. These
are observed access gaps, not failures of the already accepted general UX scope.
Raw observation `theme: null` means the light theme's absent HTML class; the
manifest explicitly identifies light/dark for every capture.

![Unloaded selection action lacks a reason](evidence/baseline-access-unloaded-hide.light.png)
![Real selected wall and Hide command](evidence/baseline-access-selected-hide.dark.png)
![After canonical Hide execution](evidence/baseline-access-selected-hide-run.dark.png)
![Undo query has no Undo action](evidence/baseline-access-history.light.png)
![Privacy query misses Settings](evidence/baseline-access-settings-privacy.light.png)

[Recorded contexts and outcomes](evidence/baseline-context-observations.json) and
[exact-artifact capture manifest](evidence/baseline-manifest.json) retain the facts.
No candidate access verdict has been issued yet.

## Round 1 foundation checkpoint

One static projection now receives the complete command context. Palette-only
availability keeps blocked rows discoverable with translated reasons and known
toggle state. Activation checks current prerequisites both on input and inside
the deferred frame before recording usage or telemetry. Renderer scalar Hide
selection remains supported; workspace target resolution is shared with entry.
No missing callback-only command is exposed before its real host is wired.

Seven mounted interaction regressions and registered-row metadata coverage were
added; composition/export/i18n expectations were updated. Focused lint, module
size, i18n-literal, source-test and whitespace guards passed. Tests and typecheck
were **not executed**: the root Turbo dry run confirmed selector forwarding but
requires 58 missing dependency builds. An accidentally started unused-locals
compiler check was aborted by its owner, with no verdict claimed; its own process
tree and 2,447,178 bytes of generated files were retired.

Next: admitted root validation, then real file/activity and author/filter hosts,
canonical omitted actions, modeling/subflows and runtime owners. This checkpoint
is neither complete feature access nor a round-1 acceptance verdict.

## Round 1 independent foundation review (pending correction validation)

A fresh Astra review of `307fbc5..2e2c35e` found three P2 refusal-boundary
gaps: an existing storey can still have an unusable drawing plane; Push/Pull
requires the scalar renderer selection as well as the property reference; and a
deferred export can retain an old model runner after the active model changes.
These are blocking objections for this foundation, not an access acceptance.
Corrections and parsed-fixture mounted regressions are included in the foundation
review-fix commit. Their behavior has not yet been executed.

Draft PR #8956 targets `feat/command-palette`. Its review-signal reports 49
missing lanes because the full test workflow only runs for base `main`; adding
`ci:full` does not change that trigger. A draft-skipped bot has supplied no
review verdict. Neither condition is counted as success. Keep the stack intact
until #8950 lands, then retarget and run the full graph. Original admitted fleet
request `auto-aa39caddc30843a5bdc17dc42199a0cb` remains the validation request for
`2e2c35e`; no replacement or duplicate request was submitted. Later corrections
require their own matching-source validation before release.

Parent reported full UX-head `307fbc5` run `42130748653` completed with Build,
Typecheck, all 16 viewer shards, all 8 E2E shards, lint, Node guards, provenance,
revert oracle and performance ratchet passing. Node shard 2/4 failed nine BCF
fixture tests, and its dependent aggregate failed; Rust/path-gated lanes skipped
as configured. This is not a full-CI pass. Separate test-only repair PR #8959
and its original admitted validation are parent-owned; UX head remains frozen.

## Round 1 mounted file/activity host checkpoint

The Ribbon-owned file hook now publishes one typed, identity-checked host.
Palette Open/Add invoke the real picker synchronously; Refresh requires live
handles for every loaded model; Share opens the existing persistent dialog.
Activity uses the real tray dialog outside the closing palette. Open/Add/recent
files share the cached WebGPU prerequisite. Recent cache miss/error recovery no
longer attempts a picker after an asynchronous cache read. Eight mounted host
regressions cover these paths; their runtime assertions are still unverified.

Focused lint and module-size/source-text/i18n/whitespace guards passed. The root
Turbo dry run selected the intended tests but found 58 missing dependency builds,
so it was not counted as execution. The host implementer removed its own 44,204
bytes of redundant scratch; no active jobs, source, fixtures or evidence were
removed. Author dialogs and class filtering remain for the next serial batch.

## Round 1 author/class host checkpoint and host review

Persistent hosts now share Bulk Property Editor, CSV Data Connector and class
visibility controls between ribbon and palette. Workspace Undo/Redo uses the
existing history resolver. Eight mounted tests cover real editor bodies, CSV
input/mapping, draft preservation after ribbon unmount/cancel, class settings,
host/role/model refusal, and mutation followed by workspace history replay.
The tests are added but not yet executed; existing standalone editor regressions
and asynchronous cancellation need matching-source validation too. Cheap lint,
syntax, module-size, source-text and i18n guards passed. No feature-access verdict.

Fresh Astra review of `2e2c35e..efdcf49` found the three foundation objections
resolved in source. It found one P2 in the new Activity host: both it and the
existing desktop/mobile entry point announced the same completed job. The
correction keeps the new dialog persistent with announcements disabled there;
two composed-shell regressions require exactly one completion live region.
These assertions also await execution.

The source reconciliation retains all 624 component records, 3,994 anchors and
189 indirect/display records. Some remaining handler chains are explicitly
unresolved, and candidate behavior coverage is still pending. Source accounting
is not a completeness verdict. The author-host implementer reclaimed 2,297,930
bytes of its own redundant dry-run and verbose guard output, retaining compact
receipts and preserving source, fixtures, evidence and foreign jobs.

## Round 1 extension-command checkpoint

All manifest commands already enter the canonical command slot. Palette rows now
use an encoded owner/command tuple, show the owner and search the description and
category. Ambiguous legacy recent IDs are not assigned to an arbitrary owner.
Palette, toolbar and keyboard dispatch once through the canonical host; they no
longer pre-fire the activation event. Live checks reject removed/replaced slots
and a replaced React host before command usage or telemetry is recorded.

New unit and mounted regressions exercise colliding command names, owner routing,
real wrapped fixture handlers, stale contributions/providers, asynchronous error
feedback and toolbar/keyboard placement rules. Runtime assertions and typecheck
remain unexecuted pending dependency builds; no coverage acceptance is claimed.
The runtime implementer reclaimed 2,239,988 bytes of redundant dry-run output,
retaining its compact receipt. Original queued validation requests are preserved.
