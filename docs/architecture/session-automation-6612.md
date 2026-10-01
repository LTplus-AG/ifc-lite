# Session automation through Flow — specification for #6612

Status: implemented in the viewer; verification evidence is recorded in the
implementation plan. Source request:
[issue #6612](https://github.com/LTplus-AG/ifc-lite/issues/6612).

The [implementation plan](session-automation-6612-implementation.md) defines
code boundaries, contracts, review slices, dependencies and verification.

## Outcome and scope

A coordinator opens the web viewer in a new session, chooses a saved Flow,
selects local IFC files, reviews the enabled checks, and clicks **Run**. The
workflow loads the models, assigns model tags from filenames, runs selected
information-validation and model-comparison checks, retains their completed
reports, builds a document, and prepares its PDF. The same workflow can be
exported and used with the next delivery or in another browser.

The unit of reuse is an ordinary Flow graph. Native operations appear in the
Flow node catalogue and work in both the canvas and Player. Provide a
**Coordination startup** example with exposed inputs so a user can configure
this sequence without writing JavaScript or assembling a graph from scratch.

Confirmed product choices: offer a startup prompt for a saved workflow, and
support both rerunnable comparison recipes and imported historical comparison
reports. The prompt opens the Player; execution still requires clicking Run.
Opening a page, importing a graph, or picking files does not execute it.

In scope: local `.ifc` files, filename tagging, multiple `.rules.json` rule
sets, `.ids` validation files through the native IDS engine, comparison
recipes, existing saved-comparison JSON, document generation and PDF output.
Checks can be enabled individually, with the selection retained per workflow.

In scope also: an opt-in startup prompt pointing to one locally saved workflow.

Out of scope: unattended startup, schedules, folder watching, arbitrary disk
paths, cloud-source configuration, clash automation, new validation or diff
algorithms, automatic manual-checklist answers, and automatic publishing.
Existing Flow network connectors remain available independently.

## Existing implementation and gaps

| Area | Existing seam | Required change |
| --- | --- | --- |
| Graph execution | `packages/flow/src/scheduler.ts`; `apps/viewer/src/lib/flow/runner.ts` | Retain dependency ordering, logs, capability checks and availability reporting. |
| Player | `FlowPlayer.tsx`, `FlowPlayerField.tsx`, `player-fields.ts` | Add named multi-file slots, readiness summary, check selection and generated-artifact actions. Current file fields read one file as text. |
| Starting a run | `components/viewer/flow/useFlowRunner.ts` | Replace the blanket active-model requirement with readiness based on the graph. A load-first graph must run in an empty viewer. |
| Model ingestion | `lib/flow/open-model.ts`, `lib/sources/loadQueue.ts` | Local Files use the same queued `addModel` → `useIfcLoader.loadFile` path; avoid base64 copies for selected files. |
| Tags | `store/slices/modelTagsSlice.ts` | Match original source filenames and call existing tag actions. Add portable tag-reference mapping. |
| Information checks | `@ifc-lite/rules`; `hooks/validation/useInformationValidation.ts` | Extract shared orchestration callable by UI and Flow, retaining cancellation and immutable snapshots. |
| IDS checks | Native IDS validation and `validationReportSnapshot` | Reuse execution directly; do not convert IDS into rules and lose unsupported checks. |
| Comparison | `hooks/useCompare.ts`; `lib/compare/*` | Extract execution with explicit per-job options; add a versioned recipe contract. |
| History | `validationReportsSlice`, `savedComparisonsSlice` | Explicitly retain every completed workflow report; surface storage failures. |
| Documents | `lib/document/types.ts`, `generate-document-pdf.ts` | Bind specific job results into a document copy and use existing composition/export. |

`model.openFromSource` already opens downloaded bytes. It remains the network
source operation; local file selection calls the same host load service.

Existing saved-comparison exports are **evidence**, not executable checks:
`SavedComparison` stores the result, historical pair identifiers, scope and
limitations, but does not capture every execution option. Compare's live
JSON download is a different, plain `CompareReport` shape. Neither provides a
safe recipe to replay against a new federation.

## User journey

1. In Flow, choose **New from example → Coordination startup**, open an
   existing workflow in Player, or choose **Open workflow** in the startup prompt.
2. Choose files for named model slots, such as Architecture previous,
   Architecture current, and Structure current. Multi-model slots are allowed;
   the input list shows filename, size, slot and selection status.
3. Add rule sets, IDS files, comparison recipes and optional saved reports.
   Configure once and save, or mark a resource as **Choose each run**.
4. Review filename-to-tag rules and a table of enabled jobs. Each job shows its
   source, target selector, readiness and whether it will run or reuse evidence.
5. Click Run. Progress shows Loading, Tagging, Validation, Comparison,
   Document and PDF, with per-file and per-job details and a Cancel action.
6. Review results: **Executed** is separate from validation pass/fail or
   comparison change counts. Open the resulting reports in their native
   libraries, open the generated document in Documentation, or download PDF.
7. Save/export the Flow. On the next session, settings and embedded check
   definitions return; local model slots ask for file selection again.

An existing federation can be used through **Use loaded models**. The default
load operation adds models and never clears the viewer. Loaded models outside
the workflow's explicit target set do not participate in its checks.

### Startup prompt

In the saved workflow menu, **Offer this workflow at startup** selects one
workflow for this browser. Default is off. The preference stores the saved
workflow ID, never a working copy or run inputs. Choosing another replaces the
preference; export/import does not enable it in the destination browser.

At a new page session, after the viewer/store is ready, show a dismissible
prompt with the saved workflow name and **Open workflow**, **Not now**, and
**Don't ask at startup**. Open workflow opens the current saved version in
Player and requests its missing local files. Not now dismisses for this page
session; Don't ask clears the preference. Prompt once per page session,
including a reload, and never again on model changes or in-viewer session reset.
Opening the Player does not begin loading, tagging or generating reports.

A missing/deleted workflow clears the preference with a visible notice and
leaves normal viewer startup usable. Storage read/write failures show a warning;
the viewer remains usable and no workflow is executed. Startup prompting must
not block explicit deep-link/model-open navigation: suppress it for that page
session when an explicit startup action is present. Existing onboarding or
startup dialogs take priority; show this prompt only after they resolve, without
stacking modals. The workflow remains accessible through Flow when suppressed.

## Files, persistence and portability

Browser file access is provided by an explicit file input or drop. No disk
path, filename or saved preference grants access to local file contents.
Portable workflows contain configurations and selectors, never IFC bytes,
File objects, renderer IDs or runtime resource tokens.

Add a `files` Player input kind backed by JSON-compatible slot configuration
and a run-scoped host resource map. Its value at execution is an opaque token;
the host owns the selected File objects. Tokens cannot be forged to access
another run's resources and are released on completion/cancellation. Do not
persist them in Player values, tracking sidecars or exported Flow JSON.
Existing `file` fields retain their text-input behavior.

Adding this input kind requires Flow format version 2 and a v1→v2 migration
with unchanged behavior for existing graphs. Older readers refuse v2 clearly;
the CLI/MCP readers understand v2 structurally and report unsupported host
services before execution. Update all readers, validators and documentation
together. Ordinary scalar/list/table/any ports remain sufficient; introduce no
new value kind just to carry a host resource token or report payload.

Small check definitions and document templates may be embedded in node params
after parsing. **Choose each run** stores a slot specification instead of
content. Display which mode is saved, and require explicit replacement of an
embedded resource; changing the disk file cannot silently change a saved Flow.
Keep the existing 500,000 serialized-character graph limit and 200-graph limit.
Oversize content offers an external slot rather than truncation or a higher
limit. Historical reports default to external slots because they may be large.
Imported JSON resources are bounded to 10 MiB per file; permit at most 100
model files and 100 enabled check jobs per run. Oversize inputs fail visibly
before parsing/loading. IFC byte limits remain the canonical loader's limits.

Persist settings only through existing checked storage seams. A failed write
leaves the current configuration/result available in memory and offers export
and retry; it never claims the workflow or reports will survive reload.

## Model identity, tagging and target binding

Model selectors are portable descriptions: a named input slot, an exact source
filename, or a model-tag name. A validation target resolves to a set; a
comparison role must resolve to exactly one model. Zero matches or ambiguous
single-model roles block the job. Never pick the first model, infer the newest
revision from sorting, or use whichever model is active.

At each run, resolve selectors to current model IDs and pin source identity
and effective mutation revision. Report provenance captures the evaluated
models and actual options. Source filenames are the original File names,
including extensions, independent of later display-name edits. Filename-only
selectors with duplicate names are ambiguous; a named slot disambiguates them.

Tag rules have a filename predicate (`equals`, `contains`, `startsWith`,
`endsWith` or glob with `*` and `?`), explicit case sensitivity (default
insensitive), and one or more tag names. Match the whole basename, never a
path. No regular expressions in this increment. All matching rules contribute
tags; combine them by union. Trim and deduplicate tag names using the native
tag vocabulary's normalization. Existing tags are reused and missing names
are created. Empty predicates/tag names are rejected.

The default operation **adds** tags and preserves manual assignments. Rerun
adds nothing twice. No removal/replace mode in this scope. Unmatched filenames
produce a warning and remain unchanged; a later tag-scoped job with no targets
is blocked. Preview shows expected assignments before checks execute.

Native rule sets currently reference tag IDs (`targets.modelTagIds` and
filter `tagIds`) and may contain model fingerprints. Do not rename these APIs.
On import, collect every tag reference and require a mapping to portable tag
names; unknown IDs require user mapping. Store the map beside the original
definition. Resolve names and remap every supported tag reference in a run
copy; never mutate the original JSON. Preserve native fingerprint constraints
unless the user explicitly changes them in the editor. No stale fingerprint
may silently expand a target to all models. A job's resolved model set limits
the native evaluator's available models; native targets then refine that set.

Within entity operations, retain canonical federation ID conversion and
`resolveEntityRef`/`resolveGlobalIdFromModels` behavior, including overlay IDs
and the single-model fallback. Historical report IDs never address live meshes.

## Native node contracts

The following node IDs are proposed new APIs; `documents.*` already means
OpenCDE document access, so local report operations use `report.*`.

| Node | Inputs/configuration | Outputs and behavior |
| --- | --- | --- |
| `session.loadModels` | File-slot token, or explicit loaded-model selectors | One aggregate model-set payload with slot bindings and provenance; loads sequentially through the source queue. |
| `session.assignModelTags` | Required model-set payload; ordered filename rules | Updated model-set payload and assignment summary; completion is the barrier for tag-scoped checks. |
| `validation.runChecks` | Required model set; ordered, enabled `.rules.json`/`.ids` jobs with targets | Aggregate completed report payload keyed by stable job ID, plus pass/fail counts. Each job executes once as a whole set. |
| `comparison.runChecks` | Required model set; ordered enabled recipes | Aggregate completed comparison reports keyed by job ID and change summaries. |
| `report.importComparisons` | Selected historical report resources | Validated immutable report payload; no model load or rerun, no live selection. |
| `report.buildDocument` | Required report payloads; optional native document template | New document ID and immutable composed document; default template supports arbitrary selected jobs. |
| `report.exportPdf` | Required completed document payload | Run-scoped PDF artifact token, filename, page count and diagnostics; generates once, provides explicit Download PDF. |

Use aggregate `any/item` payloads validated at every host boundary and stable
job IDs within them, plus ordinary table outputs for summaries. Aggregate
nodes intentionally avoid per-item lacing of side effects. No node reads a
global “last result” to decide which report to save or embed.

Validation and comparison may be separate branches after tagging; the document
requires completion of every enabled branch it uses. Within each aggregate
check node, jobs run sequentially. Each completed result is retained before
the next begins. A job error fails the aggregate node, so ordinary dependency
failure propagation blocks the document/PDF. Disabled jobs are excluded from
the payload and listed as disabled in the run summary.

An IDS job targeting multiple models evaluates each independently and retains
one result per model under the job ID, preserving native per-model cardinality.
Completed reports containing evaluator errors are execution failures with
retained diagnostics; requirement failures remain quality verdicts.

The default example wires all required barriers. Native workflow nodes require
their prerequisite payloads and validate them; visual node order is never an
execution dependency. Validation failures and detected changes are valid
reports, so they do not fail the graph. Empty model targets, missing required
geometry, invalid resources and engine exceptions do fail execution.

Each operation advertises the concrete host service it needs and checks its
declared capabilities. Retain `model.create` for ingestion and `model.read`
for checks. Define scoped capabilities for tag assignment, report retention,
document creation and PDF generation in the extension grammar, shared with
the viewer host checks. These operations never imply IFC property mutation
or network access. Hosts without the services report **unavailable**, not noop.
Use existing capability scopes where possible; the implementation plan names
the storage/export targets. New capability semantics require corresponding
parser and grant tests.

## Comparison recipes and historical evidence

Add **Save comparison setup** / **Open comparison setup** beside the native
Compare controls. It produces `.comparison.json`, a versioned recipe distinct
from **Save report** and the existing CSV/JSON result downloads.

A recipe contains `kind: "ifc-lite-comparison-recipe"`, `version: 1`, stable
`id`, `name`, portable `base` and `head` selectors, and explicit `options`:
`scope` (`data`, `geometry`, `both`), `excludedTypes`, `matchByContent`,
`keyProperty` (null for GlobalId, otherwise a validated native authored-key
spec). Defaults at creation are captured, never re-read from browser
preferences during replay. Base and head cannot resolve to the same model.
IFC classes retain EXPRESS names, e.g. `IfcOpeningElement`.

Execute through the same fingerprint, effective-store, matching and diff
services as the native Compare UI, including unsaved edits. Recipes do not
capture session-only accepted/rejected identity decisions. Flow comparisons
use no such decisions by default and record that fact. Identity-map sidecars
and automatic acceptance of ambiguous matches are deferred.

Requested geometry must be available at the requested fidelity. Missing mesh
hashes or placement-only geometry block geometry/both jobs with an actionable
message; no silent data-only downgrade. Users can explicitly choose data scope.
Do not activate the comparison overlay, recolor validation results or change
selection while running a workflow; inspecting a live result is a later user
action through its native panel.

Historical import supports the existing version-1 `SavedComparison` envelope
validated by `isSavedComparison`. A plain `CompareReport` export is identified
and rejected with guidance to export from Saved comparisons; do not fabricate
missing pair identity or geometry limitations. Duplicate identical evidence is
deduplicated by source identity/content, not display name. Imported ID collisions
receive new local library IDs without altering embedded original provenance.
Historical reports retain their original timestamps/models and are visibly
marked **Imported evidence**. They can enter a document with no loaded model.
No existing export is reinterpreted as an executable recipe.

## Report and document semantics

Workflow execution explicitly requests retention of completed reports. This
is part of the workflow definition, analogous to choosing Save report; manual
validation UI behavior remains unchanged. Each report records workflow ID,
run ID, job ID, original source name, evaluated model names/source identities,
actual options, completion timestamp and limitations. Unknown source identity
remains unknown. Re-saving one result is idempotent; a new successful run is
new evidence even when its counts are unchanged.

Build a new document per run. Its default layout contains title, run summary,
model provenance, validation snapshots and comparison tables in configured job
order. Reuse native report-block layouts and PDF pagination/truncation notices.
Existing native document templates can be imported with explicitly mapped
result placeholders; reject unmapped required placeholders before generating
PDF. Work on a copy and leave the template and older documents unchanged.
Do not refresh historical blocks unless explicitly mapped to a new job result.

The document embeds report snapshots, so history deletion and future model
loads cannot alter an issued PDF. The document is available in Documentation
and can be exported through the existing native document JSON format. Reports
do not rely on the single live validation/comparison result slot.

Generate one combined PDF by default. The artifact action uses
`lib/export/download.ts` and a sanitized workflow name plus run timestamp.
Generation success means an artifact is available, not that the browser saved
it to disk. Download PDF is an explicit user action and can be retried without
rerunning checks. There is no automatic burst of separate downloads.
If native document bindings/tables/images fail, show those diagnostics and
mark the artifact **With warnings**; unresolved required result placeholders
are fatal. Any native row limit appears in preview/PDF rather than hiding rows.

## Execution, cancellation and recovery

Preflight validates the graph, host availability, capability grammar, file
slots, embedded/external resource schemas, versions, job IDs and static
configuration before side effects. Run is disabled until required selections
are ready. Dynamically resolved tags/model targets are checked after loading
and tagging, before any dependent checks. A graph consisting only of historical
evidence/document generation can run without an active model.

Run states: Ready → Running → Completed, Completed with warnings, Failed or
Cancelled. Execution errors and quality verdicts are separate throughout.
Expose phases and per-job progress in Player and the existing Flow run log.
Error messages identify the job/resource and offer a concrete correction.
Bounded/partial native results carry their diagnostics; never label them a full
pass. No performance threshold or speedup is promised by automation.

Only one native workflow run may execute in the viewer at a time. During it,
prevent conflicting model removal/replacement and manual tag/edit/check actions;
navigation and camera controls remain usable. The canonical load queue still
governs source ingestion. Capture a session/run generation and verify it before
publishing each result, history entry, document or artifact. Teardown, a new
session, graph replacement or cancellation invalidates late completions.

Cancel stops scheduling immediately, but keeps the execution lease and resources
until any non-abortable operation settles. A new run cannot start during this
drain. Completed PDF artifacts have a separate lifetime for download/retry;
temporary run resources are released when execution settles.

Cancel propagates an AbortSignal to abortable engines and checks generation
after non-abortable work returns. No later job starts, no partial result is
saved as completed, and no PDF is generated after cancellation. Previously
completed models, tag assignments and reports remain available and are listed
in the cancellation summary. Clear running/progress/resource handles in finally.

An engine error stops its aggregate stage; other already completed reports
remain reviewable. A failed history write leaves evidence in memory, gives a
warning and retry/download actions, and makes the run Completed with warnings
if document/PDF generation otherwise succeeds. It never erases existing history.
Default PDF generation is blocked after execution errors or cancellation;
manual document creation from completed reports remains available separately.

On rerun, reuse a model only when it is already bound to the same slot and its
source content identity matches the selected file; filename alone is insufficient.
Otherwise add the new model and bind the slot to it without unloading the old
one. With unavailable identity, require explicit reuse or load as a new model.
Tag union is idempotent; checks and report retention run afresh. Check results
and PDF side effects are not memo-replayed. No automatic retry of loading or
partially completed jobs. Editing definitions clears stale readiness/artifacts.

The existing Flow mutation batch applies to IFC edits. Model ingestion, tag
assignments, saved evidence, documents and downloads have their native lifecycle
and are not promised as one Ctrl+Z operation. Publish provenance must continue
to include only mutations actually captured from that run.

## Acceptance and evidence

| Scenario | Required result |
| --- | --- |
| Empty viewer | Select real IFC files and run the full example without first opening a model manually. |
| New session | Reload/import saved Flow; configurations return, local model slots require selection, stale runtime tokens/results do not return. |
| Startup prompt | Opt in, reload, open Player and choose files; no operation executes before Run. Dismissal, disabling, deleted workflow, storage failure and explicit startup navigation behave as specified. |
| Multiple files/tags | Overlapping filename rules union tags, unmatched files warn, manual tags survive, rerun does not duplicate assignments. |
| Fresh browser tag IDs | Portable tag mapping resolves all native target/filter references; unknown references block with mapping guidance. |
| Multiple validation files | Every enabled rule set/IDS source yields its own correctly scoped report; disabled jobs produce no report. |
| Native equivalence | On identical effective models/options, Flow and manual native checks agree on verdicts, diff rows/counts and limitations. |
| Comparison binding | A/B direction is preserved; renamed/missing/duplicate filenames and same-model pairs cannot silently select another model. |
| Historical JSON | Existing SavedComparison imports unchanged as evidence; plain live report JSON is explained; future versions/malformed data fail before side effects. |
| Geometry limitations | Geometry/both jobs fail clearly without full geometry; explicitly selected data-only checks still run. |
| Quality failure | A completed failed validation and a comparison with changes still enter history, document and PDF with their real verdicts. |
| Execution failure | A load/check error blocks dependent document/PDF; earlier completed results stay available and are identified. |
| Cancel/supersession | Cancel during load and checks, close graph and reset session: late work cannot publish reports/artifacts into a different run. |
| Existing history | Each run retains separate snapshots; same-result save is deduplicated; colliding imported IDs do not overwrite history. |
| PDF provenance | Open the generated PDF and verify titles, model names, original dates for imported evidence, job counts, pagination and row-limit notices. |
| Storage refusal | Workflow/history/document quota or unavailable storage is visible; current results can be downloaded/retried. |
| Host compatibility | Existing v1 graphs migrate unchanged; unsupported native operations fail availability in CLI/MCP rather than being green no-ops. |
| Federation/edit coverage | Verify one model and N models, duplicate GlobalIds across models, and effective unsaved/overlay edits. |

Use behavioral tests against exported contracts and mounted Player/native
components, not source-text assertions. Regression cases cite #6612. The
delivery evidence includes a real authoring-tool IFC delivery pair, native
manual versus Flow result comparison, a fresh-session browser recording or
screenshots, and a rendered generated PDF inspected for content and layout.
Fixtures absent locally skip with `pnpm fixtures` guidance. Identify actual
models/expected differences in the implementation PR; invented model counts
are not acceptance evidence.

## Delivery plan and completion boundary

Stack cohesive PRs against #6612 if the change exceeds the reviewable diff
budget; partial infrastructure does not close the issue.

1. Shared native execution services and comparison recipe IO, with native UI
   round-trip/equivalence coverage.
2. Flow v2 migration, multi-file Player slots, empty-session readiness, startup
   prompt, canonical local loading and portable filename tagging.
3. Native validation/comparison nodes, report import/retention, cancellation,
   explicit targeting and error propagation.
4. Document binding, PDF artifacts, the Coordination startup example and the
   real-model end-to-end evidence.

Run checks through root `pnpm typecheck` / `pnpm test` with appropriate turbo
filters, plus the applicable gates read from current workflows/rulesets. Published
Flow/rules/extension API changes need changesets and updated API snapshots.
Update Flow, validation, comparison, document and federation guides in the same
implementation PRs; regenerate API/ambient surfaces only when their sources
change. A spec-only change requires no runtime tests, changeset or API snapshot.

#6612 is complete when a saved/exported Flow handles the entire selected local
delivery-to-PDF sequence in a fresh web session, with native-equivalent checks,
portable configuration, explicit evidence provenance and the failure/cancel
behavior above demonstrated, including the opt-in startup prompt. Unattended
execution remains a separately scoped extension.
