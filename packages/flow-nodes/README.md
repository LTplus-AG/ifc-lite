# @ifc-lite/flow-nodes

The standard node library for [`@ifc-lite/flow`](https://www.npmjs.com/package/@ifc-lite/flow),
built on the ifc-lite SDK (`BimContext`). The same nodes run in the viewer and
in the headless CLI.

## Node families

| Family | Nodes | Notes |
|---|---|---|
| `core.*` | number, string, boolean, list, math, compare, concat, count, sum, filter, wrap, flatten, groupBy, keys, lookup | The complete restructuring set for one keyed level |
| `model.*` | select (IfcOpenShell selector), byType, attribute, property, quantity, related, storey, contains, groupByStorey, groupByType | Reads are memoised against the model revision |
| `table.*` | fromEntities, longFormat, column, groupRows, pivot, rowCount | Typed columns with IFC value types and pset/prop bindings |
| `viewer.*` | colorize, isolate, select, selection, flyTo | `noop` on a headless host; entities pass through |
| `model.set*` | setProperty, setAttribute | Capability-checked against the actual pset (`model.mutate:<Pset>`) |
| `http.request`, `speckle.receive` | network | Every request goes through the gated `coreNetworkRequest` (`network.fetch:<host>` grants, https only); `speckle.receive` writes a Speckle model's walls, floors, roofs, columns and beams, and reports what it cannot map |
| `script.run` | one node | JavaScript in the QuickJS sandbox with the sandbox `bim` API |

## Usage

```ts
import { runFlow, parseFlowDocument } from '@ifc-lite/flow';
import { createStandardRegistry, BROWSER_FEATURES } from '@ifc-lite/flow-nodes';

const registry = createStandardRegistry();
const doc = parseFlowDocument(await (await fetch('/flows/audit.flow.json')).text());
const result = await runFlow(doc, { host: { bim }, registry, features: BROWSER_FEATURES });
```

`host.grants` (parsed capabilities from `@ifc-lite/extensions`) gates every node;
omit it only for a trusted caller such as the CLI running a local file.

## License

MPL-2.0
