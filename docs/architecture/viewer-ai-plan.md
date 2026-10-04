# IFClite viewer AI implementation plan

This plan covers AI throughout the web viewer: contextual assistance, Flow authoring and AI execution, clash classification, IDS and information validation, BCF batches, analysis narratives, search and visualization, reviewed model corrections, semantic records, cross-analysis coordination, and reusable automation. Every feature is in scope. Delivery waves express dependencies; the final waves are required parts of the program.

The intended product outcome is that a user can ask about model evidence, inspect it, prepare a native action, and reuse the resulting workflow on the next delivery. The program includes a complete rethink of shared interaction patterns, implemented incrementally within a recognizable viewer layout and the current visual style. AI produces editable IFClite artifacts. Existing domain engines remain authoritative for geometry, quantities, validation, matching, and export.

Status: proposed implementation design. Existing foundations below were inspected in this checkout. New contracts, names, limits, and release criteria are proposed decisions, not implemented behavior or measured performance. “Batch creation” covers both BCF topics and reviewed model corrections.

## Existing foundations and implementation boundaries

| Foundation | Existing source | Planned use |
|---|---|---|
| Chat, script edits and repair | [ChatPanel](../../apps/viewer/src/components/viewer/ChatPanel.tsx), [LLM services](../../apps/viewer/src/lib/llm/) | Extract common request and transcript services; keep script editing as a context adapter |
| Model context and canonical prompt guidance | [Context builder](../../apps/viewer/src/lib/llm/context-builder.ts), [system prompt](../../apps/viewer/src/lib/llm/system-prompt.ts) | Replace broad automatic scans with task retrieval; retain schema-derived capability guidance |
| Provider transport, BYOK and proxy usage | [Stream client](../../apps/viewer/src/lib/llm/stream-client.ts), [direct streaming](../../apps/viewer/src/lib/llm/stream-direct.ts) | Shared request lifecycle, budgets and capability negotiation |
| Flow graph, scheduler and registry | [Flow runtime](../../packages/flow/src/), [standard registry](../../packages/flow-nodes/src/index.ts), [editor operations](../../apps/viewer/src/lib/flow/editor-ops.ts) | Validated graph patches and host-provided AI nodes |
| Session checks and document automation | [Automation host](../../apps/viewer/src/lib/flow/automation-host.ts), [host contracts](../../packages/flow-nodes/src/session-contracts.ts) | Reuse checks, native report tokens, document preparation and cancellation |
| Clash grouping and durable review | [Grouping](../../packages/clash/src/grouping.ts), [clash guide](../guide/clash-detection.md) | Enrich deterministic candidates, attach classifications, preserve review state |
| Validation evidence and retained reports | [Saved report slice](../../apps/viewer/src/store/slices/validationReportsSlice.ts), [IDS guide](../guide/ids.md) | Typed evidence retrieval, explanations and report snapshots |
| Documents and PDF composition | [Document implementation](../../apps/viewer/src/lib/document/), [guide](../guide/documents.md) | Native narrative blocks with embedded source evidence |
| BCF local and server operations | [BCF package](../../packages/bcf/), [server service](../../apps/viewer/src/services/bcf-server.ts), [Flow nodes](../../packages/flow-nodes/src/bcf-nodes.ts) | Reviewed topic batches, durable reconciliation and publication receipts |
| Model edits and change sets | [Change set actions](../../apps/viewer/src/lib/change-sets/change-set-actions.ts), [mutations guide](../guide/mutations.md) | Native preview, grouped undo and IFC export |
| Semantic data and revision associations | [Linked records guide](../guide/semantic-pilot.md), [profile guide](../guide/semantic-profiles.md) | Bounded queries, source mappings and reviewed projections |
| Storage and reusable customization | [Content libraries](../../apps/viewer/src/lib/storage/content-library.ts), [extensions](../guide/extensions.md), [flavors](../guide/flavors.md) | Persist assistant artifacts using existing concurrency and save receipts |

Important boundaries discovered during inspection:

- Model context currently counts entities and supplies a small selection sample. It is not a complete analysis retrieval interface.
- Flow already executes BCF server writes and session report automation. Extend these paths; do not introduce a competing publication or check pipeline.
- `groupClashes` does not carry storey enrichment and currently degrades storey grouping to rule grouping. Resolve actual metadata before offering storey classification.
- Native saved reports preserve evidence separately from current scene selection. AI must preserve that distinction.
- Keyboard dispatch is not a general domain command executor. Action adapters must call existing viewer services and SDK operations, not synthesize keyboard events.
- Standard CLI/MCP Flow hosts do not currently expose viewer session automation. Each new host feature must report its actual availability.

### Current panel inventory

The inspected workspace registry contains 31 panel IDs. The following map accounts for each; P01 verifies each subtool and result API rather than discovering the program scope from scratch. Preserve the current Author task group as well as Coordinate, Check, Quantify, Automate and Site; the user guide's abbreviated group list is not the registry contract. The first ten registry entries define shipped Alt+digit shortcuts and must not be reordered.

| Current panel IDs | AI and shared UI integration | Native boundary |
|---|---|---|
| `hierarchy`, `properties` | Selection explanations, source/type inheritance, query navigation | Canonical effective entity reads and scene selection |
| `sources`, `layers` | Source/revision mapping, layer change explanations, retrieval diagnostics | Existing provider grants and layer provenance |
| `zones`, `placement` | Zone criteria drafts, spatial assignment/placement proposals, coordinate explanations | Existing zone/placement editors, reference frames and permissions |
| `loadReport` | Explain parser/geometry diagnostics and coverage; include in delivery reports | Original load diagnostics, not an inferred successful load |
| `compare`, `changes`, `changeSets` | Revision summaries, change-set review and impact links | Native diff, mutation journal and export receipts |
| `bcf`, `validation`, `clash` | Findings, explanations, grouping, topic batches and reports | Native validators, detector, review keys and BCF services |
| `lens`, `lists`, `charts` | Natural-language filters, editable visual/table artifacts and narratives | Shared filter engine and native aggregation |
| `measurements`, `cost`, `gantt` | Quantity/unit/rate/schedule explanations, mapping drafts and reports | Actual measurements, rates, schedule inputs and source limitations |
| `script`, `flow`, `extensions` | Script/graph help, AI execution, Plan Card and reusable tools | Existing sandbox, Flow registry and extension capabilities |
| `document`, `presentation` | Evidence-linked report composition and coordination presentation drafts | Native document/export and saved-view presentation services |
| `appearance`, `environment`, `pointclouds`, `drawing` | Display/view drafts and source/solar/drawing/scan explanations; report available results | Existing rendering settings and actual calculated/recorded outputs |
| `model` | Native authoring drafts, parameter validation, review and batch execution | Existing modeling commands and canonical element builders |
| `semantic` | Read queries, profile mapping, source-linked findings and reviewed projections | Existing record validation, revision association and endpoint grants |
| `collab` | Artifact sharing/review coordination and permission explanations | Current Session capabilities; private chat does not become shared automatically |

Every actual sub-analysis within a panel gets an inventory row listing source API, evidence shape, completeness, exact available actions, narrative embedding, host availability and acceptance fixture. A setting-only surface exposes settings and recorded outcomes without inventing analytical results. Unsupported domain operations remain visible and are refused before effects.

## Product behavior

Use one Assistant shell, provider configuration, task lifecycle and artifact renderer. A conversation is attached to a task and explicit context, such as a graph, analysis run, document, selection, or review workspace. The shell can dock beside Flow or an analysis panel. Switching panels exposes a suggested new scope; it never changes a pending proposal's target.

The composer shows compact scope controls: source, models and revisions, selected or filtered population, completeness, and attached evidence. A viewport screenshot is optional. Selection and screenshot changes do not automatically upload content.

Provide entry actions in native panels: Ask about selection, Explain result, Suggest groups, Draft issues, Summarize report, Build Flow, and Review delivery. Users can perform the same tasks through chat. Every artifact has native editing controls so another prompt is optional.

| Interaction | Execution policy | Completion result |
|---|---|---|
| Explain, retrieve, aggregate | Execute under current read grants and data policy | Answer with inspectable evidence |
| Select, isolate, frame, section, colorize | Apply on explicit user request; retain view restoration | Native scene state and visible result count |
| Draft filter, chart, check, document, graph or issue batch | Create editable draft; save through existing libraries when requested | Native artifact with save state |
| Apply model corrections | Preview changes, check current revision and permissions, apply reviewed subset | Native change set and one grouped undo |
| Run a Flow | Use graph grants and preflight; preview writes or use an explicitly authorized policy | Run log, artifacts and write accounting |
| Publish or update external BCF topics | Preview concrete server effects and use existing project authorization | Durable receipts and partial-success status |

Existing script auto-execute settings remain scoped to scripts. They do not silently authorize Flow execution, model corrections or external issue publication. A user may authorize a named workflow policy for subsequent runs; authorization is scoped to target project, effects and limits and is invalidated by a material capability change.

Keyboard access, focus restoration, screen-reader labels, restrained stream announcements, high contrast and locale capture are required for every assistant surface. Generated text can use a different chosen language from the UI. Source values retain their original spelling.

## Unified viewer UI

The redesign applies to the whole product. A new chat dock beside independently designed panels would leave users managing disconnected model scopes, run states, report libraries and action menus. Unify the navigation, task context, result review and artifact editing first, then expose AI through those same surfaces.

Existing useful foundations include [ViewerLayout](../../apps/viewer/src/components/viewer/ViewerLayout.tsx), [panel registry](../../apps/viewer/src/lib/panels/registry.ts), [SidebarPanelHost](../../apps/viewer/src/components/viewer/sidebar/SidebarPanelHost.tsx), [BottomStrip](../../apps/viewer/src/components/viewer/BottomStrip.tsx) and [extension slots](ai-customization/03-ui-surface.md). Existing task groups already span coordination, checks, quantification, automation and site tools. Reuse their capabilities and extension contracts while revising how users reach them.

### Layout alternatives

| Direction | Main organization | AI location | Strength | Main design risk |
|---|---|---|---|---|
| A Unified studio | Persistent feature navigation; dockable editors and model view | Shared inspector tab/contextual actions | Familiar to technical users; flexible simultaneous tools | Panel density and user-managed layout can still fragment a review task |
| B Task workbench | Task navigation, selected working artifact, model/evidence split, shared inspector | Contextual actions and inspector assistant; expandable conversation | Keeps checking, triage, issues and reporting connected; supports expert editors | Requires clear ownership of scope and careful migration of tool discovery |
| C Conversation workspace | Task conversation with persistent artifacts and model attached | Primary conversation surface | Low initial navigation burden; expressive multi-step requests | Precision, discoverability, long transcripts and slower repetitive manual operations |

Selected direction after user clarification: A with B's shared task context and review patterns, introduced incrementally. Keep the recognizable ribbon, activity rail, dock/split behavior, model viewport, bottom editors and visual tokens. First unify scope, result headers, evidence/action controls, libraries and assistant behavior inside those surfaces. Add a coordinator review workbench as a native panel/layout preset once the shared patterns work. B and C remain evaluated design alternatives, not required replacement shells. No layout requires AI to load, inspect, check or edit native artifacts.

Avoid optimizing the default around provider selection or prompt entry. The persistent task and evidence should be visible when AI is closed. In any layout, a reviewed artifact remains accessible outside its transcript.

### Navigation and product vocabulary

Explore, Review, Quantify, Author, Automate and Deliver are proposed workflow categories for testing. Retain the current Coordinate, Check, Quantify, Automate, Site and Author groups initially; expose delivery capabilities through existing ribbon/panel entry points. Rename or regroup only where task testing supports it and after checking keyboard/deep-link compatibility. A coordinator preset chooses visible shortcuts; Browse tools always exposes every available capability.

| Destination | Working artifacts | Tools and feature families |
|---|---|---|
| Explore | Model selection, collections, views and linked records | Hierarchy, properties, sources, zones, placement, sectioning, scan/site/environment |
| Review | Check definitions, runs, findings, comparisons, review cards and topics | IDS/information/manual/semantic validation, clashes, duplicates, changes and BCF |
| Quantify | Lists, charts, quantity/cost outputs and schedules | Measurements, takeoffs, table mapping, rates and time-based review |
| Author | Native changes and modeling/drawing artifacts | Existing modeling, placement, IFC data edits, drawings and annotations |
| Automate | Flow graphs, scripts and reusable tools | Player, execution logs, extensions and Ideas |
| Deliver | Documents, reviewed issue batches and export packages | Report composition, PDF/BCF/model export and publication |

Use current ribbon/status/command surfaces for project/session identity, loaded model/revision selection, command/search, editing permission and job activity. Add compact scope controls where missing instead of replacing the application chrome. These are global controls; local filter and run actions belong to the working artifact. Do not merge file identity, revision identity and active-model selection into one ambiguous picker.

Keep the viewer's existing user-facing terms Collection, Session and Profile. A check is a definition; a run is an execution; a finding is one recorded result; a review group is an organization of findings; a topic is a coordination issue; a document is a deliverable. The UI explains these distinctions through labels and source captions rather than technical IDs.

Unify command discovery around one registry of descriptions, availability, native action and effect metadata. Existing keyboard registrations remain the keyboard entry point, with bindings to the same native services. Palette searches distinguish Open tool, Run command, Find model elements and Ask assistant. A natural-language phrase may suggest alternatives; an ordinary command search never unexpectedly uploads model content.

### Workbench anatomy

The unified interaction model has five regions, mapped onto existing hosts rather than forced into a new five-column shell:

1. Global navigation and scope in the application chrome.
2. A collapsible task outline showing relevant artifacts and libraries.
3. A main stage containing the model, an artifact editor, or a split of the two.
4. A shared result tray for the current artifact/run, expandable into the stage.
5. A contextual inspector for evidence, actions and the task's assistant conversation.

Keep current saved panel dimensions and design tokens. A contextual assistant can use the existing side dock/split/floating host; opening it must not unexpectedly replace evidence the user is reviewing. Test an evidence/assistant tab and existing stacked split as alternatives, with explicit user control. At widths below the measured stage minimum, use the current responsive sheet pattern; never shrink the model and table into unusable columns. Model, artifact and results can each use existing maximize/focus behavior.

Use one task breadcrumb and source caption across regions. Table rows, selected 3D elements and inspector content share a selection controller with clear distinctions between highlighted, selected and included in a batch. Closing the inspector must not reset selection or cancel a completed draft. Escape follows existing command-layer semantics and does not become an ambiguous cancel-all shortcut.

Wide tables, Flow graphs, scripts, drawings and documents get full-width native editors. They can show a secondary model/evidence pane and the same assistant inspector. The result tray is not a mandatory permanent strip underneath every editor.

### Shared result and review system

Use a common ResultView composition for all analyses: source/scope header, completion and coverage, native summary, filters, rows/groups, evidence details and action bar. The composition accepts typed per-analysis columns and renderers; it does not flatten every result into a generic pass/fail table.

| Shared pattern | Required behavior |
|---|---|
| Definition and execution | Check definition, last run and saved history are distinct selectable objects |
| Scope control | Show selected/filtered/all population and models; pin proposal scope at creation |
| Summary | Display original engine counts, units and incompleteness beside explanatory text |
| Row/group selection | Support multi-select, native keyboard behavior and exact included/excluded population |
| Evidence inspection | Show underlying values, 3D targets when valid and historical source when not live |
| Review decisions | Preserve human status/comments separately from AI suggestion and engine outcome |
| Actions | Explain, inspect, group, draft topics, export, add to document and save workflow |
| Empty/error state | Distinguish no applicable population, no findings, failed run, unsupported and partial |
| History | Select recorded runs without silently rerunning or applying historical scene IDs |

Review opens a unified findings queue with facets for evidence kind, run, model/revision, check, status, discipline, storey and responsibility when present. A user can inspect each native run independently. Cross-analysis cards are an additional reviewed view of those findings, with original evidence one click away. Unique entities, findings, groups and topics are labeled separately in all totals.

Bulk action bars name the scope: “Draft topics from 3 selected groups” or “Apply 18 reviewed changes.” Changing a filter never silently changes an already prepared batch. “Select all” must say whether it means the loaded page or the entire matching population and retrieve authoritative IDs before enabling a complete-population action.

### Shared artifact editing

Introduce a working artifact header with name, source scope, revision/save state, native actions, assistant entry and activity. The editable object is always the artifact, not a copy held only in a chat message. Proposal cards open a native preview; accepted proposals update that artifact through native operations.

Use shared libraries with type-specific views for checks, reports, topics, documents, Flows, scripts, lists, lenses and profiles. Cross-links connect a definition to runs, a finding to a topic, and a report to its document. A library search can span types, while authoring and validation remain type-specific. Deleting an object previews dependent references and follows its established embed/reference policy.

Combine user-initiated job activity into one tray: parsing/geometry, checks, exports, AI requests, Flow runs and publication. Each job exposes phase, cancellation semantics, budget where relevant and durable outcome. A job source opens the correct artifact. Persistent outbox work survives reload; ephemeral running jobs return as interrupted, not magically completed.

Status presentation uses consistent copy: Draft, Ready to review, Applying, Applied, Partial, Stale and Failed for proposals, plus the native analysis outcomes. Icons and labels accompany color. Avoid a universal score that conflates data quality, compliance, uncertainty and coordination priority.

### End to end UI journeys

Delivery review: open Review → choose model revisions and checks → run → inspect the unified findings queue → ask for explanations → review groups/cross-analysis cards → draft a topic batch → move to Deliver with the same evidence → compose/report/publish. The task retains scope, decisions and source links throughout.

Flow: open Automate → choose graph → stage shows canvas and Player/log tabs → assistant inspects selected nodes → preview patch highlights changes → apply to graph → preflight/run → a review checkpoint shows the actual proposal artifact → resume from its digest. Run effects link back to Review and Deliver artifacts.

Everyday inspection: open Explore → search/filter → selected element appears in the inspector → ask about its source/properties → save selection as a collection/list/lens → use Quantify for a table/chart. The same population remains visibly scoped.

Batch correction: open a finding/table → choose Prepare corrections → reviewed differences replace the result stage → inspector shows source evidence → conflicts are excluded or resolved explicitly → apply native batch → changed validation results appear as a new run, linked to the change set.

### Responsive behavior and collaboration

Provisional device scope includes full desktop authoring, tablet review and narrow-screen inspection/triage. Desktop-only editing capabilities remain discoverable with a truthful layout/device explanation. Do not promise complete Flow/drawing authoring on a phone without a tested interaction design. User constraints may expand this scope.

At narrow widths, task outline becomes a menu, one stage is visible, and evidence/assistant open as a sheet with an explicit return target. Model selection, result selection, scope and drafts persist when switching views. Tables offer essential-column views and row details. Touch targets, on-screen keyboard and pinch/navigation are tested against existing presets.

Shared Sessions retain current collaboration permission checks. Personal conversations and preferences stay personal by default; a user explicitly shares an artifact/proposal and its approved evidence. Shared artifacts carry revision conflict behavior. Presence or a team member's selection never retargets another person's pending action. Confirm which native libraries can be session-shared during the inventory, rather than assuming all browser-local state becomes collaborative.

### Design validation and migration

Build representative prototypes of A/B/C over the same illustrative delivery task. Test finding a check, tracing a failure to 3D evidence, reviewing a group, drafting a BCF batch, authoring a Flow and locating its saved output. Measure manual and AI-assisted versions. Test with coordinator, author and occasional-viewer participants; prototypes have labeled sample data and make no behavior/performance claims.

Before selecting the default, record task completion, navigation backtracking, scope errors, accidental effects, discoverability, required panel switches and time with the model obscured. Inspect large-table and long-conversation states. Test keyboard and narrow layouts alongside desktop. Compare against the current viewer rather than assuming a redesign improves every task.

Implement shared components panel by panel and preserve stable panel/command IDs, saved artifacts, profiles, extension slots, shortcuts and deep links. Changes to persisted layouts use versioned migrations with preview/reset where necessary. Rollback of an optional coordinator layout preset does not delete data. Avoid a parallel replacement shell; if a component needs a temporary migration path, use an explicit tracking issue and removal condition and delete it once acceptance passes.

Unify result/tool headers and library behavior before porting all panels to the new shell. Host extension contributions render in mapped slots, with unknown/unsupported placements visibly handled. Profile imports retain data and explain migrated layout choices. AI can propose native views but cannot generate arbitrary application chrome or rearrange the user's workspace without an explicit action.

### Confirmed UI decisions

The user confirmed a recognizable current layout with incremental panel unification, BIM coordinators as the first audience, contextual AI that opens when needed, both BCF and model/data edit batches, and the current visual style. Use current typography, colors, spacing, icons and interaction conventions. Device/collaboration scope follows the existing web viewer with responsive inspection/review and current Session permissions; no new cloud project service is assumed. These constraints supersede the earlier provisional recommendation for a replacement task shell.

## Shared contracts and ownership

Start browser orchestration in small modules under `apps/viewer/src/lib/ai/`, transport reuse under `lib/llm/`, native adapters beside their owning feature, and UI under `components/viewer/assistant/`. Keep each production module within repository size rules.

Introduce a published `@ifc-lite/ai` package only when the Flow and MCP consumers need the same contract. Its initial responsibility is provider-independent requests, budgets, structured artifacts and receipts; it must not depend on React, Zustand or viewer stores. Give it its own dependencies, README, tests, changeset and API snapshot. Cross-analysis review stays viewer-local until a real headless consumer exists.

| Proposed record | Required information | Identity and lifecycle |
|---|---|---|
| Context snapshot | Task, source artifact and version, model fingerprints, effective mutation revisions, filters, selection scope, locale | Frozen per request; explicit recapture |
| Evidence reference | Native result kind, run/report ID, row/check ID, source models, scope and completeness | Immutable native evidence; imported references validated |
| Entity address | Source model identity and revision, IFC `GlobalId` when present, validated live address when available | Missing or duplicate IDs remain explicit; runtime IDs never become durable keys |
| Aggregate fact | Metric, value, unit, denominator, population/filter digest, contributing evidence | Calculated locally; LLM references fact ID |
| Proposal | Kind, schema version, base revision, evidence IDs, validated operation payload, effects and capability requirements | Draft → valid → reviewed → applied; also stale, refused or cancelled |
| AI execution receipt | Provider/model, contract/prompt versions, input digest, output artifact digest, usage, timestamps, finish reason and diagnostics | Redacted metadata; actual versus estimated usage distinguished |
| Human decision | Actor when actually known, time, source scope, decision and changed fields | Separate from AI suggestion and detection verdict |

Derived collections use descriptive names. IFC attributes and entity names use exact EXPRESS names. The proposal protocol does not introduce aliases for `GlobalId`, `Name`, `IfcRelAggregates` or other canonical names.

Entity resolution uses existing canonical model and mutation adapters. Runtime global IDs resolve through `resolveEntityRef` and `resolveGlobalIdFromModels`; scene conversion uses the FederationRegistry where appropriate. Persistent evidence combines source identity and revision with the file identity, not offset arithmetic. Test single-model, federation, reused GlobalIds, authored overlay entities, absent IDs, duplicate occurrences and reloads.

### Request and proposal lifecycle

1. Capture explicit context and approved data categories; calculate local facts and candidate populations.
2. Retrieve bounded details with recorded offsets, limits and coverage. Refuse unsupported source requests visibly.
3. Reserve a request budget and build schema-derived guidance; treat model/document text as quoted data.
4. Stream explanation for display. An incomplete JSON stream never enables Apply.
5. Validate the completed structured artifact, referenced IDs, limits, capability requirements and base revisions.
6. Allow a bounded repair only for schema/contract failure. Return diagnostics if repair fails.
7. Review native previews where effects require it, then revalidate immediately before commit.
8. Execute through native services and record receipts. A model swap, changed target or lost permission invalidates pending effects.

Request states are preparing, retrieving, generating, validating, ready, applying, complete, partial, cancelled and failed. Proposal state and request state are distinct. Cancellation stops queued work, aborts in-flight transport and prevents late completion from updating the current task. It does not imply an already committed external write was undone.

Review authorizes a complete effect manifest: target identities/revisions, expected old values, operations and grant scope. Its digest covers that manifest and the proposal evidence. Recheck authorization, permissions and expected values inside the native commit boundary, not only before entering it. For multiple independent stores/models, advertise atomicity only if the actual native transaction provides it; otherwise expose coordinated partial commits, receipts and recovery. Grouped undo alone is not proof of atomic commit.

Retrieved IFC text, source documents, OCR, tool responses and imported artifacts cannot authorize tools, expand retrieval scope, choose publication destinations or request secrets. Deterministic orchestration owns those decisions. Quoted instructions remain data even when they claim to come from the user. Derive action previews from validated native payloads, not persuasive generated text. Adversarial source fixtures must attempt these exact boundary crossings.

Choose the request contract before the model call. Prefer native structured output when supported; otherwise parse a strict JSON envelope and validate it locally. Report model incompatibility before spending on an unsupported modality. Invalid or truncated output cannot be promoted to executable code as a fallback.

### Retrieval and supported evidence

Each adapter exposes describeScope, aggregate, pageRows, getEvidence and resolveLiveTargets operations. These are proposed contract roles, not new public API names yet. Retrieval uses existing indices and cached entity getters; no re-parsing source buffers inside entity loops.

| Evidence family | Exact facts available to AI | Limits retained |
|---|---|---|
| Clash and duplicates | Rule, pair identities, distance provenance, bounds, severity, review status, enriched metadata | Candidate caps, unavailable geometry/metadata, estimate versus mesh result |
| IDS and information checks | Applicability, requirement, actual values, cardinality, severity, outcomes | Requirement checks versus entity–specification results; capped or unevaluable reports |
| Manual checks | Recorded decision, comment, guidance, checked population | Unchecked stays unchecked; suggestions never become automatic pass |
| Model comparison | Matched changes, source revisions, excluded classes, matching/geometry capabilities | Ambiguous matches and missing geometry fingerprints |
| Lists and charts | Native filters, rows, grouping and aggregation facts | Missing values, displayed row limits and actual denominators |
| Quantities and cost | Quantity source, unit, rate source and computed totals | Missing rates, absent quantities and supplied assumptions |
| Solar, drawings, measurements and other analyses | Existing computed result and tool-specific options | Accuracy, coverage and unsupported outputs exposed by that tool |
| Semantic records | Source records, queries, profiles, revision links and validation findings | Partial SELECT views, missing associations, unsupported profile features |
| Flow execution | Node graph, inputs/outputs, lane diagnostics, host availability and write accounting | Host-only services, cancellation and partial effects |

The inventory work package must enumerate every analysis surface and implement a summarizable adapter for each one. A surface with no reliable result API gets an explicit unavailable contract and a scoped adapter task before program completion; it is not silently omitted.

## Budgeting and provider behavior

All entry points share a job budget covering requests, input/output tokens, deadline, retrieved rows, bytes and concurrency. Hosted accounting is enforced at the proxy; BYOK budgets are enforced by the local coordinator plus provider output ceilings. Estimates and incomplete provider usage remain labeled. Credentials never enter artifacts, prompts, content logs or Flow files.

Proposed initial interactive defaults: at most 6 provider requests per job, 24,000 estimated cumulative input tokens, 8,000 cumulative generated output tokens, 120 seconds, 200 detailed rows per retrieval page, 1 MiB of textual context, and 2 concurrent requests. Reserve input and maximum output before dispatch. A repair spends the same pool. Users can raise limits explicitly; a budget exhaustion retains a partial draft with coverage and offers a bounded continuation.

Batch analysis and Flow use preflight estimates and separately authorized job budgets. They do not inherit unlimited list lacing. Partition locally, preserve coverage and checkpoint each completed chunk. Provider retries are bounded, honor retry timing, and never auto-retry a publication action. Actual reasoning tokens count wherever the provider exposes them; if the provider cannot enforce or account for the requested ceiling, report the limitation and use conservative request reservations.

A root operation owns the cumulative budget across child requests, repair, retries, pagination, Flow lanes, chunks and resumes. Continuation does not reset the pool. Persist reservations and usage reconciliations with the operation; uncertain billed usage keeps its reservation until reconciled. An explicit budget increase records the new ceiling and authorization. Also cap visited rows/entities, result bytes and deterministic work so a cheap provider request cannot initiate an unbounded local scan. Define separate per-run and per-root caps for workflows intentionally scheduled or rerun; a new user execution is a new root, not an automatic continuation.

No automatic expensive escalation to another model. Model selection is capability-driven and configurable; higher capacity is offered with a visible estimate. Standard compute, graph authoring and result interpretation have separate presets without duplicating provider connections.

Cache identity includes input evidence, effective model revisions, filters, contract/prompt versions, model settings and data policy. Sampling results are recorded but not promised deterministic. Explicitly retained accepted artifacts can be replayed without a provider request. Normal Flow memoization never hides a fresh AI request behind an unchanged node value.

## Feature specifications

### Flow assistant and execution nodes

The Flow chat receives the graph revision, selected subgraph, registry descriptors, Player fields, capability grants, execution log and representative lane values. Create, explain, edit, debug, expose inputs and convert script operations to standard nodes are supported.

Use structured graph edits with expected base revision and semantic checks. Preserve IDs, tracking keys, Player bindings and graph ownership unless the proposed edit explicitly changes them. Show additions/removals and inferred capabilities. A stale edit regenerates against the current graph; it never overwrites a user's concurrent change. Removing tracked creation nodes explains the next-run orphan cleanup effects.

Add a host AI service to Flow rather than direct provider calls inside standard nodes. Proposed node family:

| Node | Input | Output and execution |
|---|---|---|
| `ai.classify` | Whole table or finding collection, versioned category definitions | Table of allowed labels, evidence IDs and unknown outcomes; bounded batch requests |
| `ai.summarize` | Evidence and computed fact references, audience and language | Structured narrative sections with citations |
| `ai.extract` | Supplied text passages and bounded schema | Typed candidate records with source spans and unsupported items |
| `ai.propose` | Findings plus allowlisted artifact kind and constraints | Validated drafts; no model writes or publication |

These names are proposals and require registry/API review. AI nodes are volatile for fresh execution. Add explicit replay of a retained artifact as a distinct mode with source digest verification. The registry and host expose availability for text, images and structured outputs, not a blanket browser-only flag.

Capabilities cover actual provider data transfer and secret use through the existing extension grammar; extend its catalogue only where necessary. Ports use native Table/group/item structures and existing opaque report handles where appropriate. Configure list/group access intentionally, with a whole-run request cap protecting lifting and cross lacing.

Provide a review checkpoint execution contract: a batch run may pause with draft artifacts, preserve completed node receipts, and resume downstream effects only when the same evidence and permissions still hold. CLI can emit the proposal bundle and resume with an explicit reviewed bundle; MCP returns the pending artifact and requires a separate authorized apply call. Browser checkpoints use the same artifact digest. Cancelling does not roll back completed external effects; native mutation runs retain grouped undo and existing write accounting.

Persist checkpoint states prepared, reviewed, applying, partially committed and completed. Claim execution ownership with the store's compare-and-swap revision transaction, per-effect identity and a recoverable lease. A second tab/process/resume cannot concurrently consume the same reviewed artifact. AI evaluation identity and effect execution identity are distinct: volatile node reevaluation creates a new proposal and never replays already committed downstream effects.

Do not keep mutation batches or locks open across a paused review. Split native writes into committed execution segments with explicit undo groups and receipts. Before resume, validate graph/prompt versions, source digests, grants and model revisions; if any relevant source changed, reprepare the remaining proposal and require renewed review. Headless checkpoint bundles contain portable values and durable evidence, not viewer-only opaque in-memory tokens; hosts lacking a portable service reject preflight. Crash tests cover before/after claiming, persisting intents, native commit, remote dispatch, saving receipts and releasing ownership. An ambiguous external effect blocks resumed downstream publication until reconciled.

Acceptance: author and execute a real-fixture validation/report graph, repair a broken typed edge, refuse stale patches, preserve tracking across edits, run AI batches with bounded lifting, replay without network, cancel mid-run, and pause/resume the same reviewed artifact in viewer and a headless host. Unavailable host services must fail preflight explicitly.

### Clash grouping and classification

Enrich clashes once per run with storeys, systems, model/discipline tags, related hosts, type identifiers and stable pair keys. Missing metadata stays absent. Existing geometry remains untouched.

Compute candidate groups by existing cluster/rule/type-pair/shared-element strategies and reliable enriched keys. AI labels and proposes bounded merges/splits with exact member IDs. Structural validation requires complete accounting for source findings; accepted overlap is represented explicitly rather than silently duplicating totals. A merge is suggested coordination intent, not proof of root cause.

Use a versioned project taxonomy: routing conflict, penetration coordination, equipment clearance, possible duplicate, possible intended connection, data issue and unknown. The project can edit it. Self-reported confidence is not a calibrated probability; show evidence sufficiency and unknown outcomes. Do not suppress or accept clashes automatically.

The panel supports candidate preview, representative evidence, per-member inspection, split/merge, bulk decisions and “use this policy for the rest.” Classification receipts are separate from detection and human review state. On rerun, preserve decisions by canonical durable identity; propose reconciliation where group membership changes.

Acceptance: coordinator-labeled real exports including repeated routes and adjacent unrelated conflicts; all findings accounted for; no review lost after regroup/reload; absent storey metadata reported; group labels do not change issue identity.

### IDS and information validation

Explain a failure using the actual applicability, requirement, expected condition, actual/missing value, unit and entity reference. Locally aggregate recurring patterns by requirement, type, model and storey. Hypothesized exporter causes are explicitly suggestions.

Conversational authoring emits native check drafts. Parse requirement documents into source-linked candidates; classify each as IDS, information rule, geometry/other analysis, manual review or unresolved. Run the native IDS audit/rule validation before enabling Save. Preview applicability and detect zero evaluated population. Preserve unsupported statements as unresolved requirements instead of dropping them.

Check edits create or edit the intended library entry using its revision. Renamed property suggestions resolve against the real model and canonical dictionary sources. A proposed new requirement does not rewrite a completed report's verdict. Cross-check comparisons require the same check version and compatible population, or display the scope differences.

Acceptance: real IDS/rule runs with missing values, inherited type properties, SI/model units, empty populations, cardinality failures, warnings, capped reports, edited overlays and multiple models. The assistant never conflates requirement percentages with entity pass rates.

### BCF batch drafting and publication

Create a draft batch from clashes, IDS, information/manual/semantic validation, comparisons, or a cross-analysis review selection. Each topic retains exact source findings and source revision. Draft title, description, labels, priority, proposed assignee and viewpoints. Assignees resolve from project/server mappings, never invented names.

Preview grouping, included members, excluded findings and proposed existing-topic updates. Allow native edits, merge/split, language changes and one topic per source group. Generate viewpoints through existing framing/export code; classify world versus viewer coordinates correctly. A historical topic can cite evidence without pretending its entities exist in the live scene.

Maintain a versioned reconciliation mapping from project, source lineage and finding membership to topic identity. Use existing durable clash keys where applicable. Group membership changes produce explicit split/merge reconciliation proposals. Cross-revision matching uses validated native correspondences; same names or AI similarity alone do not update a topic. Retain original topic GUIDs, comments and human field ownership.

Local BCF creation and archive export use the existing package. Connected publication uses existing server clients and actual supported topic/status/priority vocabularies. Persist an outbox intent before dispatch and receipts after each topic, viewpoint and comment effect. Recheck the remote version where the server exposes it; otherwise refresh and surface field conflicts.

A timed-out write with unknown outcome must be reconciled before retry. Use client GUID or server idempotency only when supported. If server capabilities cannot identify the original write, mark it unknown and require resolution instead of blind retry. Treat topic and viewpoint publication as separate receipted effects; report a created topic with failed viewpoint attachment truthfully.

Unknown outcome is a durable blocking state keyed by connector identity, project, exact payload digest, effect and correlation identifiers. Reconciliation records server receipt/lookup evidence of committed, authoritative evidence of not committed, or still indeterminate. Manual review may attach evidence but cannot waive an indeterminate outcome into a blind resend. Uncertain matching by title/time is not proof. Optimistic concurrency applies to updates where supported; otherwise refresh/compare owned fields and return a review conflict. The same safeguards apply to existing Flow BCF write nodes used by assistant workflows.

Acceptance: create→export→reimport, same-batch rerun without duplicate creation, topic update preserving comments, group split/merge, stale remote edits, invalid server vocabulary, permission loss, abort, offline retry and timeout after a server commit. Real server evidence is required for claims about connected behavior.

### Narratives and report documents

Use a structured outline with sections for summary, findings, changes, suggested actions and coverage. Narrative facts reference local fact IDs; entity examples reference evidence IDs. Source figures are rendered from facts so the model cannot silently rewrite values. Unsupported prose claims remain labeled interpretations or are refused.

A resolvable citation does not establish that a sentence is supported. Facts include typed population, aggregation method, units and provenance; templates render deterministic claims directly from them. Separate free-text interpretations and causal hypotheses from verified observations. Validate scope/metric compatibility for deterministic claims, and evaluate semantic support of free-text claims against independently reviewed evidence. Preserve the distinction in preview and PDF; never label all cited prose verified.

Provide audience/language presets and native editing. Add a versioned narrative document block with embedded source snapshot, citations, generation receipt and human edit state. Preserve original generated text where needed for review without exposing private prompt material. Saved documents remain readable after report library deletion; deletion of a shared external chart source keeps its existing unavailable behavior.

Refresh creates a new narrative revision from explicitly selected evidence. It retains human edits as a visible reconciliation choice. A document can mix historical and current evidence only with separate captions; no combined compliance claim is inferred.

Support executive reports, discipline action reports, delivery reports, revision summaries and coordination agendas over every registered analysis adapter. Render using the existing document and PDF pipeline, preserving native warnings, row-limit notices, captured locale and source identity.

Acceptance: every factual claim resolves to included evidence, all totals match native facts, known omissions remain visible, source deletion/reload preserves embedded reports, long multilingual narratives render legibly, PDF contains the same source values as preview, and refresh cannot silently erase edits.

### Search, navigation, lists, lenses and charts

Natural-language selection creates editable native filter groups using model-discovered property names and canonical classes. “Visible,” “selected,” “this model” and federation scope have explicit meanings. Queries requiring unsupported joins return an explanation and a supported alternative; they never produce a broader approximation silently.

Save selection criteria as a list or lens. Chart proposals identify source, dimensions, metric, unit and denominator, then use existing aggregation. A shared model schema index is revision-aware and built locally, not sent wholesale every turn.

Scene actions use select/isolate/frame/section/colorize/restore services. Capture the prior view for restoration and preserve existing visibility channels. “This area” may use a screenshot plus selected/camera context, but distances and geometry facts always come from tools. Users can inspect the exact matching population before a bulk effect.

Acceptance: queries over actual one-model and federated fixtures, ambiguous property names, derived/inherited values, empty results, native filter edits, revision invalidation, color/visibility restoration, keyboard use and charts with missing values and explicit denominators.

### Model comparison and cross-analysis review

Comparison explanations preserve native matching, excluded classes and geometry limitations. Never promote an ambiguous content match through AI. Explain changed elements and prepare impact candidates by linking authoritative current findings to valid native correspondences.

Add a local review workspace containing evidence links and proposed coordination cards. Join by validated source identities, revisions, correspondences and relationships. One current equipment item can link a geometry change, new clearance finding, missing data and existing BCF topic. Spatial proximity and textual similarity may propose a link but require review before treating it as shared identity.

The workspace shows new, persistent, changed, no-longer-observed and not-evaluated findings. Absence becomes a resolution candidate only when the relevant check ran completely over a compatible population. It never automatically closes accepted or open topics. Partial analysis remains not evaluated for unseen findings.

A review card has a scope, exact findings, explanation, human decision, proposed action and receipts. Suggested responsibility follows project mappings. Support triage, current 3D inspection, historical evidence inspection, BCF batch creation, report preparation and saving the full delivery review as a Flow.

Acceptance: two real revision pairs with intentional changes; reused GlobalIds across models; incomplete later analysis; changed rule versions; an existing topic linked to multiple evidence types; no double counting of unique entities; manual unlinking and reconciliation after new runs.

### Data mapping and batch corrections

Support approved value dictionaries, whitespace/naming cleanup, classification mappings, supplied spreadsheet values, verified semantic projections and explicit unit mappings. Show entity, exact property/attribute, old and new typed value, unit, source evidence, conflicts and skipped rows.

Reuse existing row matching and mutation transactions. Ambiguous matches remain unresolved; unknown design/performance values become information requests. Apply uses base model/effective revision plus expected old values, rechecked inside commit. Default native corrections are atomic within a verified native transaction domain; across independent domains expose coordinated partial commits with receipts and recovery. An explicit “skip conflicts” preview must show exclusions before applying the remaining valid subset.

The change set is undoable as a batch and export uses the existing IFC path. Rerun affected checks and report actual outcome changes. Undo/redo invalidates derived AI artifacts and check freshness. Do not hold a model write lock while waiting for a provider.

Acceptance: real spreadsheet/model matching including duplicate keys, typed parse errors, units, concurrent edits, partial selection, storage refusal, undo/redo, IFC export/reparse and validation rerun. Reference mapping and before/after source evidence accompany the demonstration.

### Native model authoring and geometry edits

The user confirmed all supported native creation, deletion, placement, relationship and geometry operations, as well as property/data corrections, with reviewed previews and undo. The full native operation matrix is required scope; no new geometry algorithms are implied. Unsupported operations remain explicit and never become generated low-level patches.

| Operation family | Proposal and native preview | Required validation |
|---|---|---|
| Create supported elements | Existing canonical builder parameters, target storey/model, position and quantities | Builder limits, units, IFC class, valid container, tracked identity and exported representation |
| Delete elements | Exact targets, owned children/relationships, shared dependencies and exclusions | Referential integrity, ownership, protected/shared items and removal accounting |
| Move/rotate/copy and placement | Native transform or workspace placement with its declared frame | IFC Z-up/viewer Y-up conversion, georeferencing, source units and copy identity |
| Existing split/join/trim/extend or parametric edits | Only operations exposed by real native command/SDK capabilities | Native geometry constraints, remesh outcome and canonical geometry path |
| Assign type/storey/group or edit relationships | Existing authorized relationships and exact IFC names | Schema, compatible endpoints, cycle/ownership guards and native support |
| Change attributes/properties/classifications | Typed old/new values and approved source mapping | Native mutation constraints, expected old values and scope |

Use ghost geometry or existing command previews, plus a differences table and write accounting. Keep draft authoring out of the live store until the native tool's reviewed commit. Apply and undo go through existing native editors/builders; no second geometry/load pipeline and no hand-written STEP surgery. Follow-up checks use the resulting effective model revision. Structural design intent and missing dimensions require supplied requirements; the assistant may propose questions without inventing a compliant design.

Acceptance: real-model create, transform, copy and delete through supported native tools; shared dependencies; invalid placement/unit/parameter refusal; geometry preview matching committed output; one/N-model targets; overlay entity resolution; undo/redo; IFC export/reparse; and relevant check rerun. Any Rust/geometry changes needed to expose an existing operation inherit performance, parity and determinism requirements.

### Semantic records and requirement extraction

Generate bounded read queries and mapping drafts from supplied profile definitions and source records. Keep JSON Schema, SHACL, dictionary and native IFC validation distinct. Query partiality cannot establish completeness of an endpoint.

Use existing endpoint grants, transport limits, SPARQL restrictions, source provenance and revision associations. AI cannot add hostname grants, execute SPARQL UPDATE, resolve ambiguous revisions or turn an external evidence URL into verified evidence without retrieval. Retrieved passages have source IDs and spans; unsupported OCR/scanned inputs use a declared modality/ingestion adapter and visible extraction limits.

Preview semantic-to-IFC projections through the existing projection service. Include field mapping, unit conversion, prior/new value and conflict policy. Saved mappings retain profile/source versions; restored credentials and model associations follow current native rules.

Acceptance: existing semantic pilot plus an independently supplied record set; shared batch product versus installations; missing/reused GlobalIds; partial queries; malformed or adversarial record text; unit conversions; projection undo and revision reassociation.

### Onboarding, diagnostics and reusable tools

Provide task recipes for delivery review, clash coordination, requirement checking, quantity review and handover data. Their steps are backed by available native commands and feature descriptors, not invented panel controls. Diagnose empty checks, missing model bindings, graph failures and unavailable host services with actual error evidence.

Extend the existing Ideas/pattern miner and Plan Card rather than adding another activity collector. Save successful filters, grouping policies, report presets, check definitions and graphs through their native libraries. Tool promotion uses existing extension authoring contracts and capability review.

Persist stable preferences separately from project mappings and one-run facts. A grouping preference can be reused; acceptance decisions, required fire ratings and assignees remain scoped evidence. Existing privacy-safe telemetry remains content-free; model names, IDs, prompts and report prose must not enter product analytics.

Acceptance: save→reload→rerun each native artifact, restore an exported customization bundle without credentials, preserve authoring permissions, avoid duplicate miner suggestions and adapt onboarding to actual host availability.

## Persistence and migration

Use existing IndexedDB content-library patterns for tasks, proposal bundles, AI receipts, review workspaces, grouping policies and BCF outbox records. Large native reports remain in existing stores; immutable issued artifacts embed the minimal evidence needed to remain readable. Use explicit reference/deletion policies to prevent accidental loss of audit evidence.

Version every exported artifact. Imports validate shape, depth, item count, bytes and references; use existing duplicate/concurrency handling. UI must distinguish memory-only drafts, saving, saved, conflicts and refused storage. Multi-tab edits compare revisions; no last-writer overwrite of a reviewed proposal.

Old script transcripts remain readable. Add context kinds without interpreting old executable code blocks as new typed proposals. Move common services out of ChatPanel incrementally, keeping behavior tests green, and delete replaced branches in the same change. Temporary migration paths require the repository removal condition and tracking issue.

Document format changes go through its migration and validator. Keep original report evidence immutable. Export/import bundles contain no provider credentials or automatic network authorization. On reload, revalidate live model associations and publication permissions.

## Delivery work packages

Each row becomes a scoped feature issue with a completion charter. Dependency IDs below are planning IDs, not GitHub issue numbers. Stack PRs against one issue where necessary to keep reviewable diffs; do not put the whole program in one PR. Planning is authorized here; this document does not create or label external issues.

| ID | Deliverable and implementation homes | Depends on | Required completion evidence |
|---|---|---|---|
| P01 | Inventory all analysis surfaces, native commands, host features and evidence contracts; `lib/ai/adapters` and feature owners | None | Complete inventory and adapter gap list; no silently omitted analysis |
| P02 | Shared request service, provider capability negotiation, usage/budget enforcement; `lib/llm`, proxy consumer and later shared AI package | None | Cancel/timeout/truncation/budget tests and actual provider usage receipts |
| P03 | Versioned context, evidence, facts and identity resolution; `lib/ai/context`, existing model/report adapters | P01 | One/N models, overlays, duplicate/missing GlobalIds, historical sources |
| P04 | Typed proposal validation and native action execution; `lib/ai/proposals`, SDK and feature adapters | P02, P03 | Denied effects, stale revisions, unknown references and native execution |
| P05 | Assistant shell, scoped conversations and artifact controls; shared viewer components/store | P04 | Mounted interaction tests, a11y, i18n and script migration evidence |
| P06 | Artifact/content persistence, export/import and multi-tab conflict handling | P03, P04 | Save refusal, reload, corrupted/oversized import and concurrent edit tests |
| P07 | Validation explanation and conversational rule/IDS/document authoring | P05, P06 | Source-linked real model/check runs and unresolved requirement retention |
| P08 | Universal narrative generation and native document/PDF blocks | P01, P05, P06 | Evidence coverage for every adapter; multilingual preview/PDF verification |
| P09 | Flow chat creation/edit/debug with registry-derived contract | P05, P06 | Executable real-fixture graphs and stale/tracking edit regressions |
| P10 | Deterministic clash enrichment, candidate groups and AI classification | P03, P05, P06 | Labeled real clash runs, full membership accounting and review continuity |
| P11 | Local BCF drafts, review controls and topic reconciliation mapping | P07, P08, P10 | Roundtrip archives and revision/split/merge behavior |
| P12 | BCF outbox, connected publication, conflicts and uncertain outcomes | P11 | Actual server create/update/timeout recovery and no duplicate retry |
| P13 | Natural-language filters, lists, lenses and charts | P05, P06 | Native artifact edits and real query/aggregate correctness |
| P14 | Scene navigation, selection/screenshot grounding and restoration | P05, P13 | Real viewer inspection, coordinate correctness and visibility restoration |
| P15 | Reviewed table/dictionary corrections and validation rerun | P04, P07, P13 | Atomic conflict behavior, undo/redo, export/reparse and changed check verdicts |
| P15A | Supported native model authoring proposals, geometry preview and operation matrix | P04, P06, P14, P15 | Referential integrity, native command preview/commit, units/frames, undo and export/reparse |
| P16 | Semantic query/mapping/projection assistance and source extraction | P04, P06, P07 | Revision-aware pilot plus independent records and source-span evidence |
| P17 | Native comparison explanations and compatible run reconciliation | P03, P05, P06 | Real revision pairs, matching limitations and incompatible scopes |
| P18 | Cross-analysis review workspace and unified coordination cards | P07, P10, P11, P16, P17 | Multi-source current/historical review and partial-run non-resolution |
| P19 | Shared AI package, Flow AI host/nodes and reviewed pause/resume | P02, P04, P06, P08, P09, P11 | Bounded lacing, replay, viewer/headless checkpoint parity and host preflight |
| P20 | Save-to-Flow, reusable tools/preferences, Ideas integration and task onboarding | P09, P13, P15, P15A, P18, P19 | Export/reload/rerun, project-scoped memory and full delivery workflow |
| P21 | Continuous evaluation corpus, release telemetry and full-program acceptance | Starts with P01; closes after all feature/UI packages | Independent real-model evidence, human-reviewed judgments and all journeys below |
| U01 | Recognizable studio prototype with task-context variants, complete capability/navigation mapping and coordinator preset design | P01; confirmed user constraints | Same real tasks compared with current shell; current style/layout retained |
| U02 | Shared artifact headers, ResultView, scope/selection controls, libraries and activity tray | P03, P04, U01 | Accurate native summaries, selection/scope tests, all analysis result views mapped |
| U03 | Incremental existing-shell integration, coordinator review preset and shared assistant/evidence inspector | P05, P06, U02 | Recognizable layout/style, full task navigation, keyboard/i18n/a11y and narrow layouts |
| U04 | Panel/profile/extension/deep-link migration, Session behavior and removal of replaced components | U03, P18, P19, P20 | Artifact compatibility, migrated placements, permission/concurrency behavior and rollback |

Presentation ownership: U02 owns ResultView, artifact headers, common scope/selection controls, library composition and activity tray. P05 owns assistant conversation/request UI and typed proposal renderers, using U02 components where shared. U03 only composes these into existing hosts and the coordinator preset. P05 can develop against U01's interface contract before U02 lands; its shared component integration completes after U02. Feature packages supply typed adapters/renderers, not competing chrome.

Delivery order:

1. Foundation and UI design wave: P01–P06 and U01, with P21 corpus construction beginning immediately. P05 uses U01's confirmed incremental layout contract before fixing panel placement.
2. Analysis and shared UI wave: P07–P10, P13, P17 and U02/U03 once their dependencies pass. Feature editors can be built against shared contracts while shell migration proceeds.
3. Coordination and editing wave: P11–P12, P14–P16 including P15A.
4. Complete workflow and migration wave: P18–P20 and U04, including cross-analysis review and executable AI Flow nodes.
5. Program completion: close P21 only after every feature, UI migration and acceptance journey is demonstrated.

No wave is an optional future backlog. Exact effort and calendar estimates require the P01 inventory and initial foundation spike; do not present speculative dates as commitments. Every feature issue names its native owners, acceptance fixtures, API/docs impact and stopping condition before implementation begins.

## Evaluation and test strategy

Create a versioned, privacy-reviewed fixture/evaluation manifest using real authoring-tool IFC exports and independent check/reference evidence. Fetch model files through the repository fixture mechanism; tests skip absent fixtures with the prescribed message. Record source/license, model fingerprint, engine/options, input scope, exact invariants and reviewer provenance. Synthetic malformed cases supplement real behavior evidence.

Keep deterministic orchestration and artifact validation in normal CI with recorded provider responses. These recordings test IFClite behavior, not LLM quality. Live quality evaluation runs separately with fixed model/settings, token limits and retained usage; human-label classification and grouping cases, and independently verify report claims and generated graph effects.

Proposed release invariants:

- Every enabled action has valid referenced evidence, actual grants and a current target revision.
- Every source finding is accounted for in grouping output, including explicit unclassified/excluded items.
- Every rendered factual number uses a native computed fact and the correct denominator/unit.
- Unsupported requirements, truncated populations and ambiguous identities remain visible.
- A repeated known BCF batch cannot create duplicate topics; uncertain remote outcomes cannot be retried blindly.
- Model correction conflicts cannot silently overwrite newer values; undo and exported IFC preserve intended behavior.
- AI request budgets apply across repairs, retries, Flow lifting and resumed jobs.
- Manual decisions and historical evidence are never reinterpreted as current automatic verdicts.

Record baseline versus assisted task completion time, user correction rate, unsupported factual claims, grouping agreement, topic duplication, generated-Flow execution success, time to first useful artifact, cancellation response, provider usage and coverage. Set quantitative UX/quality thresholds from the labeled pilot before feature release; the invariants above have zero tolerated violations in the release corpus. No universal confidence score or unmeasured performance claim is a release criterion.

Proposed pilot acceptance targets, to ratify in U01/P21 before feature completion: at least 90% unaided completion of the listed coordinator tasks, no lower task completion than the current viewer, zero scope errors causing wrong-target effects, at least 90% executable generated graphs on the labeled authoring tasks, and all native values/counts/units correct. Track classification usefulness and required grouping corrections against human-reviewed cases; define taxonomy-specific thresholds before promoting that taxonomy. “Recognizable UI” requires the same entry locations for ribbon/rail/hierarchy/bottom editors, current visual tokens, preserved shortcuts and successful existing-user task discovery. These are proposed thresholds, not measured results.

Mounted viewer tests use the existing happy-dom setup and real render helpers. Test behavior through interactions and native artifacts, never source text. Tests must prove effects beyond echoed state or mock outputs. Add integration tests for provider-independent refusal, partial writes and lifecycle races; use real server runs for publication claims.

Implementation checks run root `pnpm typecheck`, `pnpm test`, appropriate root-filtered turbo runs, `pnpm lint`, documentation sample/generated/readme checks, module-size and relevant existing gates. Inspect current workflows and main ruleset for authoritative required contexts at implementation/PR time. Published changes need changesets, intentional API snapshot updates and matching guides. Sandbox bridge changes regenerate `bim-globals.d.ts` and run template checks.

Geometry/Rust changes are not expected from AI orchestration. If an implementation needs them, apply the repository's workspace tests, clippy, WASM bindings/parity/determinism and base-versus-branch performance requirements. For browser orchestration, measure responsiveness and retained memory with large result sets and repeated model replacement; release all subscriptions, workers and Blob handles on cancellation/teardown.

## Required acceptance journeys

| Journey | Steps | Demonstrated result |
|---|---|---|
| Delivery validation | Load real federation → draft/check requirements → validate → explain → inspect → report | Exact outcomes, explicit unsupported requirements and source-linked narrative |
| Clash coordination | Detect → enrich/group → classify → manually split → draft BCF → publish → rerun revision | Complete finding accounting, retained review and reconciled topics |
| Batch correction | Read approved mapping → match → preview → concurrent edit conflict → apply valid reviewed batch → export/reparse → rerun | Verified values, grouped undo and changed validation evidence |
| Native model authoring | Choose supported operation → inspect source/parameters → preview → commit → undo/redo → export/reparse | Canonical builder/editor output, referential integrity and matching geometry |
| Flow authoring | Describe task → inspect/edit graph → preflight → execute → modify tracked branch → rerun | Valid graph, preserved tracking and native artifacts |
| Flow AI execution | Supply finding table → classify/summarize → budget limit → resume → review checkpoint → downstream BCF/document effects | Bounded calls, durable receipts and reviewed continuation |
| Cross-analysis review | Compare revisions → join current findings and linked records → inspect existing topic → review → update issues/report | Revision-correct links, no unsupported resolution or double counting |
| Universal analysis reporting | Exercise every adapter including quantities/cost, manual, semantic and specialized analyses | Each narrative states actual coverage, units and source limitations |
| Everyday exploration | Ask query → edit filters → save list/lens/chart → inspect in 3D → restore view | Native artifacts, accurate population and recoverable view state |
| Reuse and recovery | Save workflow/tool/preferences → export → reload/import → deny missing grants → run authorized task | No credentials in artifacts, truthful save state and project-scoped reuse |

Program completion requires P01–P21, P15A and U01–U04 closed, all acceptance journeys recorded with independent ground truth, and the user-facing guides updated. A functioning chat panel alone does not complete any of the broader journeys.

## Decisions and remaining implementation measurements

Adopt one assistant shell, native artifact outputs, explicit source scope, typed proposals, provider-independent budgets, immutable evidence, native execution and durable publication receipts. Include Flow AI nodes, cross-analysis review and all supported native model editing operations in this program. Preserve the recognizable current layout and visual style while unifying panels incrementally for BIM coordinators; AI opens on demand through contextual actions.

P01 must settle the exact analysis inventory and which native result APIs need adapters. P02 must measure provider usage reporting and structured-output support, then tune the proposed limits. P11/P12 must measure the connected servers' GUID, vocabulary, version and idempotency behavior. P19 must design pause/resume against actual scheduler and write-accounting semantics before changing runtime APIs. These are bounded discovery deliverables with tests and recorded decisions, not reasons to defer the features.

External standards references explain interoperability boundaries: [buildingSMART BCF](https://technical.buildingsmart.org/standards/bcf/) describes model-based topic exchange; [IDS property facets](https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/property-facet.md) describe canonical property and unit expectations. Current implementation details and behavior remain grounded in the linked repository sources.

## Architectural review record

Astra reviewed a compact architecture brief covering the complete feature/UI scope, contracts, dependency graph and acceptance plan. This was a bounded architectural review, not a line-by-line document or source review. The successful review reported 2,129 tokens used. An initial 4,000-token tracked attempt stopped before substantive assessment because its tracker counted supplied runtime context above the limit.

The eight findings were incorporated: single-consumption checkpoint state and crash recovery; review-to-commit revalidation and transaction limits; deterministic authorization around untrusted content; citation validity versus semantic support; an explicit model authoring matrix and scope question; durable blocking of uncertain publication outcomes; root budgets across continuations; and shared UI ownership plus concrete panel/release coverage. No implementation behavior is claimed by this review.
