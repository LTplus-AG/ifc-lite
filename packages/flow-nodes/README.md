# @ifc-lite/flow-nodes

The standard node library for [`@ifc-lite/flow`](https://www.npmjs.com/package/@ifc-lite/flow),
built on the ifc-lite SDK (`BimContext`). Portable nodes run in the viewer and in the headless CLI. Nodes requiring
viewer session services report unavailable on hosts that do not supply them.

## Node families

| Family | Nodes | Notes |
|---|---|---|
| `core.*` | number, string, boolean, list, math, compare, concat, count, sum, filter, wrap, flatten, groupBy, keys, lookup | The complete restructuring set for one keyed level |
| `model.*` | select (IfcOpenShell selector), byType, attribute, property, quantity, related, storey, contains, groupByStorey, groupByType | Reads are memoised against the model revision |
| `table.*` | fromEntities, longFormat, column, groupRows, pivot, rowCount | Typed columns with IFC value types and pset/prop bindings |
| `viewer.*` | colorize, isolate, select, selection, flyTo | `noop` on a headless host; entities pass through |
| `model.set*` | setProperty, setAttribute | Capability-checked against the actual pset (`model.mutate:<Pset>`) |
| `http.request`, `speckle.receive` | network | Every request goes through the gated `coreNetworkRequest` (`network.fetch:<host>` grants, https only); `speckle.receive` writes a Speckle model's walls, floors, roofs, columns and beams, and reports what it cannot map |
| `session.*`, `validation.runChecks`, `comparison.runChecks`, `report.*` | local loading, filename tags, checks, historical reports, documents and PDF artifacts | Require explicit `SessionAutomationHost` services; unavailable on the standard CLI/MCP host |
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

## Stair and railing authoring

`element.stair` and `element.railing` produce specs for the existing tracked
`model.addElement` node. Their PascalCase parameters reuse the canonical SDK
builders; dimensions are storey-local metres. Stair update/removal removes the
uniquely owned parent/flight pair, retaining shared representation leaves and
refusing ambiguous ownership or foreign product references. Unsupported backend
capabilities refuse explicitly. All `model.addElement` updates use the optional
atomic replacement capability, preserving the old graph and tracking entry
on refusal, including a spec-kind change. Reuse a tracking store for keep/update/remove;
public MCP `run_flow` starts fresh tracking on each call.

## Session automation host

The seven standard automation definitions call `host.automation` and pass the
run's `AbortSignal` through every host boundary. Advertise only the backend
features for services actually supplied: `sessionModels`, `modelTags`,
`validationChecks`, `comparisonChecks`, `comparisonReports`, `reportDocuments`
and `pdfArtifacts`. These are deliberately absent from `BROWSER_FEATURES` and
`headlessFeatures()`. Missing services are unavailable, never no-op.

Each boundary enforces its declared grants: `model.create`, `model.read`,
`storage.write:modelTags`, `storage.write:validationReports`,
`storage.write:savedComparisons`, `storage.write:documents` and
`export.create:pdf`. Use exact grants or the capability system's supported
wildcards; declaring a backend feature does not grant write permission.

`ModelSelector` supports qualified file slots, exact original filenames and
normalized tag names. A comparison role must resolve exactly one model. A check
job has a stable `id`, `enabled` flag, embedded or external-slot `source`, optional
`targets` and portable tag-reference bindings. `parseCheckJobs` rejects duplicate
job IDs. `parseTagRules` validates bounded filename rules; overlapping matches
union their tag names.

Validation/comparison nodes return opaque report tokens. `report.buildDocument`
accepts separate validation, rerun-comparison and imported historical tokens;
`report.exportPdf` returns an artifact token. The viewer owns native snapshots,
retention warnings, document preparation, Blob lifetime and explicit download.
Importing completed comparison evidence preserves its original date and does
not rerun a comparison against the loaded models.

## License

MPL-2.0

The separate `@ifc-lite/flow-nodes/ai` entry includes `ai.propose`: a bounded,
review-required draft over selected finding columns and explicit native
field/value constraints. Its portable `model.changes` output cites captured
rows and expected values, and performs no writes. Current-state validation and
mutation approval remain native host responsibilities. See the
[AI node and checkpoint contract](../../docs/guide/flow.md#ai-nodes-and-review-checkpoints).
