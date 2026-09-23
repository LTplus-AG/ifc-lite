# Flow Graphs

A flow graph is a node-based program over a BIM model: query elements, read
and restructure their data, write properties back, highlight results in the
viewer, and export tables. The same `*.flow.json` runs in the browser and
with `ifc-lite flow run` in CI, and every write lands in the model's change
set, so it is previewed, undone, and published like any other edit.

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

```json
{
  "id": "csv", "type": "core.string", "params": { "value": "Tag,FireRating\nT-100,REI90\n" }
}
```
```json
{ "id": "read", "type": "table.readCsv", "params": { "columns": [{ "name": "Tag", "type": "string" }, { "name": "FireRating", "type": "string" }] } },
{ "id": "walls", "type": "model.byType", "params": { "type": "IfcWall" } },
{ "id": "join", "type": "table.joinByKey", "params": { "strategy": "tag", "column": "Tag" } },
{ "id": "apply", "type": "model.applyTable", "params": { "mapping": [{ "column": "FireRating", "pset": "Pset_WallCommon", "prop": "FireRating" }] } }
```

`packages/cli/src/commands/flow-table-connectors.test.ts` runs this pilot workflow
(`ReadCsv → JoinByKey → ApplyTable`) end to end against a real model, including a
duplicate match value that must land in `ambiguous`, not get resolved to either
entity.

## Creating elements, and re-running

`element.wall`, `element.column`, `element.beam` and `element.slab` build
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
- An **update** replaces the product; the representation items of the
  previous body stay in the exported file as unreferenced entities (the
  store tombstones the product only). A stable GlobalId says the element
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
generation, so reads never serve a memo taken before a write.

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

`packages/cli`'s `flow.test.ts` runs every one of them against a real model,
so an example that stops working fails the build.
