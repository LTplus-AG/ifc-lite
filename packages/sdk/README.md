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
- `bim.viewer` - selection, visibility, colorization, camera, sections
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

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
