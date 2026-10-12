# @ifc-lite/sdk

The scripting SDK for ifc-lite: a single `bim.*` API for BIM automation. One context object exposes querying, properties, mutations, viewer control, exports (CSV, JSON, IFC/STEP, HBJSON, DFJSON), IDS validation, BCF collaboration, clash detection, 2D drawings, schedules, lists, lenses, and element creation. The same API runs embedded in the viewer, connected across tabs, in Node scripts via the CLI (`ifc-lite eval` / `ifc-lite run`), and inside the QuickJS sandbox.

## Install

```bash
npm install @ifc-lite/sdk
```

## Usage

```ts
import { createBimContext } from '@ifc-lite/sdk';

// Embedded mode: a backend drives a loaded model. `BimBackend` is a
// 16-namespace interface, so use a ready-made one rather than writing it --
// `HeadlessLikeBackend` from @ifc-lite/mcp is the exported headless backend.
import { HeadlessLikeBackend } from '@ifc-lite/mcp';
const bim = createBimContext({ backend: new HeadlessLikeBackend(store, 'model.ifc', 'model-1') });

// Connected mode (cross-tab)
import { BroadcastTransport } from '@ifc-lite/sdk';
const transport = new BroadcastTransport('ifc-lite');
const remote = createBimContext({ transport });

// Use the API
const walls = bim.query().byType('IfcWall').toArray();
bim.viewer.colorize(walls.map(w => w.ref), '#ff0000');
```

## Namespaces

- `bim.query()` - fluent entity queries by type, property, quantity
- `bim.model` / `bim.mutate` / `bim.store` - model info, edits, raw store access
- `bim.store.addWall` / `addColumn` / `addSlab` / `addBeam` / `addSpace` /
  `addRoof` / `addPlate` / `addMember` - ordinary loaded-model creation through
  the shared atomic core. Host adapters compose these existing methods with
  `createOrdinaryStoreBackend(resolveModel)`; the resolver supplies the live
  store, editor and mutation view. Existing strict anchor placement is retained.
- `bim.store.addColumn` / `addBeam` / `addMember` accept canonical parameterised
  `Profile` sections in place of rectangular dimensions. Columns also accept
  storey-local `RefDirection`; dimensions remain metres in every model unit.
- `bim.store.joinWalls(modelId, aExpressId, bExpressId, options?)` - join straight
  walls through the same atomic core as the Model workspace and MCP. Returns
  `IfcRelConnectsPathElements`; `Name`, `priority`, `tolerance` and per-wall
  `priorities` use the existing `WallJoinApplyOptions` contract. Readable hosted
  cuts must fit both joined end faces. The viewer records one undo and remeshes
  both walls; headless export writes the new IFC graph.
- `bim.store.addStair` / `addRailing` - canonical stair/railing parameters in
  storey-local metres. `removeStair(ref)` removes a uniquely owned parent/flight
  pair, retains shared geometry and refuses ambiguous ownership or foreign
  product references. Backend capabilities are optional; unsupported hosts
  refuse explicitly. `replaceElement(ref, storeyId, element)` stages removal
  and canonical creation together, retaining the old graph on late refusal.
  Generic `removeEntity` retains its one-record contract.
- `bim.viewer` - selection, visibility, colorization, camera, sections
- `bim.store.addGroup` / `readGroup` / `updateGroup` / `removeGroup` - exact
  generic `IfcGroup` lifecycle in IFC4/IFC4X3 through the shared native owner.
  Member identities include `modelId`, `expressId`, and current `GlobalId`.
  Updates replace the complete explicit `RelatedObjects` list and preserve
  group identity; `[]` removes owned membership edges. Deletion keeps members
  and their other group memberships, and refuses protected dependencies.
  The viewer publishes one Undo batch; unsupported hosts refuse explicitly.
- `bim.export` - `csv`, `json`, `ifc` (STEP), `hbjson`, `dfjson`, `download`
- `bim.ids` / `bim.bcf` / `bim.clash` - validation, collaboration, interference checks
- `bim.drawing` / `bim.list` / `bim.lens` - section cuts and SVG, schedules, rule-based coloring
- `bim.cost` - canonical IFC 5D graph and decimal-string item/value evaluation
- `bim.create` / `bim.spaces` / `bim.spatial` / `bim.schedule` / `bim.files` / `bim.events` / `bim.bsdd` / `bim.sandbox`

Cost reads describe the loaded IFC source snapshot. Every STEP reference is an
`EntityRef` (`{ modelId, expressId }`); pending generic mutation overlays are
not silently folded into the graph.

Cost authoring hosts can call `resolveLiveOwnerHistoryId(store, editor, view)`
with the editor's `MutablePropertyView` to choose from the effective entity set,
including overlay-created or retyped `IfcOwnerHistory` records. The older
two-argument call remains source-only and skips deleted source records.

Also exported: `BimHost` (viewer side), `RemoteBackend`, `MessagePortTransport`, and the full `IfcCreator` API re-exported from `@ifc-lite/create`.

## Native Review facts

The pure `@ifc-lite/sdk/review` subpath shares the viewer's native validation
and BCF finding normalization, coordination cards and identity resolution.
Pass actual native reports and model lookup functions to `validationFindings`
and `snapshotFrom`; no analysis or mutation is performed. Native statuses,
historical candidates and collector failures remain distinct. Native
evaluation caps remain incomplete; hiding passing detail rows retains complete
coverage when native evaluated counts cover the population. Existing
model-name card keys do not establish durable source or captured-run identity.
See the [SDK guide](https://ifclite.dev/docs/guide/scripting-sdk/#native-review-normalization).

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0

Direct SDK property writes can supply an optional IFC datatype: `bim.mutate.setProperty(ref, "Pset_WallCommon", "ThermalTransmittance", 1, "IfcThermalTransmittanceMeasure")`. Declarations are schema-validated and retained through STEP export; omitted datatypes retain existing inference. See the [SDK guide](https://ifclite.dev/docs/guide/scripting-sdk/).

The Review leaf also provides `NativeReviewCaptures` and `readNativeReview` for
real native host producers. Capture starts before evaluation, binds full source
SHA-256 and owner/store/view revision, then retains cloned native facts/counts.
Reads revalidate source ownership, withhold entire out-of-scope target envelopes
and report incomplete/unsupported/bounded coverage. These live captures do not
claim portable historical recovery. See [the native capture contract](../../docs/guide/scripting-sdk.md#native-review-capture-lifecycle).

Native Review capture retention separates 32 pending operations from 32 settled producer/definition/source contexts. Successful reruns replace matching contexts; failures abandon pending reservations and preserve earlier matching facts as historical evidence. Distinct-context eviction reports unknown omitted history rather than complete coverage. Operation ordering is established before source proof awaits. See [the retention and failure contract](../../docs/guide/scripting-sdk.md#native-review-capture-lifecycle).
