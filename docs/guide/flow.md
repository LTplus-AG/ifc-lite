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
`core.flatten`, `core.keys`, `core.lookup`, `core.wrap`, `core.filter`, and
for tables `table.groupRows` and `table.pivot`.

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

The full fixture is `packages/cli/src/__fixtures__/flows/fire-rating-audit.flow.json`, which the CLI test runs end to end.

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
const doc = parseFlowDocument(await (await fetch('/flows/fire-rating-audit.flow.json')).text());
const cache = new MemoCache();
const result = await runFlow(doc, { host: { bim }, registry, features: BROWSER_FEATURES, cache });
for (const o of result.graphOutputs) console.log(o.label, o.data);
```

Re-running with the same `cache` recomputes only nodes whose inputs,
params, or model revision changed. Every write node bumps the cache's write
generation, so reads never serve a memo taken before a write.

## Script node

`script.run` is the one node that executes user code. It runs in the QuickJS
sandbox with the sandbox's `bim` API (the same one the script console and
extensions see, which is not the full SDK), receives `inputs.a`, `inputs.b`,
`inputs.c`, and returns its last expression. Sandbox permissions follow the
graph's grants: mutation is enabled only when a `model.mutate` grant exists.
