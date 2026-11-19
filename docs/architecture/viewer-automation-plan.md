# Complete viewer automation through shared operations

Status: proposed follow-up plan. PR #10525 exposes existing palette entry points;
it does not implement the panel operations described here.

## Outcome and boundary

An agent should be able to discover, inspect, parameterize, run, observe and,
where supported, undo every viewer task without clicking the DOM or keeping a
parallel implementation. Opening a panel and completing its workflow are
separate operations. Interactive tools need parameterized equivalents to their
pointer gestures, not only a command to activate the tool.

“All exposed” means every registered panel and viewport tool has an inventory of
its reads, settings, actions and workflows. Each operation is either implemented
or explicitly declared unavailable with a reason and its required human action.
A file picker or host credential prompt may need human input; this must never be
reported as a completed operation. Missing entries do not count as coverage.

This plan does not authorize a second implementation project or automatic
publication. Implement the bounded phases below as separately scoped work.

## Reuse the existing sources

- Panel inventory: `apps/viewer/src/lib/panels/registry.ts`.
- Viewport tool inventory and feature gates: `apps/viewer/src/lib/features/tools.ts`
  and the store's active-tool type, including baseline tools omitted from gates.
- Navigation and command surfaces: the existing `surface-command-registry.ts`
  and runtime palette providers in `apps/viewer/src/components/viewer/`.
- Core operations: existing SDK namespaces and viewer SDK adapters. Geometry and
  IFC work stays in the existing Rust/core services, not React or the MCP layer.
- Script metadata: `packages/sandbox/src/bridge-schema.ts` already describes
  methods and semantic hints. Reconcile its overlapping schemas with operation
  contracts rather than creating a third vocabulary. Do not blindly expose all
  object methods or infer permission from a namespace name.
- Existing native transaction, review, feature, collaboration, export, network
  and file-host gates remain authoritative.

The current palette gateway remains a compatibility adapter during migration.
Delete superseded handlers when each operation family migrates. Retain an old
public command ID as a thin explicit alias only when compatibility requires it;
it must call the same operation, not a fallback implementation.

## Shared operation contract

Add a small viewer-owned, framework-independent registry of operation contracts,
with lazy implementations owned by each feature. Do not create a new public
package until another host actually needs it. A contract contains:

- Stable namespaced ID, version, panel/tool ownership, description, task tags and
  localized UI label keys. IDs are not user/model-provided method paths.
- Runtime input and output schemas, from which TypeScript types are derived.
  Reuse the project's existing schema conventions and validation utilities;
  choose one authoritative schema per operation and generate adapter views.
- Explicit effects: reads, view/selection changes, project configuration, model
  writes, artifact writes, external network and publication. Mixed-effect
  operations declare all their effects. Unknown effects are refused.
- Target model/entity references, expected model/session revision, prerequisites,
  capabilities, availability reasons and whether a real user gesture is needed.
- Preview/apply/undo support, asynchronous execution semantics, cancellation
  boundaries, concurrency policy and idempotency-key support where needed.
- A typed handler returning structured results or a job reference. A long task
  must never complete solely by returning from the function that started it.

Panel state needs schemas too: inspect configuration, apply validated settings,
read results and reset documented state. Extract behavior from React callbacks
into feature services where necessary; keep focus, layout and widget rendering
in React. The same setting/action must have one handler for UI, SDK and agent
entry points, with no second store or mutation overlay.

Panel mounting must not be required to run a domain operation. A viewer-scoped
service owns its jobs and results; panels subscribe to it. UI-only commands can
still require a current mounted host and fail explicitly when it is absent.

## Agent and UI adapters

Use a small fixed MCP surface: search/list, describe, inspect, preview, execute,
job status/cancel, and subscribe to state/job events where the transport supports
subscriptions. These are proposed interfaces, not shipped tool names. Return
only relevant schemas on discovery; use bounded pages and payloads rather than
advertising hundreds of full tool definitions on every handshake.

Execution resolves an exact registered ID and validates the arguments at runtime.
Never use eval, reflective property traversal, arbitrary imports or DOM selectors.
Discovery must not load heavy implementations, fetch remote data or mutate state.
The internal assistant and external bridge use the same operation executor.

UI controls call the shared handlers directly through typed bindings. The
palette projects available operations and opens generated forms for ordinary
schema inputs; specialist geometry editors remain custom widgets over the same
contract. Discovery identifies custom input requirements explicitly.

Separate connection from effect permission. Preserve the current bridge grant
until a deliberately versioned capability contract replaces it; do not silently
expand it again. Model editing still requires the native edit mode and role.
Publication and remote writes need their specific existing review/approval path.
Revocation prevents work that has not committed. Dispatched jobs report whether
they were cancelled, committed, or may still finish; cancelling is not rollback.

## Workflow state and results

- Use model-qualified references and the canonical federation/selection adapters.
  Capture identity and revision; reject model replacement, stale preview, stale
  job results and changed expected values instead of guessing an active model.
- Commit one logical model operation as one native transaction/undo step.
  Validate all inputs before writing. A multi-operation workflow is not atomic
  unless its backend explicitly provides that transaction boundary.
- Give jobs stable IDs, progress, structured diagnostics, result/artifact IDs and
  terminal states: succeeded, failed, cancelled or partially committed. Distinguish
  dispatched, waiting for input, running and terminal completion.
- Serialize conflicting writes per model; allow independent bounded reads.
  Specify locking/revision behavior for workflows spanning several models.
- For high-impact writes, preview yields a concrete immutable candidate and its
  revision-bound apply token. Approval authorizes that candidate, not a mutable
  future request. Repeated apply must not duplicate a committed operation.
- Files arrive through existing local/cloud source services or explicit artifact
  handles. Downloads use existing export helpers; network calls use the existing
  gated transport. Secrets remain in host credential facilities and never enter
  operation descriptors, prompts, logs or ordinary results.
- Record bounded operation IDs, outcomes and provenance. Do not dump model data,
  credentials, screenshots or arbitrary arguments into analytics/activity logs.

## Complete panel and tool inventory

This table is a migration checklist, not a claim that the operations exist today.
Derive the concrete list from controls and their underlying services in each
family; opening its panel alone cannot mark a row complete.

| Existing panels | Operations to inventory and expose |
| --- | --- |
| `hierarchy`, `properties`, `layers`, `zones` | Traverse and inspect; select, filter, isolate and hide; inspect/edit attributes, properties, classification and memberships through native transactions. |
| `model`, `placement`, `changes`, `changeSets` | Create and edit supported geometry; hosted elements; storeys, groups, constraints and joins; placement/georeferencing; inspect changes, preview/apply and native undo/redo. |
| `clash`, `validation`, `idsStudio`, `compare` | Configure checks; author/lint IDS; run/cancel; read structured findings and provenance; inspect differences; visualize results; draft/apply supported fixes and export reports. |
| `bcf`, `review`, `collab` | Topics/viewpoints, review artifacts, comments and session/role state; existing reviewed publication and remote-write workflows with explicit targets. |
| `lists`, `charts`, `gantt`, `cost` | Query/columns/grouping/filtering; chart definitions; schedule imports/dependencies/playback; cost graphs/evaluation; save configurations and export results. |
| `lens`, `appearance`, `environment` | Rules, colors/materials, visibility and lighting; inspect effective state, apply/reset overrides; solar studies and supported analysis jobs. |
| `drawing`, `measurements`, `presentation`, `document` | Generate/configure drawings; create numerical measurements; save/apply views; edit structured documents; render and export artifacts with observable completion. |
| `pointclouds`, `sources`, `loadReport`, `influx` | Source/load lifecycle; CRS/transforms and clipping/LOD controls; load diagnostics; linked time-series configuration and bounded reads; inspect supported analysis outputs. |
| `semantic`, `flow`, `script`, `extensions`, `assistant` | Linked records, graph creation/validation/run/cancel/results, script artifacts, extension capability discovery/lifecycle, assistant context/artifacts. Preserve native capability and code-execution boundaries. |

Every viewport tool also needs operation coverage: select/pick and camera
navigation; measure; section planes and boxes; annotations; walk; placement; and
all entries in `MODEL_AUTHORING_TOOLS` plus the actual active-tool union. Expose
explicit geometry, coordinate frames and units for parameterized tools. A tool
requiring a surface pick accepts a validated entity/face/point reference or
reports waiting for user input; it must not invent a click.

Include non-panel surfaces in the inventory: preferences, keyboard/palette
commands, file/export menus, contextual entity actions, tours, mobile controls,
linked-record actions and runtime extension contributions. Extensions register
versioned contracts through their existing capability host and are removed on
uninstall; unreviewed extension metadata never becomes authority to bypass gates.

## Bounded implementation phases

1. **Inventory and contracts.** Enumerate current panels, actual active tools,
   runtime providers and operation owners. Produce a machine-readable coverage
   manifest with explicit exclusions. Design the effect/capability and job
   contracts. Stop when every existing entry is classified; do not implement all
   feature adapters in this phase.
2. **One complete vertical slice.** Migrate a check workflow such as clash:
   inspect settings, configure, preview where relevant, run/cancel, read results,
   visualize and export. Make panel, palette and agent call the same handlers.
   Prove real completion and failure with in-tree IFC fixtures before generalizing.
3. **Native view and authoring.** Migrate camera/visibility/selection, numerical
   measurements, sections, annotations and authoring tools, reusing SDK adapters
   and the native transaction/review cores. Delete duplicate UI/agent handlers.
4. **Feature families.** Migrate the remaining table rows as bounded feature
   slices. For each, supply settings/read/action/job/artifact contracts, shared UI
   consumers, fixture evidence and all refusal cases before claiming coverage.
5. **Coverage enforcement and compatibility cleanup.** Wire a coverage gate into
   actual CI. Every new panel/tool/control must register operations or an explicit
   justified exclusion; missing and stale rows fail. Generate agent documentation
   and capability summaries from contracts. Remove superseded palette-only paths
   once their consumers have migrated.

Each phase ends with a concrete reviewed deliverable. This document is not an
unattended work queue, nor permission to start later phases automatically.

## Verification and acceptance

Test contracts and adapter equivalence with real feature services and in-tree
IFC fixtures. Add adversarial cases for revoked grants before commit, denied host
features/roles, wrong model/entity references, invalid schemas and units, stale
previews/jobs, replaced hosts, extension removal, duplicate requests, mixed-model
writes, partial failure, cancellation and export/network errors.

UI tests exercise actual controls and the shared operation's visible result;
agent tests exercise real MCP transport and structured results. Check that cold
connection, panel close/unmount, IME input and layout changes cannot remove
operation services or incorrectly report a workflow complete. Verify generated
forms call the same handlers as custom controls, without duplicating algorithms.

Completion requires an exact inventory with no unexplained gaps, shared production
handlers for every migrated operation, reliable result/job inspection, explicit
human-only boundaries, generated metadata without drift, and passing required
checks. Tests that merely open every panel do not establish complete automation.
