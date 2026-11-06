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

## Round 1 independent objections and remaining static tools

Fresh Astra source review found no concrete extension identity/dispatch defects
in a086c889..9f9d29a; this is not execution or lifecycle acceptance. The author
review found four P2 issues and a P3 false-positive test: invisible class-trigger
focus, cancelled CSV drafts losing retry, removed model targets surviving in the
persistent host, pending work surviving target changes (preexisting race), and
a host-retirement test that actually unmounted the palette too.

The correction restores the actual ribbon trigger; the palette opens shared
class controls in a dialog and passes its real launcher for focus restoration.
Both editors reconcile removed targets. CSV operations belong to one open
model/data/view lifetime; retired writes and result callbacks refuse, cancelled
or failed drafts remain retryable, and already-applied batches retain undo. New
regressions pause real imports at matching/apply yields, cover replacement and
suggestion races, and retire only the host while keeping the palette mounted.
These tests remain unexecuted. Syntax and cheap guards passed.

The next serial batch adds 25 canonical entries/destinations: search and six
hierarchies, selected-entity actions, isolate, camera and view controls, element
array/move/rotate, clipboard, storey stepping and workspace exit. The selected
entity destination opens the existing menu, preserving its mutation gates and
child actions; it does not label a menu opener as a destructive action.
ui:commands is the palette itself; view:theme is equivalent to pref:theme. These
are explicit duplicate mappings, not hidden omissions. Parsed-IFC tests cover
targets, live refusal and model sessions, but have not run. Deep child traversal,
remaining destinations, full coverage reconciliation and UI acceptance are open.

## Reproducible validation entry point

From a clean committed root, admit `bash tests/ui-scenes/command-palette-access/validate-candidate.sh`
through the fleet (4 CPU, 24 GiB). It installs pinned dependencies, runs plain
root `pnpm typecheck`, builds the viewer, then runs all four viewer shards through
root `pnpm test --filter=@ifc-lite/viewer`. TEST_PATTERN is explicitly removed.
Each shard forwards TEST_SHARD/TEST_SHARDS through the committed Turbo config;
all four receipts and skip counts are required. This recipe is not a passed run.
Logs stay in the owning managed checkout until compact evidence is published
and the task is closed. Browser correctness and feature-access review follow
the build; they are not replaced by this script or the earlier UX acceptance.

## Round 1 original validation outcome and further corrections

Original foundation job `0946c2e1-c470-4e57-b850-11de05c808f2` on PC tested
`2e2c35ea00ba32715badfca7bddab391973bc5d7`: root typecheck passed (134 Turbo
tasks and the root tail; 4514 test files covered by typecheck programs). Focused
viewer tests passed 90/91, zero skips. The Russian prerequisite test called
`setLocale` before loading the catalogue, so the real locale service correctly
fell back to English. The test now awaits the actual Russian locale activator.
This correction is unexecuted, and the failed run did not reach the viewer build.
It is not full-suite or current-head certification. Compact evidence was published;
managed task closure refused because a live process or T3 task still references
output. Those references are preserved; zero bytes were reclaimed by this closure.

Fresh selected-entity/model-tool review found no concrete source defects. The
corrected author review found one further P2: a cancelled pending CSV read left
the new filename attached to the old importable content. Filename and content now
publish together only on an accepted read; older reads cannot overwrite newer
ones. Two regressions hold actual FileReader operations and verify imported IFC
property values across target changes and reversed completion order. Lightweight
guards passed; execution and fresh review remain pending.

Original combined request `auto-abb83974a2754f3fa3464c9d88b6d8f0` tests tools
head `319505f5671dc9c2e6bfc0c7bc296577d0365d18` using the committed root recipe.
It predates these corrections and the next destination batch. Preserve its
original outcome; it cannot certify later changes. No access round is accepted.

## Round 1 destination and mobile host checkpoint

The next source batch wires every Settings section; the five actual measurement
modes (Distance, Polyline, Angle, Radius, Point); separate measurement panel tabs;
six canonical Add Section choices; Search Filter/Libraries; Presentation;
basepoints; model Plan; and the conditional retained report. These use existing
controls and handlers. Panel destinations reveal/re-dock rather than toggle
themselves away. Task aliases name child controls without claiming to run them.

Mounted regressions reach real Settings controls, measurement radios/tabs, section
controls, Clear-all cancellation, Presentation controls and Plan/report bodies.
The mobile toolbar now owns the same file-command hook as the ribbon, including
its palette bridge and load listeners. The flavor dialog moved from desktop-only
StatusBar into a persistent shell host. Tests exercise synchronous mobile Open/Add
picker calls, one global event receiver and the stored-flavor flow without a
status bar. Obsolete mobile-only file-format helpers were removed; unsupported
file reporting and mixed-case LandXML acceptance remain covered.

All these runtime assertions, typecheck and browser evidence remain UNRUN. Cheap
syntax/lint/module-size/i18n/source-test/whitespace checks passed. The implementation
agent removed 42,408 bytes of its redundant edit scripts after preserving the
compact result. No original queued validation was moved or replayed. Dynamic
exporter/dock destinations, full semantic reconciliation and candidate UI evidence
remain open; this is still access round 1, not acceptance.

## Round 1 extension destinations and independent corrections

Dock contributions now have owner/slot-qualified palette destinations that open
real widget bodies in a persistent dialog, including mobile. The dock and palette
share the same widget renderer. Canonical command dispatch preserves widget
arguments into the sandbox context. Exporter rows expose owner context, share a
busy guard across surfaces and refuse retired/replaced registrations. Existing
manifest command projection already includes toolbar commands, so it is reused.

New mounted regressions cover owner/slot collisions, actual widget controls and
arguments, context loss/restoration, retirement, provider replacement, malformed
widget recovery, focus restoration and exporter lifecycle. These assertions are
UNRUN; syntax, targeted lint, module-size, i18n and source-text guards passed.

Independent Astra review of destination head `69dda602` found one P2: an old
measurement tab request replayed after remount, overriding later Point navigation.
The correction consumes pending requests once and preserves fresh explicit tab
requests. Its regression uses the actual toolbar to close, choose Point and reopen,
then invokes fresh List destinations repeatedly. The same review found the earlier
CSV target/read-generation correction addressed in source, without runtime proof.

Original validation `auto-fb8f85e8abd94a28a2234d97f1df3879`, job
`af297000-bc57-40d0-8e8d-b2ada4a8d4f7`, tested exact `69dda602` on PC. It failed
viewer test typechecking on an incomplete FileSystemFileHandle fixture; 133 other
Turbo tasks passed. Root tail, build and viewer tests were not reached. The fixture
now supplies the complete interface without a cast. Corrections were backported
into their owning hosts/destinations layers, preserving the combined source tree.
The original failure is published and retained; storage close refused live output
references, so nothing was force-deleted (0 bytes reclaimed).

Complete semantic reconciliation, blank-model/load-recovery/camera-edge routes,
combined runtime validation and candidate UI evidence remain open. This is still
access round 1, not acceptance; the independently accepted UX hillclimb is unchanged.

## Round 1 load recovery, camera and help checkpoint

New blank model now shares the welcome screen's canonical creation/load/workspace
flow through the mounted desktop/mobile file host. It refuses replacement of an
existing session, waits for its exact load target and does not enter authoring
after cancellation or host retirement. Cancel/Retry/Dismiss share the actual load
operation/error binding; an error generation distinguishes even repeated failures
with identical messages and retry callbacks.

The registry also projects the ViewCube's twelve edges and eight corners once,
using its canonical geometry and existing camera callback. Its six face presets
remain unchanged. About, What's New and Shortcuts open their actual tabs. About
also reaches the existing MCP link. Sample loading remains in its real Learn tour
flow: Get started → Load demo project; Layers tour → demo fulfilment. These are
source routes, not newly claimed browser evidence.

Mounted regressions exercise actual held load I/O, parser failure/retry, parsed
blank IFC and wall runtime, live cancellation identity, real renderer-camera
orientation and repeated help tab navigation. The Cartesian direction invariant
accounts for all twenty additional camera presets. Runtime assertions are UNRUN;
syntax (22 files), targeted lint, module-size, i18n and source-text guards passed.

Fresh Astra review of `492a635925` found a P2: overlapping commands staged args on
one activation's shared globals. Correction `aefa0ac31c` snapshots each invocation's
arguments in its own wrapper; the shared context only supplies the SDK. The new
regression drives concurrent canonical commands through one real BimSandboxHandle
and evaluates their wrappers, including concurrent/subsequent no-args calls. A fresh
narrow Astra review found no further source defect. Runtime proof remains pending.

Original validation `auto-7b80c76240734befa02b6cc41fcf29fd` / job
`3fe93140-07e3-4c54-a5e6-10a887e87844` targets `492a635925`, preceding the argument
correction and this batch. Preserve that outcome; it cannot certify these changes.
The extension PR is #8967. Full semantic reconciliation and candidate UI acceptance
remain open; this is still access round 1 of at most eight.

## Round 1 recovery review corrections and browser harness

Fresh Astra reviewed `aefa0ac31c..aec2349d0f` and found three P2 objections.
The mounted file host now distinguishes its component lifetime from callbacks
refreshed by metadata or locale. In-flight blank creation keeps its original
owner check across callback changes; a genuinely replaced/unmounted host still
cannot enter authoring. Added held real-source read regressions for locale
refresh and replacement, with actual parsed IFC and wall-command assertions.
Camera tests now use canonical ViewCube face order. The existing info-dialog
hook owns the production event receiver, so mounted palette tests exercise it
when opening, closing, alternating and reopening the actual tabs.

The georeference correction publishes the actual editor controller's capability:
projected placement works without World; rigid/angular/WKT/read-only contexts
show their real prerequisite. Source review found the earlier eligibility
mismatch addressed; runtime verification and tools-layer backport remain pending.

Eight access browser cases and six named flow captures are now authored alongside
the unchanged eleven accepted-UX cases. Discovery is not execution. Native
chooser cases cover the browser input fallback with the Chromium-only capability
absent; persistent File System Access handles require separate evidence. The
installed-extension → widget → QuickJS → renderer browser witness remains an
explicit gap. Full source-to-control reconciliation and all candidate access
browser evidence remain pending; round 1 is not accepted.

### Round 1 continuation: source corrections, not execution acceptance

The georeference capability correction now lives in the tools layer; its shared
test helper moved unchanged with it. Rebasing the later layers preserved the
complete candidate tree (`3383fcc9`), not equality between different stack layers.
Fresh Astra found the production lifetime/camera/help corrections addressed and
one remaining retirement-test setup error. That test now performs an actual
keyed React host unmount/remount during a held real load, then checks that
metadata cannot restore the retired owner or enter its wall tool.

The file/extension route audit found an ion upload eligibility mismatch. The
palette, canonical export dispatcher and upload dialog now share the same STEP
IFC candidate list. IFCX-only contexts explain the format prerequisite; adding
a supported federation member makes the real configuration flow available even
when another format is active. An excluded capture cannot be resurrected through
the legacy active-store fallback. Authored regressions parse real IFCX/STEP and
open the actual model/token dialog; they do not perform a remote upload.

These new assertions remain unexecuted. Original request
`auto-733abcb75900474aaf129393bb4e0edf` / job
`835cba3b-6fb4-4f09-88b3-0a347ca04560` is still queued for older source `8021801`;
it cannot certify these corrections. Other original requests remain preserved.

### R1 inline search and colorful theme — source candidate

U1/U2/U3 now have canonical quick-search host dispatch on desktop and mobile,
a discoverable colorful-theme toggle with live state, and native click activation
for inline controls previously bound only to mousedown. Mounted regressions cover
recents, real search scanning/cycle, stale hosts, theme parity and locale aliases.
Two browser scenarios additionally exercise actual palette close/focus, native Tab,
Space/Enter, selected-model cycling, history clearing and real Filter destination.
Cheap source guards pass; runtime/typecheck/browser execution remains UNRUN.
Fresh review and matching full validation are required; R1 is not accepted.

### R1 Assistant/Semantic/script route reconciliation

The focused 60-record audit found existing conditional child flows, not missing
capabilities. Their real panel destinations now expose task-language search terms
and localized child-path hints for conversations, preferences, proposal review,
Semantic identity/projection/workspace, and script import/export/promotion.
Conditional proposal execution still belongs to the actual reviewed flow. Ranking
regressions are authored for English, German and Russian; runtime remains UNRUN.

### R1 test repairs and updated UX integration checkpoint

Seven mounted-test files now use valid widget schemas, the actual Bim context,
canonical model pickers, real Radix tab activation, owner-qualified export labels
and the shared export lock contract. Refusal tests observe visible errors and no
publication; serial exports still assert real native model output. Static guards
pass; these repaired assertions have not run yet. Original recovery job
`835cba3b-6fb4-4f09-88b3-0a347ca04560` is running on older `8021801`; its
typecheck (134 tasks plus tail) and build (58 tasks) passed, while viewer failures
remain under investigation. It cannot certify this source.

Parent merged BCF fixture fix #8959 (`e527fe607930ef1032ceecb9fda4109e4d5ffd16`)
and updated UX #8950 to `d18ff8eac2c012e9c3d74e0adca2a2271c123805`.
The old `307fbc5` full run passed build, typecheck, all 16 viewer and 8 E2E shards,
lint and Node guards; Node shard 2 failed nine BCF fixture collisions, and the
aggregate failed. Path-gated Rust lanes skipped. That is not a full pass, and
results for the new integration head remain separate. Access R1 is unaccepted.

### R1 provisional GPU observations — older source only

On PC's real NVIDIA Blackwell adapter, all twelve fixed context captures completed
with zero scene failures and zero page errors against built source
`8021801b6bbb7a087ea5cdace71bdfb3629bb21b`. This is provisional R1 evidence,
not validation of the later integration or test repairs. The original admitted
job built this artifact; the untimed GPU helper only served and captured it.

Compared with the access baseline, Hide Selection now explains “Load a model
first” when unloaded and “Select elements in the viewer first” without selection.
It becomes available for parsed wall 262 and clicking it adds that wall to the
canonical hidden set in both themes. This is a dispatch/state witness, not an
independent GPU disappearance oracle. Undo now explains its empty workspace
history; Privacy search finds the actual Settings destination. These captures
do not execute the privacy destination or certify the other child tools.

Manifest, observations and three representative images are preserved under
`evidence/provisional-802-*`; all twelve original captures remain in coordinator
evidence for fresh Opus critique. Source reconstruction retains all 813 identities
and 3,994 anchors. The newly focused 141 records retain all 989 per-site actions;
78 component records still need focused semantic tracing. R1 remains unaccepted.
