# @ifc-lite/sdk

The scripting SDK for ifc-lite: a single `bim.*` API for BIM automation. One context object exposes querying, properties, mutations, viewer control, exports (CSV, glTF, STEP, HBJSON), IDS validation, BCF collaboration, clash detection, 2D drawings, schedules, lists, lenses, and element creation. The same API runs embedded in the viewer, connected across tabs, in Node scripts via the CLI (`ifc-lite eval` / `ifc-lite run`), and inside the QuickJS sandbox.

## Install

```bash
npm install @ifc-lite/sdk
```

## Usage

```ts
import { createBimContext } from '@ifc-lite/sdk';

// Embedded mode (local backend)
const bim = createBimContext({ backend: myLocalBackend });

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
- `bim.export` - CSV, glTF, STEP, HBJSON
- `bim.ids` / `bim.bcf` / `bim.clash` - validation, collaboration, interference checks
- `bim.drawing` / `bim.list` / `bim.lens` - section cuts and SVG, schedules, rule-based coloring
- `bim.create` / `bim.spaces` / `bim.spatial` / `bim.schedule` / `bim.files` / `bim.events` / `bim.bsdd` / `bim.sandbox`

Also exported: `BimHost` (viewer side), `RemoteBackend`, `MessagePortTransport`, and the full `IfcCreator` API re-exported from `@ifc-lite/create`.

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
