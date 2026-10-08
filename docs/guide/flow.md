# Flow Graphs

A flow graph is a node-based program over a BIM model: query elements, read
and restructure their data, write properties back, highlight results in the
viewer, and export tables. Portable `*.flow.json` graphs run in the browser
and with `ifc-lite flow run` in CI. Model writes land in the change set for
preview, undo and publishing. Local session automation additionally requires
the viewer host for files, native check history, documents and PDF artifacts.

The runtime is `@ifc-lite/flow`; the standard nodes are `@ifc-lite/flow-nodes`.

## One data model

Every value travelling along an edge has one of three structures:

| Structure | What it is | Typical source |
|---|---|---|
| **Item** | one value | a number, a selected entity, a table |
| **List** | ordered values | the walls a selector matched |
| **Group** | lists keyed by string | openings *per wall*, walls *per storey*, sheets *per name* |

A group has exactly one keyed level. That single rule replaces Grasshopper's
data trees (paths, Path Mapper, Simplify) and Dynamo's list levels: BIM data
is keyed — by GlobalId, storey, sheet name, grid intersection — so the key
*is* the structure.

Entities are handles (`{ globalId, modelId?, expressId? }`), never copies of
their data. A node reads what it needs through the SDK when it runs.

Tables carry typed columns: each column records the IFC value type
(`real`, `integer`, `label`, `boolean`, …), an optional unit, and, for
property columns, the `pset`/`prop` it was read from. A table always names
its key column, so a sheet edited in Excel can be matched back to entities
without guessing.

## How nodes iterate

A port declares the **access** it wants: `item`, `list`, or `group`. The
runtime adapts the incoming structure to it:

- An `item` port receiving a list is **laced**: `shortest` (default),
  `longest` (repeat the last value), or `cross` (every combination, keyed
  `i|j`; refused above a size guard).
- An `item` or `list` port receiving a group runs **once per branch**.
  Two group inputs match **by key**, never by position; a key present on
  one input and missing on the other is reported and that branch is
  skipped.
- A `group` port receives the whole group; a plain list arrives as the
  single branch `""`.

Lanes are keyed by the driving entity's GlobalId when there is one, so a
lane's identity survives reordering or insertion of elements. When a node
has to fall back to index keys the run log says so.

A `null` reaching a non-nullable `item` port short-circuits that lane: the
node is not called and its outputs for that lane are `null`. Errors inside
one lane are logged with the lane key and yield `null`; the run continues.

Restructuring is a small, complete set of nodes: `core.groupBy`,
`core.flatten`, `core.keys`, `core.lookup`, `core.first`, `core.item`,
`core.wrap`, `core.filter`, and for tables `table.groupRows` and
`table.pivot`.

## The document

```json
{
  "flowVersion": 1,
  "id": "fire-rating-audit",
  "name": "Fire rating audit",
  "capabilities": ["model.read", "viewer.colorize", "model.mutate:Pset_WallCommon"],
  "inputs": [{ "nodeId": "rating", "param": "value", "label": "Default fire rating", "kind": "scalar" }],
  "outputs": [{ "nodeId": "missingCount", "port": "count", "label": "Walls without FireRating" }],
  "nodes": [
    { "id": "walls", "type": "model.select", "params": { "selector": "IfcWall" } },
    { "id": "fr", "type": "model.property", "params": { "pset": "Pset_WallCommon", "property": "FireRating" } }
  ],
  "edges": [{ "from": ["walls", "entities"], "to": ["fr", "entity"] }]
}
```

- `capabilities` use the [extension grammar](extension-authoring.md#capabilities). The
  viewer gates every node against the grants the user accepted; a write node checks the
  *actual* pset it is about to touch, so `model.mutate:Pset_WallCommon` does not let it
  write `Pset_DoorCommon`.
- `inputs` mark node params a Player form (or `--input` on the CLI) sets; `outputs` mark the
  ports shown as results. `ifc-lite flow describe` prints both.
- `lacing`, `tracking` and `trackingKey` are per node. Positions (`pos`) live in the file;
  tracked element sets do not.

The full document is `apps/viewer/src/lib/flow/examples/05-fire-rating-audit.flow.json` — the panel’s example 5, which the CLI test runs end to end.

## Spreadsheet connectors

`table.readCsv` / `table.writeCsv` and `table.readXlsx` / `table.writeXlsx`
move a `Table` to and from a mapping spreadsheet:

- `table.readCsv` takes CSV text on its `text` input, `columns` (`[{ name, type }]`,
  defaulting to the header row typed `string`) and `delimiter` params, and returns
  `table` plus `problems` — a malformed row (wrong field count, a cell that will not
  parse as its column's type) is **reported, never dropped**.
- `table.writeCsv` is the reverse, through `@ifc-lite/export`'s `tableToCsv` — the one
  place in the repo that guards a cell against spreadsheet formula injection
  (CWE-1236; `scripts/check-csv-escaper-copies.mjs` fails the build on a second copy).
- `table.readXlsx` / `table.writeXlsx` do the same over a single-sheet `.xlsx`
  workbook. A `Scalar` carries no bytes, so the workbook travels an edge as base64
  text (`data` in/out). The underlying `readXlsxTable`/`writeXlsxTable` functions are
  exported from `@ifc-lite/flow-nodes` as a shared module — both the CLI and the
  viewer read/write `.xlsx` through the same code.

`table.joinByKey` joins spreadsheet rows to model entities by `globalId`, `tag`,
`name`, or an indexed `property` (`pset`/`prop` params) and produces three outputs:
`matched` (one row per uniquely matched entity, with a `GlobalId` column added),
`unmatched` (no entity claims the row's key), and `ambiguous` (the row matches
**several** entities, or its uniquely-matched entity is also uniquely claimed by
**another** row — reported with a `MatchedGlobalIds` column, never silently resolved
to the first match). `tag`/`property` reuse `@ifc-lite/mutations`' row-matching index
builder rather than re-scanning the model per row; that needs bulk entity-table
access (`FlowHost.tables()`), which all three hosts provide — the viewer, `ifc-lite
flow run`, and MCP `run_flow` — each over the same mutation overlay its writes go
through, so a join sees properties written earlier in the session or run.

`model.applyTable` writes a table's columns back as property mutations, one entity
per row (the row key names the target's GlobalId — `table.joinByKey`'s `matched`
output is the usual source). Each column writes through the pset/prop its `mapping`
param names, or its own `binding` when the table came from `table.fromEntities`. A
cell that does not parse as its column's declared type is reported per row in
`problems` and **not written** — never coerced to `0`/`''`/`false`.

`model.applyTable` never deletes a property. An empty cell, including a cell a reader could
not parse or a short row's missing field, leaves the property as it is. Those cells are
already reported in the reader's `problems` output, so a typo in a spreadsheet can never
quietly erase a value.

```json
{
  "id": "csv", "type": "core.string", "params": { "value": "Tag,FireRating\nT-100,REI90\n" }
}
```
```json
{ "id": "read", "type": "table.readCsv", "params": { "columns": [{ "name": "Mark", "type": "string" }, { "name": "FireRating", "type": "string" }] } },
{ "id": "walls", "type": "model.byType", "params": { "type": "IfcWall" } },
{ "id": "join", "type": "table.joinByKey", "params": { "strategy": "property", "column": "Mark", "pset": "Pset_Fabrication", "prop": "Mark" } },
{ "id": "apply", "type": "model.applyTable", "params": { "mapping": [{ "column": "FireRating", "pset": "Pset_WallCommon", "prop": "FireRating" }] } }
```

`packages/cli/src/commands/flow-table-connectors.test.ts` runs this pilot workflow
(`ReadCsv → JoinByKey → ApplyTable`) end to end against a real model, including a
duplicate match value that must land in `ambiguous`, not get resolved to either
entity.

`strategy: "tag"` works in the viewer. Headless (`ifc-lite flow run`, MCP) it
currently matches nothing, because the CLI's columnar parser does not populate `Tag`
(#1765). Use a `property` join, as above, until it does.

## Creating elements, and re-running

`element.stair` takes a storey and `Position` point input; `NumberOfRisers`,
`RiserHeight`, `TreadLength`, `Width`, optional `Direction` and `WaistThickness`
use the canonical stair builder. `element.railing` takes a storey and a `Path`
polyline parameter, `Height`, and optional `RailDiameter`, `PostDiameter` and
`PostSpacing`. Lengths are metres and positions are storey-local. Both specs
connect to the existing `model.addElement`; hosts lacking the corresponding SDK
capability refuse explicitly. Public MCP uses the existing `run_flow` tool,
with one compound `mutation_undo` per creation. Each MCP call has fresh tracking;
persistent create/keep/update/remove requires the CLI sidecar or an embedding
that reuses its `TrackingStore`. There is no new creation RPC alias.

`element.wall`, `element.column`, `element.beam`, `element.slab`,
`element.stair` and `element.railing` build
parametric specs (a value, not yet an element); `model.addElement` writes
them. That node is **tracked**: it owns the elements it creates.

- Each output lane gets a GlobalId derived from the node's `trackingKey`
  (default `<graph name>/<node label>`) and the lane key — never from the
  model id, the graph id, or the run. Re-running the same graph on the same
  model, on a re-exported copy, or after a reload finds the same elements.
- Per lane the runtime decides **create** (new lane), **update** (inputs
  changed: the element is replaced under the same GlobalId), or **keep**
  (nothing to write). Lanes that vanished since the last run are
  **removed** — the orphan Dynamo leaves behind. A tracked node deleted
  from the graph (or given a new tracking key) has its whole set removed
  on the next run.
- An **update** uses the optional atomic `bim.store.replaceElement` capability:
  removal and canonical creation either both commit or leave the previous
  product/flight, journal, allocator and tracked entry intact. Unsupported
  hosts refuse before removal. This also applies when a tracked spec changes
  kind. The public MCP tool still has fresh per-call tracking.
- An **update** replaces the product; the representation items of the
  previous body stay in the exported file as unreferenced entities (the
  store tombstones the product only). Stairs remove their uniquely owned
  `IfcStair`/`IfcStairFlight` pair instead: ownership ambiguity, foreign product
  references or unreadable live records refuse the update before writing.
  Shared representation/style/material leaves remain. A stable GlobalId says the element
  is the same one, not that the file's entity set is unchanged.
- The tracked sets live in a sidecar, not in the graph: `ifc-lite flow
  run` writes `<graph>.tracking.json` beside the graph (`--tracking F`,
  `--no-tracking`). A graph is reusable across models; its tracked sets
  are not.
- `tracking: "replace"` on a node re-creates every lane under fresh
  GlobalIds and removes the previous set; `"disabled"` computes without
  writing.
- A lane keyed by index (a list of numbers rather than of entities) is
  stable only while the list keeps its order; the run log warns. Drive
  creation from entities (grid axes, storeys, existing elements) when the
  set can change in the middle.

`model.addElement` refuses to create under a GlobalId that already belongs
to a foreign element — change the tracking key rather than overwrite.
Geometry is parametric only (what `bim.store.add*` can author); there is no
BRep/Solid write path.

A run is one undo step in the viewer: every write the graph made is tagged
as one batch (`bim.mutate.batchAsync`), so Ctrl+Z reverts the whole run.

## Where a node can run

Nothing is declared "browser-only" or "server-only". A node states what it
requires (a backend feature such as `viewer`, a network bridge, a named
secret) and the host reports what it offers. Viewer nodes are **no-ops**
on a headless host and pass their entities through, so a graph that
colorizes failures runs unchanged in CI. `ifc-lite flow validate` and the
editor show the same per-node report.

In the viewer, the status bar’s **Activity** tray offers **Cancel** for a running Flow. Each row addresses its own native run. Cancellation stops downstream effects at the scheduler’s next checkpoint and records **Cancelled**. If a node needs time to finish its current work, the run keeps its execution lease while cancellation drains; another run can start after the lease releases. Terminal rows release their cancellation controls.

## AI nodes and review checkpoints

`@ifc-lite/flow-nodes/ai` adds four nodes that call the host's AI model
service (`FlowHost.ai`); they never call a provider themselves:

| Node | Input | Output |
|---|---|---|
| `ai.classify` | a table and versioned category definitions | one row per input row: allowed `label`, cited `evidence` columns, `outcome` (`classified`, `unknown`, `failed`, `not-sent`), plus `coverage` |
| `ai.summarize` | a table of evidence rows, audience, language | narrative `sections` citing row keys; a section without a valid citation is kept as `uncited` |
| `ai.propose` | selected findings, target/expected-value columns, native field bindings and allowed candidate values | portable `model.changes` artifact with cited row keys and bounded coverage; no mutation |
| `ai.extract` | text passages and a field schema | typed `records`, each quoting its source span; a span not found verbatim in its passage, or a value of the wrong type, makes the record `unsupported` |

Every AI node declares `network.ai` (graph data goes to the host's model
provider), requires the `ai` backend feature, is volatile, and sends only
the columns you list. Table nodes refuse an empty column selection before making
a request. Model-facing row keys remain distinct even when a source row has no key
or its literal key collides with a generated one. Requests come out of **one root budget per run**: every
AI node, lane and batch draws from it, so list lacing cannot multiply the
spend, and a budget stop keeps a partial result whose coverage counts the
rows that were not sent. Unknown row keys, labels outside the allowed set,
missing citations and quotes absent from the passage are dropped or marked.
Rows omitted from a classification reply count as `failed`; an explicit
`unknown` answer remains distinct in the per-row outcome and coverage counts.
Hosts save the original root budget in `createCheckpoint({ ...input, budget })`.
CLI and viewer resume refuse a missing or malformed budget receipt before claiming a
checkpoint when downstream AI nodes remain; it never grants a fresh allowance.
When a paused CLI run exports with `--out`, resume uses that exported IFC file,
whose exact bytes are bound into the checkpoint even for a read-only run.
These checks do not establish that a cited row or quote entails the generated
claim. For `ai.extract`, `supported` means the quote occurs verbatim and field
values have the declared types. A reply quoting “30 minutes” with a typed
value of `999` still passes that structural check; the reviewer must compare
all candidate values with the captured passage before approval.

`ai.propose` currently allowlists only `model.changes`. Select `GlobalId` and
all expected-value columns, then bind each allowed native operation through
`fields` (`op`, `name`, optional `pset`/`qset`/`dataType`, `expectedColumn`,
and `allowedValues`; deletes omit candidate values). A shared GlobalId requires
an explicit selected model-id column. Unknown targets, uncited changes,
changed expected values, unselected fields and candidates outside the allowed
values refuse the entire draft. Clarification, truncation and exhausted budgets
also produce no artifact. Coverage distinguishes findings sent from findings
excluded by `maxRows`. The artifact uses the same parser as viewer corrections,
exported separately through `@ifc-lite/ai/artifacts`; it remains a proposal.
Approval of a checkpoint does not establish current permissions or values:
application must still pass native mutation preflight and explicit review.

**Review checkpoints.** A node that declares `review: 'required'` (every AI
node does) produces a proposal; the run stops downstream of it (status
`review`, dependants `paused`) and `RunResult.review` names it. Independent
branches still run. To continue, the host saves a checkpoint, a reviewer
approves the proposal by its digest, and the run is resumed with
`RunOptions.resume`: every node that completed before the pause is restored
(status `restored`) and never executed again, so a write before the pause is
not repeated and the reviewed proposal is replayed without a model request.

A checkpoint (`createCheckpoint` from `@ifc-lite/flow/checkpoint`, a separate entry so a host that only runs graphs does not load it) is plain JSON, so the viewer and the CLI
read the same record. It holds the restored outputs, a digest of the graph
and its Player inputs, a host digest of the sources the run read, the
proposal digest and the AI budget state. Its lifecycle is `prepared` →
`reviewed` (or `rejected`) → `applying` → `completed`, or
`partially-committed` when a resume failed or its owner disappeared
mid-resume; a partially committed checkpoint can never be resumed again.
`claimCheckpoint` re-checks the graph and source digests and goes through a
compare-and-swap store (`updateCheckpoint`), so two tabs or processes cannot
consume the same approval. `resumeOutputs` refuses prepared, rejected, completed,
partially committed and expired checkpoints; proposal inspection uses
`checkpointProposal` and grants no permission to resume. The scheduler accepts only the unchanged, single-use map returned by `resumeOutputs` for an approved checkpoint with a live claim; raw paused outputs, edited maps and reused maps are refused before any node executes. A value that is not plain JSON (a viewer-only
handle) makes the run uncheckpointable, named by node and port.

```ts
import { runFlow, type FlowDocument, type NodeRegistry } from '@ifc-lite/flow';
import { approveCheckpoint, claimCheckpoint, createCheckpoint, finishCheckpoint, graphDigest, resumeOutputs, updateCheckpoint, type CheckpointStore } from '@ifc-lite/flow/checkpoint';
import type { FlowHost } from '@ifc-lite/flow-nodes';

async function reviewedRun(doc: FlowDocument, host: FlowHost, registry: NodeRegistry<FlowHost>, sourceDigest: string, store: CheckpointStore) {
  const paused = await runFlow(doc, { host, registry });
  if (paused.review.length === 0) return paused;
  const checkpoint = createCheckpoint({ doc, registry, result: paused, sourceDigest });
  // ...show the proposal (checkpointProposal) and collect the reviewer's approval...
  const approved = approveCheckpoint(checkpoint, checkpoint.proposalDigest);
  if (!await store.write(approved, null)) throw new Error('Checkpoint already exists');
  let claimed = await updateCheckpoint(store, approved.id, current => claimCheckpoint(current,
    { owner: 'me', graphDigest: graphDigest(doc, {}, registry), sourceDigest, leaseMs: 60_000 }));
  const resumed = await runFlow(doc, { host, registry, resume: resumeOutputs(claimed) });
  claimed = await updateCheckpoint(store, claimed.id, current => finishCheckpoint(current, 'me', { ok: resumed.ok }));
  return resumed;
}
```

Checkpoint creation checks Player inputs against the actual paused run;
pass the same `inputs` used by `runFlow` when creating a checkpoint. A resume takes a
detached copy of the approved values before any asynchronous downstream work.
Every resume uses the original claim returned by a successful `updateCheckpoint`
compare-and-swap. A persisted `applying` record is not an ownership receipt: another
tab or process cannot resume it, and a lost owner is recovered as partially committed.

**In the viewer**, AI nodes use the model chosen for the Assistant (the
hosted proxy or your own key), and every request has a usage receipt. A run
that pauses shows a review card under the canvas with every row of the
proposal and its coverage; **Approve and resume** approves exactly that
proposal and runs the rest of the graph from it, **Reject** ends it. The
checkpoint is kept in the browser, so after a reload with the same model
files and no edits the same proposal can still be approved; any edit, undo
or model change in between refuses the resume and asks for a new run. Graph
writes before and after the pause are separate undo steps.

In a real host the transitions go through `updateCheckpoint` with a durable
store; the CLI's `flow run --checkpoint` / `flow review` / `flow resume`
(see the [CLI guide](cli.md)) and the viewer's Flow
panel do exactly that. MCP uses the same opt-in provider environment as the CLI.
`run_flow` requires a new allowed `checkpoint_path` for review-capable graphs
and returns a `pending` artifact with its exact approval digest. A separate
`resume_flow` call supplies that `approved_digest`, the same graph and Player
inputs, and the returned `model_id`. It rechecks current mutate scope, graph,
all accessible native effective model exports and the original root budget
before claiming once. Completed nodes replay without a provider request;
downstream AI still needs host configuration. A further review requires a new
`next_checkpoint_path` before continuation. Checkpoints never overwrite existing
files; secret-bearing restored outputs are refused. The shared
`@ifc-lite/flow/checkpoint-file` entry provides the CLI/MCP disk CAS store.
MCP tracking remains per run, as on the existing native host.
Pass the effective node registry when creating a checkpoint and computing its
claim digest so a changed review policy refuses the resume. Graph identities, names and node labels also bind the digest,
because they determine default write tracking keys. Cached proposals still pause
for review on every new run; only an approved checkpoint restores them for resume.

## Programmatic use

```ts
import { runFlow, parseFlowDocument, MemoCache } from '@ifc-lite/flow';
import { createStandardRegistry, BROWSER_FEATURES } from '@ifc-lite/flow-nodes';

const registry = createStandardRegistry();
const doc = parseFlowDocument(await (await fetch('/flows/audit.flow.json')).text());
const cache = new MemoCache();
const result = await runFlow(doc, { host: { bim }, registry, features: BROWSER_FEATURES, cache });
for (const o of result.graphOutputs) console.log(o.label, o.data);
```

Re-running with the same `cache` recomputes only nodes whose inputs,
params, or model revision changed. Every write node bumps the cache's write
generation, so reads never serve a memo taken before a write. Nodes that
reach the network are never served from the memo: `HttpRequest` always
sends its request again, and a Script node is recomputed on every run in
which its code called `bim.network.fetch` (a Script that makes no request
stays memoised).

## Script nodes

Two nodes execute user code in the QuickJS sandbox, with the sandbox's `bim`
API (the same one the script console and extensions see, which is not the
full SDK). Both receive `inputs.a`, `inputs.b`, `inputs.c` and return the
value of their last expression; sandbox permissions follow the graph's
grants, so mutation is enabled only when a `model.mutate` grant exists.

They differ only in the **access** their ports declare, which is what decides
whether the runtime lifts them:

| Node | Ports | Sees | Returns |
|---|---|---|---|
| `script.run` | `item` | one element per lane — a list on an input runs the code once per element | any value (`result`) |
| `script.list` | `list` | the whole list at once | an array (`items`); anything else is an error |

Use `script.run` for a per-element predicate or computation, and
`script.list` when the answer depends on the whole set — sorting, ranking,
top-N, de-duplication, comparing one element against the rest. An entity
arrives as `{ globalId, modelId, expressId }`, which is also a `bim.*` ref.

Each lane is evaluated in its own variable environment, so `const` and `let`
in the code mean what they say and nothing carries over from the previous
lane. The code is plain **JavaScript**, not TypeScript, and top-level
`await` is not available.

The `code` parameter is a `code` param kind rather than a plain string, which
is the editor's cue to give it a multi-line editor: the Flow panel's
inspector shows a monospace textarea, and the ⤢ button beside it opens the
full CodeMirror editor (the same `bim.*` completions as the script console).

## Network requests and secrets

`http.request` issues one `https:` GET/POST to a host the graph explicitly
grants. A `network.fetch:<host>` capability names the exact hostname (or a
single-label wildcard, e.g. `network.fetch:*.example.com` — the `*` never
spans a `.`); it is matched against `new URL(url).hostname`, never the raw
URL string, so a spoofed suffix (`api.example.com.evil.net`) or a userinfo
trick (`https://user@api.example.com@evil.net/`, whose real hostname is
`evil.net`) does not match a grant for the real host. Only `https:` is
supported — `http:`, `file:`, and `data:` are always refused — and a
redirect response is refused rather than followed. See
`packages/sandbox/src/network-request.ts` for the full policy and its
rationale.

In the viewer, `http.request` runs subject to the browser's own CORS
enforcement: a host that does not send `Access-Control-Allow-Origin` for
the request fails with an explicit "likely CORS" message, never a silent
empty result. The CLI and MCP have no such restriction (Node's `fetch` is
not CORS-limited).

A node param may reference an environment secret with `{{secret:NAME}}`
(inside a plain string or nested in a `json`-kind param, such as a header
map). The graph must also declare `secret.read:NAME` as a capability —
an undeclared or declared-but-unset reference is a **validation error
raised before the run starts**, not a silently empty string. Secrets are
resolved from `process.env` **only** by `ifc-lite flow run` and MCP's
`run_flow`. The viewer's `HostFeatures.secrets` is always empty, so a graph
needing a secret shows `unavailable` in the panel before it ever runs.
`ifc-lite flow validate` checks against its own environment: a referenced
secret counts as available there only when the graph declares it and the
variable is set to a value at least 6 characters long (the redaction
minimum below), the same conditions `flow run` enforces.

Every secret value at least 6 characters long is redacted — as
`<secret:NAME>` — from run logs, node outputs, error messages, and
`--json`/MCP output, including a value that comes back inside a fetched
response body (a server echoing an `Authorization` header, for example).
Redaction happens once, right before output leaves the process, so it
catches a secret wherever it resurfaces in the run's own result — not just
at the point it was substituted into a param.

```json
{
  "capabilities": ["network.fetch:api.example.com", "secret.read:API_TOKEN"],
  "nodes": [
    {
      "id": "req",
      "type": "http.request",
      "params": {
        "url": "https://api.example.com/status",
        "headers": { "Authorization": "Bearer {{secret:API_TOKEN}}" }
      }
    }
  ]
}
```

### BCF API nodes

Three nodes talk to a BCF API (OpenCDE) server through `@ifc-lite/bcf-api`,
with every request going through the same gated transport as
`http.request`: `https:` only, and the `baseUrl` hostname must match a
declared `network.fetch:<host>` capability.

- `bcf.listTopics` lists a project's topics (optional OData `filter`,
  `orderby`, `top`) as a table keyed by `guid`, with columns `title`,
  `status`, `type`, `priority`, `assigned_to`, `creation_date`,
  `modified_date`, `labels` (`;`-separated) and `description`, plus the raw
  topic list and a `count`.
- `bcf.createTopic` creates one topic from its params, or one per row when a
  table is wired into `rows` (same column names as `bcf.listTopics`; an empty
  cell falls back to the param). Every row is validated before the first
  request, and it outputs the created `guids`.
- `bcf.addComment` posts a comment to `topicGuid`. Wiring `bcf.createTopic`'s
  `guids` into its `topicGuid` input comments on each new topic.

Each takes `baseUrl` (up to but excluding the version segment), `version`
(default `2.1`), `projectId`, and `token`, sent as
`Authorization: Bearer <token>`. Put the token in a secret rather than the
graph. The nodes are never memoised, so every run asks the server again.

A create is not idempotent: if the connection drops after the server
committed a write, a rerun would create it a second time. The write nodes
therefore never retry, and they report a lost connection as an *unknown
outcome* ("check the project before running this node again") rather than a
plain failure. In the viewer, `bcf.createTopic` and `bcf.addComment` also go
through the BCF publication outbox (`FlowHost.bcfWrites`): the intent is
recorded before the request leaves, and an identical write whose earlier
attempt has an unknown outcome is refused without sending until it is checked
under **BCF → Drafts & publication**. The token is never stored there.

```json
{
  "capabilities": ["network.fetch:bcf.example.com", "secret.read:BCF_TOKEN"],
  "nodes": [
    {
      "id": "open",
      "type": "bcf.listTopics",
      "params": {
        "baseUrl": "https://bcf.example.com/bcf",
        "projectId": "my-project",
        "token": "{{secret:BCF_TOKEN}}",
        "filter": "topic_status eq 'Open'"
      }
    },
    {
      "id": "sheet",
      "type": "table.writeCsv"
    }
  ],
  "edges": [{ "from": ["open", "table"], "to": ["sheet", "table"] }]
}
```

### Receiving a Speckle model

`speckle.receive` fetches one Speckle model version and writes its walls,
floors, flat roofs, columns and beams into a target storey, with the Revit
parameters as `Speckle_TypeParameters` / `Speckle_InstanceParameters`
property sets and the source identity as `Speckle_Source`. Its `url` is
the address you copy from the Speckle web app
(`https://<server>/projects/<project>/models/<model>`, optionally
`@<version>`; legacy `/streams/<id>/commits/<id>` and
`/streams/<id>/objects/<id>` URLs work too). It speaks to Speckle only
through the same gated request function as `http.request`, so the graph
must grant the server's host, and a private project's token comes in as a
secret:

```json
{
  "capabilities": [
    "model.read", "model.create", "model.delete",
    "model.mutate:Speckle_Source", "model.mutate:Speckle_TypeParameters", "model.mutate:Speckle_InstanceParameters",
    "network.fetch:app.speckle.systems", "secret.read:SPECKLE_TOKEN"
  ],
  "nodes": [
    { "id": "storeys", "type": "model.byType", "params": { "type": "IfcBuildingStorey" } },
    { "id": "first", "type": "core.first" },
    {
      "id": "rx",
      "type": "speckle.receive",
      "params": {
        "url": "https://app.speckle.systems/projects/<project>/models/<model>",
        "token": "{{secret:SPECKLE_TOKEN}}"
      }
    }
  ],
  "edges": [
    { "from": ["storeys", "entities"], "to": ["first", "items"] },
    { "from": ["first", "item"], "to": ["rx", "storey"] }
  ]
}
```

Where the host enforces grants, the three `model.mutate:Speckle_*` grants
above are needed exactly as spelled (pset grants match by name), and
`model.delete` is checked only when a receive replaces elements an earlier
receive wrote.

Everything the mapping cannot reproduce is reported on the `refusals`
output, by Speckle type, reason and count, and nothing is dropped silently.
Display meshes are never written: the element body is rebuilt parametrically.
The mapping table and its limits are in
[Speckle → IFC mapping](../architecture/speckle-mapping.md).

### Running a graph in CI, with secrets from GitHub Actions

A workflow can install the CLI, run a graph with a secret passed through
`env:`, and publish the result — the graph declares exactly which secret
it needs (`secret.read:API_TOKEN`) and which host it may reach
(`network.fetch:api.example.com`); nothing beyond that is available to it,
and the secret is redacted from anything the job uploads or comments.

```yaml
# .github/workflows/flow-audit.yml (illustrative — not run in this repo's CI)
name: Flow audit
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write # the summary comment

jobs:
  audit:
    # Repository secrets are not passed to pull requests from forks, and the
    # token cannot comment there, so run only for same-repository branches.
    # Audit a fork's change after merge, or from a maintainer-triggered
    # workflow. Never use `pull_request_target` with a checkout of the fork's
    # code to reach the secret: that runs untrusted code with it.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install ifc-lite CLI
        run: npm install -g @ifc-lite/cli

      - name: Run the audit graph
        id: run
        env:
          API_TOKEN: ${{ secrets.API_TOKEN }}
        # `flow run` exits 1 when the graph fails. Keep that status, but
        # write the summary output first so the comment step can report it.
        run: |
          set +e
          ifc-lite flow run graphs/fire-rating-audit.flow.json model.ifc \
            --out audit-result.ifc --json > run-summary.json
          status=$?
          set -e
          echo "ok=$(jq -r .ok run-summary.json)" >> "$GITHUB_OUTPUT"
          exit $status

      - name: Publish the audited model as a layer
        if: steps.run.outputs.ok == 'true'
        run: ifc-lite layer publish audit-result.ifc --layer fire-rating-audit

      - name: Comment the run summary on the PR
        # Also after a failed run (the job still fails from the step above).
        if: always() && steps.run.outputs.ok != ''
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            // run-summary.json was already redacted by `flow run` itself —
            // secrets never reach an artifact, an env dump, or this comment.
            const summary = JSON.parse(fs.readFileSync('run-summary.json', 'utf-8'));
            const body = `Flow audit: ${summary.ok ? 'passed' : 'FAILED'} (` +
              Object.entries(summary.nodes).map(([k, v]) => `${v} ${k}`).join(', ') + ')';
            await github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body,
            });
```

`API_TOKEN` is scoped by two independent things: the repository secret
(`${{ secrets.API_TOKEN }}`, GitHub's own access control) and the graph's
own `secret.read:API_TOKEN` capability (`ifc-lite`'s — a graph that does
not declare it cannot read the env var even though the workflow set it).
Nothing the workflow uploads, comments, or logs can carry the raw value:
`flow run --json` redacts it before it is ever written to
`run-summary.json`, so every consumer downstream — the artifact, the PR
comment, the job log — only ever sees `<secret:API_TOKEN>` if the value
happened to surface at all.

### Autodesk Platform Services (APS)

Two nodes read Autodesk model data into a graph, so Revit or ACC properties
can be joined to an IFC model:

- `aps.token` gets an APS access token: a 2-legged client-credentials token
  from `clientId` / `clientSecret` (`scope` defaults to
  `data:read viewables:read`), or a ready 3-legged token passed as
  `accessToken`. Its `token` output is an opaque handle. The token itself is
  never an output value, a log line or part of `--json` output, because a
  token minted from a secret is not a secret the redaction step knows about.
- `aps.modelProperties` reads a translated model's Model Derivative
  metadata, picks the master (else first) 3D view, and reads its properties.
  The output is a table with one row per object: `objectid`, `externalId`
  (for Revit, the element's UniqueId), `name`, `category`, `IfcGUID`, and
  every property as a `Group.Property` column. The `key` param picks the
  key column (default `externalId`). While APS is still extracting
  properties it answers `202`. The node retries up to `maxAttempts` times,
  waiting `retryDelayMs` between tries, then fails with a clear message.
  Credentials come from a connected `token`, or from the same credential
  params on the node itself. `region` sets the data centre (`US`, `EMEA`, …).

Both nodes reach only `developer.api.autodesk.com`, through the same
host-grant check as `http.request`. They are volatile, so every run fetches
fresh data. Run them from the CLI or MCP: the viewer has no secrets, and
APS's endpoints are not meant to be called from a browser page.

This graph joins a Revit model's properties to the walls of the loaded IFC
model through the `IfcGUID` that Revit's IFC exporter writes:

```json
{
  "flowVersion": 1,
  "id": "aps-join",
  "name": "Revit properties onto IFC walls",
  "capabilities": [
    "model.read",
    "network.fetch:developer.api.autodesk.com",
    "secret.read:APS_CLIENT_ID",
    "secret.read:APS_CLIENT_SECRET"
  ],
  "inputs": [],
  "outputs": [{ "nodeId": "join", "port": "matched", "label": "matched" }],
  "nodes": [
    {
      "id": "tok",
      "type": "aps.token",
      "params": { "clientId": "{{secret:APS_CLIENT_ID}}", "clientSecret": "{{secret:APS_CLIENT_SECRET}}" }
    },
    {
      "id": "props",
      "type": "aps.modelProperties",
      "params": { "urn": "urn:adsk.wipprod:fs.file:vf.XXXXXXXX?version=3", "region": "US", "key": "IfcGUID" }
    },
    { "id": "walls", "type": "model.byType", "params": { "type": "IfcWall" } },
    { "id": "join", "type": "table.joinByKey", "params": { "strategy": "globalId", "column": "IfcGUID" } }
  ],
  "edges": [
    { "from": ["tok", "token"], "to": ["props", "token"] },
    { "from": ["props", "table"], "to": ["join", "table"] },
    { "from": ["walls", "entities"], "to": ["join", "entities"] }
  ]
}
```

```bash
APS_CLIENT_ID=… APS_CLIENT_SECRET=… ifc-lite flow run aps-join.json model.ifc --json
```

**Getting a URN.** `urn` takes either form:

- The version id of a Docs, ACC or BIM 360 file, such as
  `urn:adsk.wipprod:fs.file:vf.…?version=N`. The Data Management API returns
  it (`GET /data/v1/projects/{project}/items/{item}/versions`, the `id` of
  each version). The node base64url-encodes it for you. An item id
  (`…:dm.lineage:…`) names no version, so the node refuses it.
- An already-encoded derivative URN, which the APS Viewer and translation
  jobs print (the `urn:` prefix the viewer adds is accepted).

The file must already be translated. Opening it once in ACC or Docs does
that; for your own OSS bucket, start a Model Derivative job first. A
2-legged token can read an ACC project only when the APS app has been added
to the ACC account as a custom integration. Otherwise, pass a user's
3-legged token as `accessToken: "{{secret:APS_TOKEN}}"` and declare
`secret.read:APS_TOKEN`.

## OpenCDE documents

Three nodes connect a graph to a CDE that speaks the buildingSMART
[OpenCDE Documents API](https://github.com/buildingSMART/documents-API)
(`@ifc-lite/documents-api`):

| Node | Does | Outputs |
|---|---|---|
| `documents.queryVersions` | `POST /document-versions` for a list of document ids, sending the previous poll's ETag as `If-None-Match` | `versions` (a table: `document_id`, `version_number`, `version_index`, `title`, `creation_date`, `file_name`, `size_in_bytes`, `download_url`), `etag`, `changed` |
| `documents.download` | downloads one version from its `download_url` | `data` (the file, base64), `name`, `size`, `contentType` |
| `model.openFromSource` | opens downloaded bytes as a model on the host | `modelId` |

When the server answers 304 Not Modified, `changed` is `false`, `versions`
is empty and `etag` echoes the one sent, so a scheduled run can stop early
when nothing moved. Both `documents.*` nodes go through the same gated
request as `http.request`: the graph must declare `network.fetch:<host>` for
the CDE's API host and for its file host when downloads come from another
one. A body over the node's `maxBytes` fails the node rather than yielding a
truncated file. The `token` param carries the bearer token as
`{{secret:NAME}}`, so these nodes run in the CLI and MCP, where secrets
resolve; in the viewer, only an anonymous CDE works. Both nodes are never
memoised: a rerun always asks the server again.

`model.openFromSource` loads through the host's own loader. In the viewer
that is the same path a dropped file takes, and the model joins the
federation. The CLI and MCP hold one model per run, so the opened model
replaces the command-line one for the rest of the run, `--out` included;
when a run opens several files, reads see the last one opened. MCP also
registers each opened model, so later tool calls can address it by the
returned id. Wire `modelId` into the `modelId` input of `model.select` or
`model.byType`: the edge makes the read run after the model is open and
aim at it. The node needs the `model.create` capability.

```json
{
  "capabilities": ["network.fetch:cde.example.com", "secret.read:CDE_TOKEN", "model.create", "model.read"],
  "nodes": [
    { "id": "poll", "type": "documents.queryVersions",
      "params": { "baseUrl": "https://cde.example.com/documents/1.0", "documentIds": ["d1"], "token": "{{secret:CDE_TOKEN}}" } },
    { "id": "url", "type": "table.column", "params": { "column": "download_url" } },
    { "id": "name", "type": "table.column", "params": { "column": "file_name" } },
    { "id": "get", "type": "documents.download", "params": { "token": "{{secret:CDE_TOKEN}}" } },
    { "id": "open", "type": "model.openFromSource" },
    { "id": "walls", "type": "model.byType", "params": { "type": "IfcWall" } }
  ],
  "edges": [
    { "from": ["poll", "versions"], "to": ["url", "table"] },
    { "from": ["poll", "versions"], "to": ["name", "table"] },
    { "from": ["url", "values"], "to": ["get", "url"] },
    { "from": ["name", "values"], "to": ["get", "name"] },
    { "from": ["get", "data"], "to": ["open", "data"] },
    { "from": ["get", "name"], "to": ["open", "name"] },
    { "from": ["open", "modelId"], "to": ["walls", "modelId"] }
  ]
}
```


## Editing a graph

In the viewer's Flow panel:

- **Add** nodes from the palette; drag from an output handle to an input
  handle to connect. Incompatible ports are greyed out while dragging, and a
  refused connection says why.
- **Re-route** an edge by dragging either of its ends onto another port; drop
  it on empty canvas to unplug it.
- **Delete** an edge by clicking it (it goes dashed) and pressing Delete or
  Backspace; the same keys delete a selected node and its edges.
- An input takes **at most one** edge — connecting a second one replaces the
  first — and a connection that would close a cycle is refused.

## Examples

The panel ships a ladder of runnable examples, from a two-node count to a
tracked column grid, under `apps/viewer/src/lib/flow/examples/`. They open
as an editable copy, and because they are ordinary `*.flow.json` documents
they also run headlessly:

```sh
ifc-lite flow run apps/viewer/src/lib/flow/examples/03-quantity-takeoff.flow.json model.ifc --json
```

`packages/cli`'s `flow.test.ts` runs the portable examples against a real model.
The session automation example verifies that headless execution refuses its
missing viewer services before opening a model.

### Offer a saved workflow at startup

Select a saved workflow and enable **Offer this workflow at startup** in the
Flow toolbar. On the next viewer session, a prompt offers to open that workflow
in Player so you can select files and review settings before clicking Run.
**Skip this session** dismisses the offer without changing the preference;
**Disable startup prompt** removes the preference. No workflow executes merely
because the viewer opens.

Explicit model or collaboration links take priority. The offer waits until
other startup dialogs close, appears once per session and is cleared if its
saved workflow no longer exists. The preference references the local saved
workflow ID, so importing that workflow on another browser does not opt that
browser into startup execution.

### Configure session automation

The automation form edits filename rules, check jobs and document mappings
without writing node-parameter JSON. Filename rules apply in order and union
all matching tag names. Each check has a stable job ID, an enable switch and
ordered execution. Use **Embed configuration in workflow** to import an IDS,
information rule set or comparison recipe into the saved workflow, or select
**Choose a file each run** and bind an existing configuration file slot.
Imported configuration files and templates are limited to 10 MiB.

Target selectors use qualified file slots, original filenames or normalized
tag names. An empty target list means all workflow models; multiple targets
form a union. Imported comparison recipes expose their A/base and B/head
selectors separately. The form lists tag references from embedded information
rules and accepts explicit ID-to-name mappings for external rules.

Import a native document template to map its report blocks to stable check job
IDs. An optional result ID selects one report; leaving it blank includes all
reports for that job, including separate IDS reports for each model. Importing
configuration or a template edits the setup and never starts execution.


### File slots, reports and portability

Flow document version 2 adds a `files` input with ordered named slots. The
existing `file` input still reads text. Version-1 workflows migrate when opened,
including saved browser workflows; the graph's authored parameters are retained.
Selected local files must be chosen again after reload and never travel in an
exported `.flow.json` file. Resource selectors use qualified addresses such as
`load.files/models`, exact original filenames or normalized tag names.

Open **Coordination session report** from the examples menu to load local IFC
models, apply filename tags, execute selected IDS/information checks and optional
comparison recipes, import completed comparison evidence and create a combined
report document and PDF. The example requires at least one validation definition;
comparison recipes and historical evidence are separate optional inputs. Configure
job targets and tag-reference mappings when a definition requires them. Enable
the startup offer only after saving the configured workflow.

Comparison recipes describe checks to rerun. Saved comparison JSON contains
completed evidence for documents. A plain live Compare report is a different
format: export from the Saved comparisons library for historical reuse.
One IDS job over several models produces separate model reports, with independent
cardinality and pass rates. Quality failures remain reportable; evaluator errors
block dependent document/PDF steps while completed reports remain reviewable.

Session automation captures a fixed model revision for its checks. Run model
editing nodes, including scripts with model-write grants, in a separate graph;
mixed automation/edit graphs are rejected before model loading or other writes.

Completed native reports retain workflow/run/job identity, effective options,
model content identity, edit revision and execution diagnostics when available.
Saving the same result within a run is idempotent. A new run creates new evidence.
Browser storage refusal keeps reports/documents in memory and displays a warning;
retry saving or download the evidence before closing the session.

Default report documents print a title, scoped result counts and run/model
provenance before the native report blocks. A custom template maps existing
validation report or comparison table block IDs to enabled job IDs. A mapping
without a result ID expands all results for that job into adjacent blocks, keeping
the template's presentation. Required and incompatible mappings are rejected
before model loading. Native document version 10 remains the portable format.
Templates cannot use live validation tables or IDS/comparison charts, whose data
belongs to the viewer's latest manual result. Use mapped report blocks for the
workflow's captured evidence. Chart preparation failures produce PDF warnings.

The standard CLI and MCP hosts describe these nodes but do not provide viewer
session services. Execution refuses unavailable services before loading a model
or mutating it. Custom hosts can implement `SessionAutomationHost`; advertise
only services actually supplied. Files, native report bodies and PDF blobs stay
outside persistable graph values. PDF generation produces a session artifact;
Download can be retried without rerunning checks while that artifact is valid.

AI review checkpoints require an explicit `network.ai` grant, including trusted CLI runs. Selected source columns are sent inside each row’s `values` object; the outer `key` is the host-assigned review identity. A summary stopped by the shared budget remains a reviewable empty draft with all rows counted as not sent.

CLI approval also binds the effective tracking sidecar and its canonical destination. Changing that sidecar, selecting another tracking file or disabling tracking refuses resume before consuming approval. The CLI refuses to save or display a checkpoint if any restored output contains a declared secret. It checks the next checkpoint destination before consuming approval, validates pause output requirements before flushing tracking, and completes the previous checkpoint only after saving a subsequent proposal. A persistence failure after a claim is recorded as partially committed.

`ifc-lite flow review <checkpoint> --json` includes the exact proposal values by review node and output port, alongside their approval digest. Extraction replies without the required `records` array count as failed passages and emit a warning; they never count as a successful empty extraction.

CLI checkpoint, next-checkpoint, output and tracking destinations must be distinct.
Checkpoint file locks are never reclaimed automatically based on age. If a process
crashes while holding a `.lock`, confirm that its writer has stopped before removing
that lock and retrying; an old lock alone does not establish that a writer stopped.
Checkpoint compatibility uses the executed graph, including resolved secret parameters;
the checkpoint stores its digest, not those credentials. Changing the execution parameters
requires a new run and review.

`propose_flow` lets a read-only MCP caller run a native read/AI-only graph to
a pending artifact. It rejects declared or node-defined effects and permits
only `model.read` and `network.ai`. The current read scope and model allowlist
still apply; the separate `resume_flow` requires current mutate authorization.
MCP responses and checkpoint budgets include provider usage receipts without
prompts, replies or credentials; receipt history survives subsequent pauses.
