# Rhino .3dm import, level 1: read-only

Status: **implemented**. The reader, `readRhino3dm` in
`@ifc-lite/rhino3dm` (delivery step 1), the viewer load (step 2: format
detection, the import worker and its client, the adapter and the `loadFile`
branch), the tree, hidden state and model metadata (step 3) and the e2e
overlay test and user guide (step 4) are implemented with their tests. The
exporter's spatial layer stamps (step 0) shipped separately.
Decisions D1 to D8 are made. The user-facing page is
[Rhino .3dm](../guide/rhino-3dm.md). This page is the contract for opening a Rhino
`.3dm` in the viewer, or adding one to a federation, as a read-only model:
meshes, layers, colours, Attribute User Text and, for files ifc-lite exported,
the IFC identity of every object.
Companion of [Rhino .3dm export](rhino-3dm-export.md).

Evidence tags as in the export spec: **[ran]** measured or round-tripped with
rhino3dm.js 8.35.0 in Node 22 during drafting, **[src]** read in the rhino3dm
source, its `.d.ts`, or this repo, **[unproven]** not yet confirmed.

The experiment scripts are throwaway scratch files. The numbers below are
copied from their output. Findings marked **[test]** are asserted by the
package tests in `packages/rhino3dm/src/read/`.

Test inputs:

- `AC20-FZK-Haus.3dm` and `duplex.3dm`, written by our exporter.
- `fzk-far.3dm` and `fzk-far-world.3dm`, the FZK house with its site moved to
  (2,600,000, 1,200,000, 400) m, exported `local` and `world`.
- Duplex exported with and without `--no-instancing`.
- Rhino-authored samples from `mcneel/opennurbs` `example_files/V7`, `V8`
  (branch 8.x) and `mcneel/rhino3dm` `tests/models` (tag 8.35.0).

## Goals

1. `.3dm` opens through the one load path, `useIfcLoader.loadFile(file, target)`,
   as primary or federated model (AGENTS.md "one canonical load path").
2. A `.3dm` that ifc-lite exported comes back with each element's GlobalId,
   IFC class and property sets. The geometry lands exactly on the source IFC
   model when both are loaded.
3. A `.3dm` authored in Rhino shows its geometry with Rhino's colours and layer
   tree, and its user text as properties.
4. Parsing never blocks the main thread. The 2.67 MB rhino3dm wasm loads only
   when a `.3dm` is first opened or exported.

Non-goals for level 1: editing, writing back, exact NURBS display,
annotations, textures, linked block files, and reading through the CLI or MCP.
See [Level 2](#level-2-outlook-round-trip-back-to-ifc).

## What rhino3dm.js 8.35.0 can read

| Question | Finding | Tag |
|---|---|---|
| Read entry | `File3dm.fromByteArray(Uint8Array)`. Returns `null` for garbage, empty input and a file truncated to 1 MB. It does not throw. | [ran] |
| Read speed | FZK 2.1 MB: 45 ms. Duplex 3.1 MB: 42 ms. One 1 M-vertex mesh, 13.6 MB: 868 ms. 4.84 M vertices, 118 MB: 2.4 s, plus 0.56 s to extract all buffers. | [ran] |
| Memory | Reading the 118 MB file raised process RSS by about 590 MB (about 5× the file size). The module exposes no heap getter. Writing a 355 MB file aborted (`Aborted()`) inside the 2 GB wasm32 heap. Reading at the heap limit does not abort: `fromByteArray` returns `null` (see [Size ceiling](#size-ceiling)). | [ran] |
| Brep / Extrusion meshing | **No mesher in the JS binding.** There is no `createFromBrep` among the wasm's exported names. Only the cached meshes stored in the file are available, through `BrepFace.getMesh(MeshType.Any)` and `Extrusion.getMesh(MeshType.Any)`. | [ran] (strings of `rhino3dm.wasm`), [src] |
| Are render meshes cached? | In Rhino-saved files, usually yes: `v7_rhino_logo_nurbs` has 6 of 6 Breps meshed (32,044 tris), `v8_selective_clipping` 12 of 12 surface objects. Some Rhino 8 files carry none: `blocks.3dm`, `file3dm_stuff.3dm` (1 of 8) and `object_UserStrings.3dm` (0 of 1). Files written by openNURBS or rhino3dm alone never have them (`v7_my_brep`). | [ran] |
| SubD | `Mesh.createFromSubDControlNet(subd, false)` returns the control net. `subd.subdivide(n)` refines it 4× per level: the logo goes from 1,538 tris to 6,244, 24,976, then 99,904 (36 ms at level 3). Calling `subdivide()` with no argument returns `false`. The `.d.ts` hides both the argument and the second parameter. | [ran], [src] (`bnd_subd.cpp`, `bnd_mesh.cpp`) |
| Mesh buffers | `Mesh.toThreejsBuffers(false)` returns `{position: Float32Array, normal, index: Uint32Array, vertexCount}`, splits quads (one quad gives `[0,1,2, 2,3,0]`) and fills normals. | [ran] |
| Precision | Vertices are stored as doubles (`useDoublePrecisionVertices` was true on all 331 of our meshes). `toThreejsBuffers` emits f32: (2,600,000.123, 1,200,000.456) came back as (2,600,000, 1,200,000.5). After `geometry.translate([-ox, -oy, -oz])` the same call returns 0.123 / 0.456 exactly to f32. | [ran] |
| Blocks | `InstanceReference.parentIdefId` plus `xform` give the placement. `xform.toFloatArray(true)` is row-major with the translation at indices 3, 7, 11, but **rounds to f32**: a translation of 2,600,000.123 came back as 2,600,000. The `m00`..`m33` properties are the doubles, so the reader uses those. `InstanceDefinition.getObjectIds()` gives the member ids. Members have `isInstanceDefinitionObject = true` and `mode = InstanceDefinitionObject`. A member may reference a definition that is not in the file, and a definition that contains itself reads back without complaint. | [ran], [test] |
| Linked blocks | `InstanceDefinition.updateType` and `sourceArchive` exist. Linked geometry is not in the file. | [src], not tested |
| Layers | `name`, `fullPath` (`A::B::C`), `id`, `parentLayerId`, `color`, `visible`, `locked`. Layers also carry user strings: `Layer.setUserString` survives a write and read. | [ran] |
| Object attributes | `id` (UUID), `name`, `layerIndex`, `colorSource`, `objectColor` (RGBA), `materialSource`, `materialIndex`, `visible`, `mode`, `getGroupList()`, `getUserStrings()` (an array of `[key, value]`). | [ran] |
| Materials | `name`, `diffuseColor`, `transparency`. Material has no `index` property. Rhino 8 render materials were not checked. | [ran], [unproven] |
| Document | `strings()` returns `[key, value]` pairs: our 8 `IFC::*` keys came back. `settings().modelUnitSystem` and `earthAnchorPoint`. `CustomUnits` has no scale in the JS settings object. | [ran] |
| Earth anchor | Rhino 8 files report `earthLocationIsSet() = true` with lat/lon 0/0 by default (all 6 McNeel Rhino 8 samples). Older files report `false` with sentinel −1.23e308. | [ran] |
| Archive version | ASCII digits at bytes 24..31 of the header (`3D Geometry File Format       70`), readable without wasm. Rhino 9 files were not tested. | [ran] (header bytes), [unproven] (V9) |
| Other types seen | `NurbsCurve`, `PolylineCurve`, `ArcCurve`, `LineCurve`, `PolyCurve`, `Point`, `PointCloud`, `TextDot`, `Text`, `Hatch`, `DimLinear`, `DimRadial`, `Surface` (the clipping planes in the two V8 section samples). | [ran] |
| Curves | `Curve.tryGetPolyline()` returns a `Polyline` (`count`, `get(i)`) or null. Any curve answers `domain`, `spanCount`, `pointAt(t)` and `isClosed`. | [ran], [test] |
| Point clouds, text dots | `PointCloud.getPoints()` and `getColors()` return arrays (colours as `{r,g,b,a}`), `containsColors` says whether there are any. `TextDot.point` and `text`. | [ran], [test] |
| Enums | Enum values are objects with a numeric `value`, compared by `value`. `UnitSystem` values are openNURBS's, not the declaration order: `Millimeters` is 2. | [ran] |
| Object wrappers | `File3dmObject.geometry()` is a view into the document, not a copy: `translate()` on it moves the stored geometry. `attributes().layerIndex` can be -1 (`subd_creases.3dm`). String table rows are plain `[key, value]` arrays with nothing to release. | [ran] |
| Writing for tests | `BrepFace.setMesh(mesh, MeshType)` and `Extrusion.setMesh` attach a render mesh, so a test can craft a meshed Brep. There is no SubD constructor. Chunks carry a CRC-32 that `fromByteArray` enforces: a patched byte without a repaired CRC reads as `null`. | [ran], [test] |

## Our own exports read back

| Check | FZK | Duplex | Tag |
|---|---|---|---|
| Objects (mesh + instance) | 73 + 45 | 271 + 38 | [ran] |
| Distinct `IFC::GlobalId` | 90 | 236 | [ran] |
| GlobalIds spread over more than one object | 16 | 46. All 108 grouped objects sit in a Rhino group whose name is the GlobalId. | [ran] |
| `IFC::WorldFromModel` | absent (no shift) | absent | [ran] |
| Instanced export, baked, against the `--no-instancing` export | n/a | worst bbox corner gap per GlobalId 8.3e-7 m | [ran] |
| `fzk-far` `local`, mapped by `IFC::WorldFromModel`, against the `world` export | gap 0 m over 90 elements | n/a | [ran] |

Two consequences for the exporter, both confirmed on `fzk-far`:

- **`IFC::WorldFromModel` was written under `--coordinates world` too**,
  although the vertices are already in world coordinates there. Applying it
  again moved every object by 2.6e6 m [ran]. Fixed in the exporter before it
  shipped (decision D1); the importer still applies it only when
  `IFC::Coordinates` is `local`, for files written before the fix.
- The export disables instancing for site-local georeferenced models
  (`fzk-far.3dm` has 0 instance definitions [ran]), as its spec says.

## Architecture

Two modules and one seam, mirroring the export:

```
.3dm bytes ─► rhinoImport.worker.ts ─► @ifc-lite/rhino3dm  readRhino3dm()   (deep: all Rhino interpretation)
                                         │  RhinoImport (plain data, typed arrays, Z-up, metres)
                                         ▼
              worker: axis swap into viewer Y-up, transfer buffers
                                         │  postMessage(RhinoImportMessage, transfer)
                                         ▼
main thread:  rhinoViewerModel.ts  (shallow adapter: RhinoImport ─► IfcDataStore + MeshData[])
                                         ▼
              useIfcLoader.loadFile ─► finalizeModel(...)   (unchanged, shared with every format)
```

- **`readRhino3dm` in `@ifc-lite/rhino3dm`** is the deep module. Its interface
  is one function and one result type. It hides colour-source resolution, block
  flattening and baking, the cycle and budget guards, units, the frame restore,
  SubD refinement, curve sampling, user-text parsing into property sets, class
  validation, GlobalId merging and embind cleanup. It knows nothing about the
  viewer. It lives next to `writeRhino3dm`, sharing
  `loadRhino` and `dispose` (`packages/rhino3dm/src/runtime.ts`) [src].
  Level 2 (CLI and MCP reading `.3dm`) reuses it unchanged.
- **The seam is the `RhinoImport` type** below. Tests drive the deep module
  through it in Node with the real rhino3dm, with no viewer involved.
- **`rhinoViewerModel.ts` in `apps/viewer/src/hooks/ingest/`** is the shallow
  adapter. It builds string, entity and property tables with the
  `@ifc-lite/data` builders (`EntityTableBuilder`, `PropertyTableBuilder`
  [src]) and returns a `ViewerModelPayload` like `parseIfcxViewerModel` does.
  It has no `if (rhino type …)` branch: an adapter that needs one is a bug in
  `RhinoImport`.
- **What the caller learns:** `loadFile` learns one new format value, `'3dm'`,
  and calls one function, `prepareRhinoViewerModel(file, buffer, onProgress, signal)`.
  Nothing else in the viewer learns that Rhino exists, except the layer tree
  builder (decision D3).

### Reuse, not a new path

Reuse the IFCX shape: a populated store plus `MeshData[]` through
`finalizeModel`. Rejected alternatives:

| Option | Why not |
|---|---|
| GLB-style entity-less synthetic store | `createSyntheticDataStore` always builds empty property tables (`packages/parser/src/synthetic-data-store.ts:108-110`) [src]. No properties and no tree, which defeats the point of user text. |
| LandXML-style side document with its own pick channel and inspector | A second selection channel and a second properties UI. Search, IDS, lists and BCF would all miss Rhino objects. |
| Convert `.3dm` to IFC in wasm, then load the IFC | Needs openNURBS in Rust, which the export spec already rejected (it does not build for `wasm32-unknown-unknown`). |

`buildIfcxDataStore` (`apps/viewer/src/hooks/ingest/viewerModelIngest.ts:143`)
already does the hard part: populated tables, `getEntity` and
`getEntitiesByType` served from the entity table. PR 2 lifts its
format-agnostic body into `buildTabularDataStore(tables, meta)`. IFCX keeps its
current behaviour, pinned by its existing tests, and Rhino calls the same
function. This is a lift, not a fork.

### What the store says about itself

Two separate answers, since #9976 split them.

- **The schema label is `IFC4`.** It names the schema the entity table's type
  names belong to. `IFC::Class` must name an instantiable `IfcProduct` subtype
  of IFC2X3, IFC4 or IFC4X3, the fallback is `IfcBuildingElementProxy`, and
  IFC4 is the schema covering every class the reader can emit as well as the
  house default when a source states none.
- **What backs it is `sourceKind: 'tabular'`**, which `buildTabularDataStore`
  sets for every caller. Every gate meaning "no STEP records behind this
  store" reads that marker, so it keeps refusing a `.3dm` whatever the label
  says: the STEP export, the STEP re-serialization for the energy export, the
  ion upload, the IDS worker, remeshing, registry publishing, the schedule
  splice target and the native authoring commands. Each of those gates is
  pinned by #9976's own tests over a tabular store [src]; a real `.3dm` store
  is driven through the STEP export gate here [test].

The label was `IFC5` while that was how a store with no STEP bytes was
recognised. `IFC5` is not a true statement about a `.3dm`, and it handed one
IFCX behaviour it has no business with: `isIfcxDataStore` answered yes, the
changes export routed to the IFCX exporter, federation re-composed the model
as IFCX overlays, and a room seeded it by re-parsing its bytes as IFCX.

Four sites decided by the label alone and are now gated on the marker in
this PR, because the honest label makes each reachable:

| Site | What it would have done |
|---|---|
| `ExportDialog.tsx`, the merged and STEP branches | written an empty or garbage IFC through `exportModelStep` or the merged exporter. A single-model export stays offered, the description names the model it cannot write, and `exportModelStep` refuses it by name (#10099); a merged one with no writable store is refused up front by `canWriteIfcFromStores`, and the dialog says why (`exportDialog.noStepRecords.error`). Choosing IFC5 in the picker still exports the model as IFCX [ran]. The merged branch asks for ONE writable store rather than all of them, and skips a tabular model the way it skips one with no store, so a `.3dm` or `.ifcx` in the federation does not refuse the merge of the IFC models beside it. |
| `share-scope.ts` `buildShareSeed` | seeded a room slot from STEP records it has none of. `isSeedableModel` leaves the model out, and the Share dialog's seedable count reads the same predicate, so its "{seedable} of {loaded}" notice says what the seed will do. When every model in the share scope is refused (a lone `.3dm`, say), `shareRefusesEveryModel` declines the mint: Create link is disabled and the dialog names the models it cannot share. A `.3dm` beside a GLB or a point cloud still mints the empty owner room those workspaces always got. |
| `useAppearancePanel.ts` | offered appearance authoring, which serializes `IfcSurfaceStyle` records into a STEP source the store has not got. Its own sentence, `appearance.controller.requiresStepRecords`, after the schema branch so IFCX keeps its existing message: the schema refusal would name the schema this store is now labelled. |
| `scan-to-bim/run-detection.ts` `isIfcModel` | made a `.3dm` a proposal target, taking it from a real STEP model in the same workspace. Creation would then refuse on "no storey to place the elements on", but only after the target was already lost. |

One site widens without reaching an export and is left as it is: the
schema-registry readers (`charts/element-field-reader.ts`,
`query/entity-node.ts`, `collab/schema-attribute-names.ts`) now get an IFC4
registry instead of none, which is what the entity table's classes are.

### Where parsing runs

Parsing runs in a one-shot module worker, `apps/viewer/src/workers/rhinoImport.worker.ts`,
copied from `rhinoExport.worker.ts`: the wasm comes in as a Vite `?url` asset
and is passed through `locateFile`, and the worker is terminated when the run
settles or is aborted [src]. One-shot matters more here than on export: an
emscripten `Aborted()` (out of memory) leaves the module unusable [ran], and a
fresh worker per load resets it. There is no main-thread fallback, for the
same reason the export has none.

## The RhinoImport interface (v1)

As shipped in `packages/rhino3dm/src/read/types.ts`. The draft only sketched
blocks, point clouds, curves and text dots; decisions D4 and D6 made them part
of the result, and D2 made `ifcClass` always a class.

```ts
export interface ReadRhino3dmOptions {
  locateFile?: (path: string, prefix: string) => string;
  subdLevel?: 0 | 1 | 2 | 3;        // default 2
  maxTriangles?: number;            // default 30_000_000 drawn, instances counted per placement;
                                    // a vertex costs a third of a triangle, a mesh at least
                                    // its triangles (see Size ceiling);
                                    // a whole count, 0 or more: RangeError otherwise
  bakeInstances?: boolean;          // default false: blocks come back as definitions + instances
  onProgress?: (done: number, total: number) => void;
}
export function readRhino3dm(bytes: Uint8Array, opts?: ReadRhino3dmOptions): Promise<RhinoImport>;

type RhinoVector3 = [number, number, number];
type RhinoColor = [number, number, number, number];   // bytes, 0..255
type RhinoRgba = [number, number, number, number];    // sRGB 0..1, as MeshData.color
type RhinoUserStrings = [string, string][];

export interface RhinoImport {
  format: 'ifc-lite.rhino-import'; version: 1;
  document: {
    archiveVersion: number;                 // 50, 60, 70, 80
    application: string;                    // "Rhinoceros 8", "" for ours
    unitSystem: string; metersPerUnit: number;
    provenance: 'ifc-lite' | 'rhino';       // 'ifc-lite' iff IFC::Exporter starts with "ifc-lite"
    frame: 'ifc-world-from-model' | 'file'; // was IFC::WorldFromModel applied
    earthAnchor: null | { latitude: number; longitude: number; elevation: number; modelBasePoint: RhinoVector3 };
    strings: RhinoUserStrings;              // document strings / document user text
  };
  layers: {
    name: string; fullPath: string; parent: number | null; color: RhinoColor; visible: boolean;
    userStrings: RhinoUserStrings;
    spatial: null | { globalId: string; ifcClass: string; elevation: number | null };  // from the layer stamps
  }[];
  entities: {
    globalId: string;                       // always a valid 22-char IFC GUID, unique in the file
    ifcClass: string;                       // IFC::Class when valid, else IfcBuildingElementProxy
    name: string; description: string; objectType: string;
    layer: number;
    hidden: boolean;                        // object hidden or any layer on its path off; merged: all parts hidden
    objectIds: string[];                    // Rhino UUIDs merged into this entity
    geometryType: string;                   // Rhino class: "Mesh", "Brep", "InstanceReference", "NurbsCurve", ...
    userStrings: RhinoUserStrings;          // the first object's, verbatim and in file order, then what merged objects add
    propertySets: { name: string; properties: [string, string][] }[];
  }[];
  meshes: (RhinoImportGeometry & { entity: number; color: RhinoRgba; hidden: boolean })[];
  definitions: { name: string; meshes: (RhinoImportGeometry & { color: RhinoRgba | null })[] }[];
  instances: { entity: number; definition: number; transform: number[]; color: RhinoRgba; hidden: boolean }[];
  pointClouds: { entity: number; origin: RhinoVector3; positions: Float32Array; colors: Uint8Array | null; color: RhinoRgba; hidden: boolean }[];
  curves: { entity: number; origin: RhinoVector3; positions: Float32Array; closed: boolean; color: RhinoRgba; hidden: boolean }[];
  textDots: { entity: number; position: RhinoVector3; text: string; color: RhinoRgba; hidden: boolean }[];
  skipped: Record<string, number>;          // by reason/type: "Point": 8, "Brep:no-render-mesh": 3
  warnings: string[];                       // one line per distinct condition
}

interface RhinoImportGeometry {
  origin: RhinoVector3;                     // f64, metres, Z-up
  positions: Float32Array;                  // relative to origin, metres, Z-up
  normals: Float32Array;
  indices: Uint32Array;
}
```

- `meshes`, `pointClouds`, `curves` and `textDots` are in world space, after
  the frame restore.
- `definitions[d].meshes` are a block's own meshes in block space.
  `instances[i].transform` is 16 row-major doubles in metres, frame restore
  included: `world = transform · (origin + position)`. Nested blocks are
  flattened: an instance of a block that nests others yields one record per
  placement, with the transforms composed in doubles. A definition mesh with
  `color: null` takes the colour of the instance placing it.
- A block mesh coloured "by parent" whose own material is transparent is the
  exception: no single definition colour holds "the instance's colour at my
  alpha", so it is a world-space copy in `meshes` per placement, in both
  modes [test]. That gives up instancing for those meshes; a definition mesh
  that carries its own opacity would keep it, and is a change to this
  contract left for a later version.
- With `bakeInstances`, `definitions` and `instances` are empty and every
  placement is a world-space copy in `meshes`. Both modes draw the same
  geometry: a placement that pushes any of its block's meshes out of range
  (see `transform:invalid` below) is baked in the default mode too, so the
  meshes that stay in range are drawn and the others counted [test]. The
  check is on the block's reach, so it can bake a placement whose meshes all
  fit; the geometry drawn is the same.
- Curves, point clouds and text dots inside blocks are always baked, one copy
  per placement. Curves and point clouds are charged to the triangle budget;
  text dots have their own limit of 100,000 per file, and the dots past it are
  counted as `TextDot:limit` and reported in one warning. The limit counts
  every dot the reader visits, including one left out as `TextDot:invalid`,
  and past it a placement's dots are counted in one step, so the limit bounds
  the work too [test].
- `curves[i].positions` is a polyline. A curve that is not a polyline is
  sampled at 32 points per span, at most 8,192 per curve.
- `pointClouds[i].colors` is RGBA bytes per point, or null.
- `hidden` on a mesh, instance, point cloud, curve or text dot is the flag of
  the object that drew it, computed as `entities[i].hidden` is. It equals the
  entity's flag except in an entity that merges parts that differ (see Layers,
  visibility, hierarchy). Added after v1 shipped, in v1: a reader that ignores
  it sees the same result as before.

Guarantees, so the adapter never checks them: every index is in range; layers
come parent first; every number is finite, after unit scaling and after every
transform [test]; triangle indices are in range; each `globalId` is unique
within the file; entities are in file object order, and every geometry list is
ordered by entity. Each typed array appears once and no two share a buffer, so
every `array.buffer` can go on one transfer list, and each record owns its
`color` array [test]. The output is the same for the same bytes and options
[test].

An entity is a top-level object that drew something. An object that draws
nothing (a Brep without render meshes, a block whose members cannot be drawn)
is counted in `skipped` and has no entity.

### Worker wire format

```ts
type RhinoImportRequest  = { type: 'import'; id: number; bytes: Uint8Array };
type RhinoImportResponse =
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'complete'; id: number; result: RhinoImport }   // positions/normals already viewer Y-up
  | { type: 'error'; id: number; code: RhinoImportErrorCode; message: string };
```

- The request transfers `bytes`, so they are a copy of the load's own source
  buffer, never the store's source view (the export client cannot transfer,
  for that reason [src `rhino-export-client.ts`]). A copy rather than a second
  read of the `File`: a re-read halves nothing and lets a file saved again
  mid-load put different bytes behind the geometry and the store.
- `complete` transfers every typed array: mesh, definition, curve and point
  cloud buffers. Plain objects and typed arrays only, so structured clone needs
  no codec.
- The request carries no options: level 1 has no dialog, so the defaults stay
  in the reader. The worker asks for `bakeInstances` until the viewer has a
  GPU instance path (decision D4).
- The axis swap (`x, y, z → x, z, −y`, `ifcToViewerAxes` in
  `packages/geometry/src/world-frame.ts`) runs in the worker, on `origin` and
  on the f32 positions and normals. The package stays Z-up and
  viewer-agnostic, and the main thread does no per-vertex work on meshes.
  Under `bakeInstances` there are no instance transforms to conjugate; that
  arrives with the instance path, and until then an unbaked result reaching
  the swap is an error rather than a silent loss of geometry.
- Point clouds are the exception to "no per-vertex work": `PointCloudAsset`
  takes the reader's f64 origin and f32 offsets as they are (#10029), but it
  wants 0..1 float colours and a bounding box, so the adapter widens the
  colours and takes the bounds in one pass per point. Stating float colours
  and a bounding box in `RhinoImport` would move that into the reader, and is
  a change to this contract.

## Mapping

### Format detection and entry

- `detectFormat` (`packages/ifcx/src/detect-format.ts:12`) gains `'3dm'`: the
  first 24 bytes are `3D Geometry File Format ` [ran]. Today a `.3dm` falls
  through to `unknown` and on into the IFC wasm path.
- `.3dm` joins `MODEL_FILE_EXTENSIONS` and `MOBILE_MODEL_FILE_EXTENSIONS`
  (`apps/viewer/src/services/supported-model-files.ts:22-50`), and the drop
  filter reads those lists.
- `loadFile` branches on `'3dm'` beside IFCX and GLB
  (`useIfcLoader.ts:982-1071`), then goes through `finalizeModel` like every
  format [src]. `loadPath: '3dm'` goes in the load report.

### Units and frame

- Positions are scaled to metres with a table covering every `UnitSystem`
  member [ran: member list]. `None`, `Unset` and `CustomUnits` fall back to
  metres with a warning: rhino3dm.js exposes no custom scale [test].
- **Frame restore:** when `IFC::Coordinates` is `local` and
  `IFC::WorldFromModel` is present, every point maps through
  `world = W · (p · metersPerUnit)`, where W holds 16 row-major numbers in
  metres [src: export spec]. `document.frame` is then `ifc-world-from-model`.
  Proven exact on `fzk-far` [ran]. W has to be affine: a last row other than
  `0 0 0 1` (beyond 1e-12 of rounding noise) is a projection, which the reader
  does not apply, so such a W is ignored with a warning and `frame` stays
  `file` [test].
- Otherwise the file coordinates (in metres) are used as they are, like GLB,
  and `frame` is `file`.
- **Precision:** per mesh, `origin` is the f64 world point of its first vertex
  (`point3dAt(0)`, after W). The reader calls
  `geometry.translate(-origin_in_file_units)` before `toThreejsBuffers`, so the
  f32 values stay small: a vertex at 2,600,000.123 m comes back as
  `origin + position` to 1e-6 m [test]. Curves and point clouds get the same
  origin-plus-offset form. Under a non-identity W, it applies the 3×3 part of W
  to the f32 offsets and all of W to `origin` in f64. W from our exporter is a
  pure translation in every case seen so far [ran]. A W with rotation is
  covered by a crafted file [test], not by a real export [unproven].
- **Federation alignment:** with no `spatialReference` in the payload,
  `finalizeFederatedSpatialPlacement` leaves the model at status `none`, and
  `convergeFederationRtcFrame` reads the coordinates as absolute world [src,
  from the survey of `federatedSpatialFinalize.ts` and `federationRtcRebase.ts`].
  For our exports this lands on the source IFC model: the viewer's IFC world
  **is** the exporter's `MeshFrame` world. Measured in the browser by
  `tests/e2e/rhino-import.e2e.spec.ts`, which exports FZK through the app's own
  `export:3dm`, adds the file back as a federated model and compares the two
  models' per-GlobalId world AABBs: all 90 drawn elements matched, worst corner
  gap 4.17e-7 m (x 4.17e-7, y 1.19e-7, z 2.38e-7), in both `local` and `world`
  coordinates [ran]. That is the f32 resolution of the vertex buffers, not a
  placement difference. The same spec is the only evidence for a georeferenced
  model: FZK sits at the origin, so no `IFC::WorldFromModel` is written and the
  frame restore is exercised by `exports.test.ts` on `fzk-far`, not here
  [unproven in the browser: a shifted model through the viewer's RTC rebase].
- **Earth anchor:** reported in `document.earthAnchor` and shown in model
  metadata. The reader never moves geometry by it. `modelBasePoint` is a model
  coordinate, so it is scaled to metres and mapped through W like the rest
  [test]. Rhino 8's default 0/0
  anchor [ran] is indistinguishable from a real one at Null Island, so the
  reader reports it as `null` (decision D5). Turning a real lat/lon into the
  federation's CRS needs a projection, which is the viewer's step.

### Entities and identity

| Rhino | Entity |
|---|---|
| Top-level object (not an instance definition member) that draws something | one entity |
| Objects sharing a valid `IFC::GlobalId` **and** a group named that GlobalId | one entity, many meshes, the user text of every part: our grouped elements, 16 in FZK, 46 in duplex [test] |
| Object sharing a GlobalId already taken, without that group (a Rhino copy-paste keeps user text) | its own entity under a derived id, keeping the stated GlobalId in its properties, plus one warning per file [test] |
| `InstanceReference` | one entity; its placements go to `instances`, or to `meshes` when baked |
| Instance definition member | no entity of its own |
| Object that draws nothing | no entity; counted in `skipped` |

- **GlobalId:** a valid `IFC::GlobalId` (`isValidIfcGuid`, `@ifc-lite/encoding`
  [src]) when unique per the rule above. Otherwise the Rhino object UUID
  compressed with `uuidToIfcGuid` [src], which is lossless and the inverse of
  how the export derives `objectId`. Merging needs the group in any file,
  ifc-lite's or not (decision D8); the group owns the GlobalId even when an
  ungrouped copy comes first in the file. Every stated GlobalId is reserved
  before any id is derived, so a derived id never takes one that another object
  states [test]. User-text keys are matched ignoring case, as openNURBS stores
  them.
- **User text of a merged entity:** the union of its parts, in file order.
  The first part's user text stays verbatim. Keys are compared ignoring case
  and, for the `IFC` and `Rhino` sets, spaces around the set name. Two keys
  are the same key only when they compare equal: a stated `<key> #2` (the
  suffix the exporter uses for colliding names) is a key of its own, not a
  repeat of `<key>`. Each entry of a later part, read in order, falls under
  one of three cases. (1) The entity does not hold the key: the entry is
  appended as written. (2) The entity holds the key, and the value is one
  already merged for that key, under the key or under a number generated for
  it: the entry is dropped. This is the only case that drops anything, so an
  equal value under a different key always stays. (3) The entity holds the key
  with other values: the entry is appended as `<key> #<n>`, the key as that
  part writes it. `n` counts up from 2 for each key and skips every name that
  any part of the entity states, in an earlier or a later part, and every name
  already generated. So a generated name never equals a stated one, and the
  first part to state a key keeps it as written. No value is lost, and the
  entity columns are read from the parts rather than from the merged list:
  each column is the first part that states a value for it, an empty value
  counting as unset [test]. There is no warning, because differing values are
  the normal case: the exporter writes each part's own `IFC::Material`, so all
  16 merged elements in FZK and all 46 in duplex differ there and come back
  with `IFC::Material` and `IFC::Material #2` [ran, test].
  `layer`, `geometryType` and the `Rhino` set describe the first part;
  `objectIds` lists them all.
- **Class:** `IFC::Class` when it names an instantiable subtype of `IfcProduct`
  in IFC2X3, IFC4 or IFC4X3, whatever the file's provenance, so a Rhino user
  can choose the class by setting that user text. Otherwise
  `IfcBuildingElementProxy`; a name that is present but not such a class adds
  one warning, and the rejected value stays in the `IFC` property set
  (decision D2) [test].
- **Express ids** are sequential from 1 in entity order (the adapter assigns
  them), so `getMaxExpressId` and the federation offset work unchanged.
  `IFC::ExpressId` is kept as a property, never reused as the id: it is unique
  only in the source IFC.
- **Name:** `IFC::Name`, else the Rhino object name, else the geometry type.

### Geometry

| Rhino type | Level 1 |
|---|---|
| `Mesh` | as stored; quads split, normals filled |
| `Brep` | cached render meshes, all faces merged into one mesh. A Brep with none is counted as `Brep:no-render-mesh`; a partly meshed Brep shows the meshed faces and warns. |
| `Extrusion` | its cached render mesh, else `Extrusion:no-render-mesh` |
| `SubD` | control net after `subdivide(subdLevel)`, default 2. An approximation of the limit surface, and labelled as one in the warning. |
| `InstanceReference` | definitions plus instance transforms (decision D4), or baked with `bakeInstances` |
| `PointCloud` | `pointClouds`: positions and optional per-point colours (decision D6) |
| Curves (`NurbsCurve`, `PolylineCurve`, `ArcCurve`, `LineCurve`, `PolyCurve`) | `curves`: a polyline, sampled when the curve is not one (decision D6) |
| `TextDot` | `textDots`: position and text (decision D6) |
| `Point`, `Text`, `Hatch`, dimensions, lights, clipping planes and other bare surfaces | skipped and counted by class name, never an error |

A mesh with no vertices or faces is counted as `<Type>:empty`, and one with a
non-finite coordinate or an index out of range as `<Type>:invalid`. So is a
curve or point cloud with an offset that f32 cannot hold: the check reads the
stored f32, not the double it came from [test].

**Blocks.** Decision D4 is GPU instancing, so by default the reader does not
bake: it returns each block's own meshes once and one instance record per
placement. A caller that cannot instance passes `bakeInstances`; both modes
draw the same world geometry [test: crafted nested blocks, and duplex against
its `--no-instancing` export]. A baked copy under a mirroring transform has
its winding flipped and its normals transformed by the inverse transpose
[test]. The walk follows AGENTS.md "Bounding walks":

- It is iterative, with an explicit stack.
- Its visited set is **path-scoped**, because geometry accumulates: the same
  definition reached down two branches is two real copies, while a definition
  inside itself is a cycle. The cycle is skipped, counted as
  `InstanceReference:cycle` and reported [test: a crafted self-referencing
  definition].
- A **drawing budget** caps drawn triangles at `maxTriangles`, a block's
  cost counted once per placement in both modes, and a placement's block
  meshes admitted whole or left out whole (see Size ceiling). A vertex is
  charged a third of a triangle when that is more than a part's triangles, at
  top level and per placement:
  without that a 20,000-point cloud in a block placed 500 times came back as
  120 MB with nothing reported [ran, then fixed]. Reaching the budget stops
  drawing for the rest of the file (text dots excepted) and reports how many
  objects were left out (`skipped.budget` and a warning). Bounding and
  reporting are tested separately. The block walk goes on past the budget for
  the dots, also the dots of a block whose other members did not fit, and
  leaves each placement's meshes, curves and point clouds out in one step
  [test]. A branch that leads to no text dot ends at once, so a file without
  dots in blocks spends no placement budget after the triangle budget [test].
- A **placement budget** of 500,000 block references per file bounds a fan-out
  of blocks that hold no triangles, which the triangle budget cannot see: 20
  levels that each reference the next twice are 2^20 placements [test]. Every
  reference the walk reaches is charged, drawn or skipped (missing, linked,
  cyclic, invalid), so references that draw nothing cannot stall it either
  [test]. The limit is checked on every reference, the skipped ones included,
  so the walk stops on the one that spends it instead of running on to the end
  of the block it is in [test]. A part that a placement pushes out of range costs no triangles, so
  it is charged here too, as one reference [test]. Once it is spent, a
  reference that could never be drawn still gets its own reason, not `budget`
  [test].
- A placement whose transform is not finite, has an entry above 1e15, flattens
  space (zero determinant) or is not affine (last row other than `0 0 0 1`) is
  counted as `InstanceReference:invalid`. A last row that is `0 0 0 1` to
  rounding noise is replaced by the exact values before anything is composed
  with it: that noise grows with the translation it meets, and an otherwise
  identity `IFC::WorldFromModel` holding 1e-17 composed with a placement a
  million metres out lands 1e-11 from affine, so a frame that was accepted
  refused every block instance under it [test, both modes].
  Geometry a transform pushes out of the f32 range is counted as
  `transform:invalid` [test]. That is decided before the budget is charged, so
  geometry that is left out costs no triangles [test], and from the part's
  largest |x|, |y| and |z|, measured once: a placement costs the same check
  whatever the vertex count, in both modes. In the default mode one check
  against the block's reach covers all its meshes; only a placement that fails
  it is looked at mesh by mesh, and baked. The bound is per axis, so it can
  refuse a part whose own vertices would just fit, by less than a factor of
  three at 1e38 m.
- A block member that is hidden, or on a layer that is off, is not drawn in
  any instance, as in Rhino, and is counted as `hidden-block-member` [test].
  Unlike a hidden entity it cannot be shown later, because members are not
  entities.
- A member object no definition lists is drawn by nothing, which a deleted or
  damaged definition leaves behind. It is counted as
  `<Class>:orphaned-block-member`, so it does not leave the result without a
  trace of having been in the file [test: a crafted archive with the member
  object's own id renamed].
- A reference to a definition that is not in the file is counted as
  `InstanceReference:missing-definition`. Linked definitions (`updateType`
  linked, no members in the file) are counted and reported [unproven: no
  linked file was tested].

### Appearance

| `colorSource` | Colour |
|---|---|
| `ColorFromObject` | `objectColor` (RGBA). Our export writes alpha here: FZK glass is alpha 31 [ran]. |
| `ColorFromLayer` | the object's layer colour. Inside a block, the member's own layer [openNURBS, ran]. |
| `ColorFromMaterial` | `diffuseColor`, alpha = 1 − `transparency` |
| `ColorFromParent` | the instance's resolved colour; layer colour at top level |

When the colour's alpha is 255 and the object's material has `transparency > 0`,
the material's transparency wins: Rhino displays transparency from the material
[documented, not rendered]. The material is whichever one the object ends up
with, its own, its layer's, or one inherited from a block instance. Colours stay
sRGB, as `MeshData.color`. Each source is covered by a crafted file [test].

#### Block members and "from parent" (#9987)

A member of a block definition can take its colour, its material, or both from
the instance placing it. The resolver is
`ON_3dmObjectAttributes::ApplyParentalControl` in openNURBS, which is the
function Rhino itself uses, so it settles what Rhino draws without needing
Rhino. It was built from
[mcneel/opennurbs](https://github.com/mcneel/opennurbs) `8.x` at
`eb92af3ba1806b0a34a99aba0d3bda83e3d46083` and run over all 144 combinations of
a member's and an instance's two sources. What it does to the member's
attributes:

- a **"by parent" material** is overwritten with the instance's resolved
  material index, and the member's material source becomes
  `MaterialFromObject`. Nothing afterwards can tell the member from one that
  owned that material.
- a **"by parent" colour** is replaced by the instance's colour source and
  value; an instance colour that is itself "by layer" resolves to that
  instance's layer colour.
- **every other source is left alone**, the member's layer index included. The
  layer index is never rewritten, and openNURBS says why in a 2010 comment next
  to the code it disabled: "Color by parent means COLOR and not LAYER".

The reader follows that. `parent` is the placing instance's already-resolved
appearance, so nesting composes outermost first.

| Member `colorSource` | Member `materialSource` | Colour and alpha | Evidence |
|---|---|---|---|
| `ColorFromObject` | `FromLayer`, `FromObject` | its `objectColor`, faded by the material it names | openNURBS, ran [test] |
| `ColorFromObject` | `FromParent` | its `objectColor`, faded by the **instance's** material | openNURBS, ran [test] |
| `ColorFromLayer` | `FromLayer`, `FromObject` | its **own** layer's colour, never the instance's layer | openNURBS, ran [test] |
| `ColorFromLayer` | `FromParent` | its own layer's colour, faded by the instance's material | openNURBS, ran [test] |
| `ColorFromMaterial` | `FromLayer`, `FromObject` | the diffuse colour of the material it names | openNURBS, ran [test] |
| `ColorFromMaterial` | `FromParent` | the diffuse colour of the **instance's material**, not the instance's object colour | openNURBS, ran [test] |
| `ColorFromParent` | `FromLayer`, `FromObject` | the instance's resolved colour, at its own material's transparency when that colour is opaque | the reader's rule, and the fourth divergence below [test] |
| `ColorFromParent` | `FromParent` | the instance's resolved colour; both inherited, so the two agree exactly | openNURBS, ran [test] |
| any | any, no instance (top level) | every "from parent" source falls back to the object's own layer | openNURBS enum comments, ran [test] |

The two rows that carry `FromParent` with a colour of their own are the ones
#9987 asked about, and they were both wrong before: the member took the
instance's colour where Rhino takes the inherited material's, and an inherited
material's transparency was skipped on the theory that the parent's colour
already carried it. It does not, because the member's resolved material is the
instance's material and Rhino reads transparency from whatever material an
object ends up with.

**What that costs the instanced output.** One instance record carries one
colour, so a definition mesh can say "my own colour" or "the instance's
colour" and nothing else. `memberColor` decides which, and names the third
case: a member whose colour or alpha the instance's material decides is baked
per placement, like a curve or a "by parent" mesh with a transparent material
of its own. Both modes draw the same colours and the same triangle count
[test].

An inherited material can only change a member's colour through its diffuse
colour or its transparency. So a member that reads that diffuse
(`ColorFromMaterial`) always bakes, and the rest bake only when a material some
instance in the file hands down is transparent, which `inheritableFade`
measures. That gate matters: with 5,000 placements of one 3,200-triangle
member, baking every `MaterialFromParent` member returned 5,000 mesh records
and 375 MB of geometry, every record the same colour, where one shared
definition holds 0.08 MB [ran]. It is measured over what the instances resolve
to rather than over the material table, because a Rhino file keeps materials
nothing references and one leftover transparent material would otherwise bake
every inheriting member in the file [test]. It still over-approximates: one
instance naming a transparent material bakes the members of every definition,
including those placed only by instances with opaque materials.

**Nested blocks.** Each level resolves against its parent's already-resolved
attributes, so "by parent" reaches past the direct parent only when the
intermediate instance is itself "by parent". The Rhino 8 help page states the
rule as "By Parent only works with the direct parent", with a worked example:
a box set to By Parent inside Block A inside Block B shows Block A's layer
colour, and shows Block B's colour once Block A is By Parent too
([object properties](https://docs.mcneel.com/rhino/8/help/en-us/properties/object.htm)).
Both halves of that example were run through openNURBS and are covered [test].
The material help page is vaguer on nesting, saying only that objects set to
the Parent material "are not affected by further nesting"
([material properties](https://docs.mcneel.com/rhino/8/help/en-us/properties/material.htm));
openNURBS composes, and that is what the reader does [test].

**Known divergences.** All four come from one modelling choice: `Appearance`
hands a member the instance's already-resolved colour, where openNURBS hands it
the instance's colour *source*. The first three are reached only when the
placing instance's own colour or material is itself by-material or by-parent,
which no public .3dm does. The fourth needs no more than an instance that names
a transparent material, which is an ordinary file, and the table's
`ColorFromParent` row is pinned at the reader's value by a test that builds
one. Carrying the source instead would settle the first three,
whose right answer is a fixed colour a definition can hold; the cost is that
which definition a placement shares would then depend on the instance, so
`Emitter` would have to key one by more than the block id. The fourth needs a
second colour on every instance record, or a bake. Both are out of scope for
#9987, which asked about the two `FromParent` rows in the table.

- an instance whose `colorSource` is `ColorFromMaterial`: openNURBS gives its
  "by parent" members `ColorFromMaterial`, so a member with a material of its
  own is coloured by *that* material. The reader gives it the instance's
  resolved colour. The two agree whenever the member's material is inherited
  [openNURBS, ran].
- a top-level instance whose own `colorSource` is `ColorFromParent`: with no
  parent of its own, openNURBS leaves its members `ColorFromParent` too, so
  they fall back to their own layers. The reader gives them the instance's
  resolved colour, which is the instance's layer colour [openNURBS, ran].
- the same shape for `MaterialFromParent` on a top-level instance: openNURBS
  leaves the member's material unresolved, so it falls back to the member's own
  layer material, where the reader hands down the instance's [openNURBS, ran].
- a member whose colour is "by parent" and whose material is not inherited
  takes the instance's *drawn* alpha. Rhino copies the instance's colour value,
  which never carries material transparency, and then fades the member by its
  own material. The two differ only when the instance itself has a transparent
  render material [openNURBS, ran].

**Plot colour is not read.** `PlotColorFromParent` exists and resolves the same
way, but plot colour is for printing and the reader never reads it: `RAttributes`
in `read/rhino-api.ts` does not name `plotColorSource`.

**No public .3dm has a "from parent" block member.** Every member in
mcneel/rhino3dm's `tests/models` (`blocks.3dm`, `file3dm_stuff.3dm`),
mcneel/rhino-developer-samples and openNURBS's own `example_files` is
`ColorFromLayer` plus `MaterialFromLayer` [ran, all three sets]. So the table's
rows are covered by crafted files, with the one public file that does carry a
semi-transparent render material,
openNURBS's `my_mesh_with_material.3dm`, pinned as a fixture for the
transparency rule [test].

### Layers, visibility, hierarchy

- `layers[i].visible` holds the layer's own flag. `entities[i].hidden` is
  `object.visible === false || mode === Hidden || any ancestor layer off`
  [test]. A merged entity is hidden when all its objects are.
- Visibility stays per part. Parts that share a GlobalId and its group merge
  into one entity (D8) whatever their visibility, so a group can hold a hidden
  part, or one on a layer that is off, next to a visible one. One entity flag
  cannot say which, so every geometry record carries `hidden`, its own
  object's flag. A consumer hides exactly what Rhino hides by leaving out a
  record whose `hidden` is set while its entity's is not, and keeps the entity
  flag for the user's show and hide [test: a crafted group of a visible box, a
  hidden box and a curve on an off layer, and one hidden object of its own].
  Not splitting the entity keeps D8: the parts are one IFC element.
- Layers are reordered parent first, keeping file order among siblings. A
  layer whose parent is missing becomes a root; so does a layer in a parent
  cycle, with a warning. An object whose layer index is outside the table
  (`subd_creases.3dm` has -1) lands on the first layer [test].
- `fullPath` is built from the parent that reordering settled on, not read from
  rhino3dm's `Layer.fullPath`: that property follows `ParentId` with no visited
  set, so for a cyclic chain it does not come back [measured: still running
  after 90 s on a model built in memory. The tests make that call in a child
  process with a deadline, so a hang fails one test instead of the suite]. The
  cycle could not be put into a .3dm: openNURBS resets a cyclic parent to nil
  as it writes, and patching the parent field in the bytes makes
  `fromByteArray` answer null [measured], so nothing shows the reader reaching
  it through a file. Building the path here also keeps it in step with the
  repaired tree: a layer this walk shows at the top level is named as one, and
  what hangs off it reads as nested from there [test]. Paths of well-formed
  files are unchanged [test: Rhino-authored samples and our own exports].
- **Spatial stamps:** a layer carrying a valid `IFC::GlobalId` and an
  `IFC::Class` that names `IfcProject` or an instantiable spatial element gets
  `spatial: { globalId, ifcClass, elevation }`. `IFC::Elevation` is read as a
  number, as written; null when absent or not a number [test, on a crafted
  file]. The unit of the stamp is the exporter's to define [unproven until the
  exporter change lands].
  The adapter loads hidden entities and applies the viewer's normal hide state
  after `finalizeModel` (`ingest/initialHiddenState.ts`, through
  `toGlobalId`), so the user can show them from the tree. A layer that is off
  is hidden as a row too, so it reads as off and one click shows it again.
  Our `IfcSpace` layers are
  hidden [ran], which matches the viewer's own space default.
- **Tree:** decision D3, in `apps/viewer/src/hooks/ingest/rhinoLayerTree.ts`.
  The containers are rows of the entity table and the containment is edges of
  the relationship graph (`IfcRelAggregates` between containers,
  `IfcRelContainedInSpatialStructure` to an object), and the hierarchy itself
  is the shared `SpatialHierarchyBuilder.buildFromCache`'s, off those two
  tables: the same source-less path the viewer rebuilds a cached IFC model's
  hierarchy from, so a `.3dm` tree cannot drift from the IFC one. It reads
  elevations from STEP bytes a `.3dm` store has none of, so the stamped
  elevations are written into the built hierarchy afterwards.
  - **Stamped** (any layer carries a placeable stamp, whatever the
    provenance): the stamped layers are the spatial structure they name, with
    the GlobalId the source IFC gave them, and every other layer is
    transparent: an object rolls up to the nearest stamped layer above it. An
    ifc-lite export therefore comes back as project / site / building / storey
    rather than as its class sublayers, and the model joins the unified storey
    list. A spatial element that has geometry sits on a class sublayer of its
    own layer, so the layer stamp and that object are the same IFC entity
    (FZK's site carries the terrain): the object's own row is the node, and
    nothing appears twice. The object stands for the layer only when its class
    is the stamped one too; otherwise the node stays and the object keeps the
    identity, because a stamp another class claims would leave the file
    without the node it names.
  - **Layers** (a layer outside every stamped structure, which is every layer
    of a file with no stamps): the layer is an `IfcSpatialZone` under its
    parent, and an object sits under its own layer. A layer somebody added to
    an export keeps its own row this way instead of its objects rolling up to
    the project. A layer that holds no object anywhere under it gets no row.
    `IfcSpatialZone` is IFC's class for a named decomposition that is not a
    storey, which is what a Rhino layer is, and it keeps the layers out of the
    storey tools, which a file with no stamps has no storeys for.
  - Exactly one `IfcProject` node exists: a stamped `IfcProject` layer with no
    stamped layer above it, else a root standing for the file and labelled
    with the file name, since a `.3dm` states no project name. A second
    `IfcProject` stamp, a stamp whose identity another container already took,
    and a stamp naming a spatial class the tree cannot place (the reader
    accepts a wider set, `IfcExternalSpatialElement` among it) are transparent.
  - What the file says about itself (application, provenance, unit system,
    archive version, frame, layer count, earth anchor, skip counts, and the
    document user text under the keys it is written with) rides the root
    entity's property sets, which is where the model metadata panel shows an
    `IfcProject`'s own data.
- Locked layers and objects are ignored: the viewer is read-only.

### Properties

Attribute User Text is string-only, so values are strings (`IfcLabel`).
Numbers are not guessed. No value the reader sees is empty: `setUserString`
stores nothing and answers false for an empty value, and deletes the key when
one already holds a value [ran]. Whitespace is a value like any other, kept as
written [test]. The reader does the sorting: each entity carries
`propertySets` next to its verbatim `userStrings`, plus `description` and
`objectType` [test].

| Key | Goes to |
|---|---|
| `IFC::GlobalId`, `IFC::Class`, `IFC::Name` | entity identity. Kept verbatim in the `IFC` set too, so a rejected value stays visible. |
| `IFC::Description`, `IFC::ObjectType` | entity table columns. Only the first key that names the column fills it; a second spelling stays in set `IFC` [test]. |
| other `IFC::*` (`ExpressId`, `Tag`, `PredefinedType`, `Container`, `ContainerGlobalId`, `Type`, `TypeGlobalId`, `Material`, `PresentationLayer`) | set `IFC` |
| `<Set>::<Prop>` | set `<Set>`, property `<Prop>`, split at the first `::` as the exporter defines [src `user_text.rs`]. ` #2` collision suffixes stay as written. |
| key without `::`, or with an empty set or property name | set `Attribute User Text`, under the whole key |
| `Rhino::*` user text (any case) | set `Attribute User Text`, under the whole key, so it cannot pose as a derived fact [test] |
| `IFC` and `Rhino` as set names | matched ignoring case and surrounding spaces, by one rule for sorting and for every `IFC::*` lookup (identity, columns, layer stamps, document strings), so `IFC ::Description` fills the column and is not also a property [test] |
| Rhino facts | set `Rhino`: `Layer` (full path), `ObjectType`, `ObjectId` (UUID), `Material` (name). Only the reader writes this set. |

Document strings and document user text go to the model metadata panel, not
to an entity.

## Errors

Errors are thrown as `RhinoReadError` with `code`. Messages are user-facing
and say what to do.

| Code | When | Message gist |
|---|---|---|
| `not-3dm` | header magic missing, `fromByteArray` returned `null`, or a wasm trap on a file under 32 MB [test: garbage, empty, an IFC file, a file cut in half, a simulated trap] | "Not a Rhino .3dm file, or the file is damaged." |
| `newer-archive` | header version above 80, checked before wasm [test: forged header] | "Saved by a newer Rhino. Save as Rhino 8 or older." [unproven: V9 behaviour] |
| `too-large` | `bytes.length` above the cap, checked before the file reaches wasm, **or** the wasm heap ran out (see Size ceiling) | Over the cap: names the size and the cap. Out of memory: "could not be read: it most likely needs more memory than the reader has". |
| `no-renderable-geometry` | nothing was drawn | Lists the skip counts: "skipped: 3 Brep:no-render-mesh, 7 Point". When surfaces lack render meshes it adds the remedy: shaded view, save without Save Small [unproven: exact Rhino wording]. |
| `worker-failed` | worker crash, unreadable message, timeout | as the export client. Raised by the viewer's worker client (step 2), not by the reader. |

Running out of the triangle or placement budget, or reaching the text dot
limit, is not itself an error: the read stops drawing and reports it. It is
`no-renderable-geometry` only when nothing was drawn at all, which a budget
below the first object's triangles gives [test: `maxTriangles` of 0 and 11].

An error thrown by the caller's `onProgress` is rethrown as it is, whatever
its type and whatever the file size: it is never read as a wasm failure, and
the runtime is kept [test].

An emscripten abort leaves the module unusable [ran], so after any wasm trap
the reader drops the shared runtime and the next read or write loads a fresh
module [test, with a simulated abort]. A trap on a file of 32 MB or more is
`too-large`; on a smaller file, which cannot exhaust the heap, it is `not-3dm`.

A read or a write that was already waiting on the runtime holds its own
reference to the module, so a concurrent abort can leave it with the discarded
one. Both reacquire until the module is current, through one helper
(`withCurrentRhino` in `runtime.ts`) that runs the parse or the write in the
same step as its check, so nothing can discard the module in between. One
recheck is not enough, because the reacquire is itself an await: a second abort
during it hands the caller a module that is already dead [test: three reads
sharing a module, the first two aborting and the third reading a valid file;
and a write that waits through an abort].

A table row the binding does not hand out is reported as `not-3dm` too: a
`count` that disagrees with `get` is damage, and naming it keeps a bare
TypeError from escaping the reader. A row fails the file where a null object is
only counted, because the layer, material and group rows are addressed by index
from elsewhere (`layerIndex`, materials, group names), so dropping one would
move every reference to the rows after it; the definition table is keyed by id
and could tolerate a gap, but a table that contradicts its own count is damage
either way. Every document-table read goes through that one guard, the string
table included, which the reader walks itself. The objects table is not one of
them: `readObjects` counts a row the binding will not wrap as
`<type>:unreadable` and reads on.

Those four tables answer null for an index past `count` [measured]; the string
table answers an empty pair instead [measured], so there the guard can only
catch a change in the binding. No row under `count` could be made to answer
null, so the guard holds the binding to a contract it allows rather than to a
case reproduced here [test, with a table that answers null under its own
count].

### Size ceiling

Decision D7: measured, then fixed in code as `MAX_3DM_BYTES` = 400 MB
(`packages/rhino3dm/src/read/size.ts`), exported with the refusal sentence
so the viewer checks the same cap before it copies the file.

Measured with `readRhino3dm` itself (cap lifted for the run), each file in a
fresh Node 22.14 process on an Apple M5 Pro with 48 GB, rhino3dm 8.35.0. The
files were written with native Python rhino3dm 8.17 (no wasm heap): N meshes
of 99,856 double-precision vertices each, jittered so they do not compress
away, about 44 bytes per vertex on disk. The wasm heap was read from the
module's `WebAssembly.Memory`, caught at instantiation. Peak RSS includes two
JS-side copies of the input that the harness held [ran]:

| File | Triangles | Read time | wasm heap | Peak RSS | Result |
|---|---|---|---|---|---|
| 96 MB | 4.4 M | 1.9 s | 500 MB | 0.8 GB | ok |
| 188 MB | 8.5 M | 2.9 s | 855 MB | 1.5 GB | ok |
| 236 MB | 10.7 M | 3.7 s | 1,096 MB | 1.9 GB | ok |
| 284 MB | 12.9 M | 4.4 s | 1,337 MB | 2.2 GB | ok |
| 333 MB | 15.1 M | 5.2 s | 1,578 MB | 2.6 GB | ok |
| 381 MB | 17.3 M | 5.7 s | 1,723 MB | 3.0 GB | ok |
| 403 MB | 18.3 M | 9.6 s | 1,885 MB | 3.1 GB | ok |
| 429 MB | 19.4 M | 6.8 s | 1,964 MB | 3.3 GB | ok |
| 477 MB | 21.8 M | 8.7 s | 2,048 MB | 3.1 GB | fails at the heap limit |

What that says:

- The heap grows to about 4.6 times the file size, and the wasm32 heap stops
  at 2,048 MB. For this content the ceiling sits between 429 and 477 MB. The
  draft's 300 MB was an extrapolation and too low.
- The cap is 400 MB: the largest round size that read with headroom (403 MB
  left 8% of the heap free). It rejects, before any wasm work, what cannot
  succeed.
- **At the limit rhino3dm does not abort. `fromByteArray` returns `null`**,
  the same answer as for a damaged file, after about 9 s. The reader tells the
  two apart by the archive's end-of-file mark, which states the file's own
  length: a file of 32 MB or more that still ends in its own length was not
  cut short, so the `null` is reported as `too-large` ("needs more memory than
  the reader has"), not `not-3dm` [ran on the 477 MB file; test on a crafted
  one]. The price: a large file with a damaged body and an intact end mark is
  also called `too-large`, which is why the message says "most likely". The
  mark is checked in the 8-byte layout archives have used since
  Rhino 5; an older archive that runs out of memory still reads as `not-3dm`
  [unproven: no pre-Rhino-5 file was tried].
- After that failure the heap stays at 2 GB, so the reader drops the shared
  runtime; the next read in the same process loads a fresh module and works
  [ran].
- The cap is on file size, and memory depends on content: a file whose meshes
  compress better expands more per byte and can run out below 400 MB. That
  case takes the same `too-large` path.
- Time is not the constraint: under 10 s at every size.
- A browser tab has its own memory limit, and a 400 MB read holds about 3 GB
  in the worker. Whether a tab survives that is [unproven]; the one-shot
  worker contains a crash either way.

**What the budget charges.** Every drawn part costs a third of a triangle per
vertex, and a mesh at least its triangles: a mesh costs whichever is more.
That one rule covers meshes, curves (polyline points or samples) and point
clouds, at top level and per placement, in both instance modes; text dots
stay on their own limit. The reader counts the budget in thirds of a
triangle, so every charge is a whole number: a block's cost is exactly the
sum of its meshes', and parts that fill the budget fit. Counted in doubles,
the remainder drifted: three 5-point curves at `maxTriangles: 5` drew two,
because 5 - 5/3 - 5/3 is 1.6666666666666663 there [measured, then fixed;
test]. Memory follows the vertex buffers as much as the triangles: before the
vertex charge, a mesh of 1 triangle over 100,000 vertices came back with
2.4 MB of buffers at `maxTriangles: 10`, and 50 baked placements of it with
120 MB at `maxTriangles: 100` [measured, then fixed; test]. It costs
33,333 1/3 triangles now, so it needs `maxTriangles: 33,334` and is refused
at 10. A mesh whose every vertex is in some triangle has at most three per triangle, so it costs its triangles alone and
normal files are charged as before [test: the box block at 120; ran: none of
the 73 meshes of our FZK export, the 271 of duplex, or the 4 in the five
readable Rhino samples has more than three vertices per triangle]. Curves
and clouds keep the charge they had: 100,000 points need `maxTriangles:
33,334` and are refused at 33,333 [measured]. One budget, no second option:
the triangle is the unit, and a vertex is priced in it.

**The triangle budget admits a placement's block meshes whole, in both modes.**
`maxTriangles` is charged a block's cost once per placement, and a
placement that would draw them all and does not fit is left out entirely, so
neither mode draws part of that set. Before that rule the option decided
whether a file read at all, because baking charged mesh by mesh: a block of two
12-triangle boxes at `maxTriangles: 12` came back as one box under
`bakeInstances: true` and refused the file under `false` [measured, then fixed;
test: both modes at 12, 23 and 24]. A placement a transform pushes out of range
draws less than the block in any case: there each mesh is looked at on its own,
after the range check that costs no triangles, so such a placement neither
charges the budget nor spends it [test: a block that does not fit, out of
range, leaves a later object drawable].

What the admission covers is the block's meshes under a reach that keeps f32,
which is where the two modes differed. The budget can still cut a placement
elsewhere, and does it identically either way, so what is drawn no longer
depends on the option:

- What the walk draws beside those meshes (curves, point clouds, and by-parent
  meshes carrying transparency of their own) is charged one part at a time. A
  block of a 12-triangle box and a 9-point curve at `maxTriangles: 13` draws
  the box and leaves the curve out [measured, both modes].
- So are the meshes of a placement the reach refuses. The reach is one bound
  for the whole block, measured from the block origin, while each mesh is
  checked on its own extent, so a block of two unit boxes 1e24 from its origin
  under a 1e15 scale is refused as a whole although both meshes fit: at
  `maxTriangles: 12` one box is drawn [measured, both modes].

Both cases report the object as drawn in part, so it is the budget working
rather than the option deciding.

## Options

Level 1 has no dialog. The defaults live in the reader.

| Option | Default | Why |
|---|---|---|
| `subdLevel` | 2 | 16× the control net. The logo SubD comes to 25 k tris in 9 ms [ran]. |
| `maxTriangles` | 30 M drawn | Bounds main-thread GPU upload [unproven: tune on hardware] |
| `bakeInstances` | false | Decision D4. True for a caller with no instance path. |
| max input | see Size ceiling | Above it the wasm32 heap runs out |
| frame | auto | W only under `local` with W present |

## Testing

**Package (`packages/rhino3dm`, Node, real rhino3dm).** Implemented in
`packages/rhino3dm/src/read/*.test.ts`:

- Our exports (`exports.test.ts`): FZK and duplex `.3dm` built in the test
  from the fixtures (`@ifc-lite/wasm/rhino` then `writeRhino3dm`), skipping
  when `pnpm fixtures` or the Rhino wasm payload is absent. Asserted:
  - entity count equals the distinct GlobalIds (90 and 236);
  - every entity has the class its `IFC::Class` states (stronger than an equal
    histogram);
  - every GlobalId is valid and unique;
  - grouped elements are merged (16 and 46);
  - FZK wall `2XPyKWY018sA1ygZKgQPtU` keeps `Pset_WallCommon`
    `ThermalTransmittance` 1.5, the value in the IFC source;
  - `IfcSpace` entities are hidden.
- Instanced equals baked: duplex per-GlobalId bboxes match the
  `--no-instancing` export within 1e-6 m, instanced and with `bakeInstances`.
- Frame: FZK with its site moved to (2,600,000, 1,200,000, 400) in the test,
  exported `local` and `world`, agrees after import within 1e-6 m. A `world`
  file with W present is not shifted twice (crafted, `blocks.test.ts`).
- Precision: a double vertex at 2,600,000.123 m comes back as
  `origin + position` to 1e-6 m.
- Rhino-authored (`samples.test.ts`): five files from the MIT-licensed
  `mcneel/rhino3dm` test models at tag 8.35.0, catalogued in
  `tests/models/manifest.json` as `upstream_file` entries pinned to that
  commit, so `pnpm fixtures` fetches them from McNeel's repository and they are
  never re-hosted. Asserted: per-type entities and skip counts on
  `file3dm_stuff.3dm`, `blocks.3dm` and `mesh.3dm`, the SubD triangle count at
  each level on `subd_creases.3dm` (12, 48, 192, 768), and the no-render-mesh
  refusal on `object_UserStrings.3dm`. One `mcneel/opennurbs` example file is
  pinned the same way, `my_mesh_with_material.3dm`: the only public .3dm found
  with a semi-transparent render material, so it is what proves the
  transparency rule on a file nobody here wrote. Its licence does not grant
  redistribution either, which is why it is an `upstream_file` entry and not an
  upload. The rest of that repository's example files (the Rhino logo models)
  are not needed.
- Block member appearance (`appearance.test.ts`): the "from parent" resolution
  table above, row by row, against a crafted instance whose object colour and
  material colour disagree, so the rows that #9987 asked about discriminate.
  Plus the top-level fallback, the Rhino 8 help page's nested-block example in
  both its forms, where each row's mesh lands when the modes differ, and that
  both modes draw the same colours and triangle count. Six of its sixteen cases
  fail against the reader as it was [ran].
- Crafted through rhino3dm in the test (`test-support/craft.ts`), for
  everything no sample covers: colour sources, hidden state, layer stamps,
  units, Breps and extrusions with render meshes, curves, point clouds, text
  dots, nested and mirrored blocks, GlobalId merging, class validation,
  property sets.
- Guards: a self-referencing block definition terminates and reports. rhino3dm
  hands out a definition's id only after its members are fixed, so the test
  patches the stored id and repairs the chunk CRC. The triangle budget and the
  placement budget stop the walk and report the remainder: the triangle budget
  the same way in both modes, the placement budget on the reference that spends
  it.
- Errors: garbage, empty and truncated input give `not-3dm`; a forged header
  version gives `newer-archive`; an input over the cap and a simulated abort
  give `too-large`.
- No leak (`leak.test.ts`): after a first import, three more leave the wasm
  memory at the same size, as do three imports that fail midway. rhino3dm
  exports no heap getter, so the test catches the `WebAssembly.Memory` as the
  module is instantiated. (The export's own heap test is still skipped for
  lack of that getter.)
- Runtime (`runtime.test.ts`): a read that waits through two aborts in a row,
  and a write that waits through one, run on the module that is current. The
  factory is mocked so every module it builds is recorded and the dead ones are
  built dead, which is how a second abort can be put in the right place.
- Document (`document.test.ts`): a table row the binding does not hand out, the
  layer paths reordering settles on (nested, missing parent, cycle), and the
  native `Layer.fullPath` of a cyclic chain, read in a child process with a
  deadline so its hang fails that test alone.
- Each guard above was checked by removing it and watching a test fail.

**Viewer (node:test).** Implemented, except the selection test:

- The adapter builds a store whose `getEntity`, properties and quantities
  answer, driven with real `RhinoImport` data: a crafted `.3dm` whose
  coordinate and user text are known exactly, and the Rhino 8 authored
  fixtures (`apps/viewer/src/hooks/ingest/rhinoViewerModel.test.ts`).
- The tree and the hidden state, on real `RhinoImport` data
  (`rhinoViewerModel.test.ts`): the layer tree of a Rhino-authored file (nested
  layers, objects under their own layer, no storeys), the hidden object, the
  layer that is off and its objects starting hidden, and the stamped tree with
  its storey elevation, `byStorey` membership and `getStoreyByElevation`.
- Visibility per part (`rhinoViewerModel.test.ts`): a hidden mesh and a hidden
  point cloud merged into a shown entity are left out of the payload, and a
  wholly hidden entity keeps its triangle and starts hidden.
- The spatial tree of an ifc-lite export against the IFC it came from
  (`rhinoViewerModel.export.test.ts`): FZK through the Rust scene builder,
  `writeRhino3dm` and the reader, compared with the same IFC through
  `IfcParser`: the project identity, the site and building, the storey names
  and elevations, and the storey each of the 83 drawn elements sits on.
- The whole `loadFile` route hides what Rhino hides, through the loaded model's
  own express id range (`useIfcLoader.rhino3dm.test.tsx`).
- Selecting a mesh resolves through `resolveEntityRef` at `models.size` 1 and N
  (AGENTS.md). The federated case is the e2e's: it selects the re-imported
  wall at `models.size` 2 and reads the properties panel the selection fills.
- The worker client uses an in-process fake worker, as
  `rhino-export-client.test.ts` does
  (`apps/viewer/src/lib/import/rhino-import-client.test.ts`): abort, a reader
  error with its code, a crash, an unreadable message, and the axis swap.
- `detectFormat` returns `'3dm'` (`packages/ifcx/src/detect-format.test.ts`).
- Bundle check: rhino3dm stays out of the startup graph.
  `apps/viewer/scripts/check-rhino3dm-lazy.mjs` already scans every startup
  chunk for rhino3dm, so it covers a second worker unchanged. Only its remedy
  text names the export worker and needs updating [src].

**Real browser (`tests/e2e/rhino-import.e2e.spec.ts`, modelled on
`rhino-export.e2e.spec.ts`).** Implemented, four tests, in the `viewer-e2e`
and `viewer-e2e-ci` Playwright projects. Each overlay test opens
`AC20-FZK-Haus.ifc`, exports `.3dm` through `export:3dm` and adds the
downloaded file as a federated model, once per exporter coordinate mode
(`local` and `world`):

- **Per GlobalId, the IFC model's and the Rhino model's world AABBs agree
  within 1 mm**, every corner on every axis. Measured: 4.17e-7 m, over all 90
  drawn elements. Both sides' boxes are read off the store's own
  `geometryResult`, `instancedGeometryAabbs` included, so FZK's 42 instanced
  members are compared rather than silently dropped. The per-axis figure is
  reported separately, so a swapped or flipped up axis is named rather than
  merely large.
- **Nothing the `.3dm` drew is geometry the IFC has not got** (the matched set
  is the `.3dm`'s whole set), and the IFC-only ids are only
  `IfcOpeningElement` and `*Type`, which the export leaves out by design.
- The store says `IFC4` over `sourceKind: 'tabular'`, with its entity, mesh
  and triangle counts.
- The storey names and elevations equal the IFC's, read from both models in the
  same session, and the stamped `IfcProject` carries the IFC's GlobalId.
- The re-imported FZK wall `2XPyKWY018sA1ygZKgQPtU` is `IfcWallStandardCase`,
  keeps `Pset_WallCommon` `ThermalTransmittance` 1.5 and its `IFC::GlobalId`,
  and selecting it fills the properties panel with both.
- The seven objects on the export's switched-off `IfcSpace` layers start
  hidden, survive dropping the other model, and one of them is shown again
  from its row's eye in the tree.
- No console errors.

Two more tests: a Rhino-authored file (`file3dm_stuff.3dm`) loads with its
layer rows rendered as `IfcSpatialZone` under a root named for the file, no
storeys, and its green layer colour on both the mesh and the point cloud; and
a truncated `.3dm` and a file carrying the Rhino header over garbage are each
refused with the reader's own sentence on the viewport's load-error card,
leaving the loaded model alone, after which the intact file still loads. That
last test also pins that an IFC named `.3dm` is read as the IFC it is: format
detection reads the first 24 bytes, never the name, so the reader's `not-3dm`
refusal is reachable in the app only for a file that claims the Rhino header.

Acceptance evidence (AGENTS.md), taken by the spec run on a real GPU and
committed under `docs/assets/`: FZK IFC with its `.3dm` overlaid and the
selected wall's panel (`rhino-import-overlay.png`), the properties panel on
the re-imported wall (`rhino-import-properties.png`), and a Rhino-authored
model with its layer tree (`rhino-import-layer-tree.png`). The logo models
(`v7_rhino_logo_nurbs`) are not available: their repository's licence does not
grant redistribution, as the package tests already record.

## Delivery

One issue, stacked PRs, each under about 1,500 lines:

0. **Exporter fixes** (before the export ships, decision D1 and D3): write
   `IFC::WorldFromModel` only under `local`; stamp `IFC::GlobalId`,
   `IFC::Class` and `IFC::Elevation` user strings on spatial layers.
1. **`readRhino3dm`** in `@ifc-lite/rhino3dm`, with the package tests, the
   measured size ceiling, a changeset and the API surface update. **Done.**
2. **Viewer load:** `detectFormat` `'3dm'`, accept lists, worker and client,
   `rhinoViewerModel.ts`, the `buildTabularDataStore` lift, and the `loadFile`
   branch. **Done.** Deviations: the worker request carries no options (level 1
   has no dialog, so the defaults stay in the reader), it reads with
   `bakeInstances` until the GPU instance path exists (D4), and curves and text
   dots come across the wire but are not drawn (D6), so a file whose only
   drawable objects are curves is refused with the reader's
   `no-renderable-geometry` code.
3. **Tree and visibility:** the layer or spatial tree, hidden state, and model
   metadata. **Done.** Deviations: the tree follows the stamps whatever the
   file's provenance (above); an `IfcSpace` of an ifc-lite export comes back as
   a node under its storey, but the elements the IFC contained in that space
   come back on the storey, because the export puts them on the storey's class
   layer and the space is not a layer; and a container row's eye toggle acts on
   the objects it holds directly, as every other container row in the viewer
   does, so turning off a parent layer does not turn off a child layer's
   objects.
4. **E2E and acceptance:** the overlay spec, screenshots, and a guide section.
   **Done.** Deviations: the guide is a page of its own,
   [Rhino .3dm](../guide/rhino-3dm.md), rather than a section inside an
   existing one, because no existing page owns a format; the Rhino-authored
   acceptance file is `file3dm_stuff.3dm` rather than the logo model, which is
   not redistributable; and the "non-`.3dm` with a `.3dm` name" error case is
   a file carrying the Rhino header over garbage, because format detection
   reads the content, so any other file is routed to the format it really is.

## Open decisions

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | `IFC::WorldFromModel` under `world` | **Resolved:** the exporter now writes it only under `local` (`space.rs::world_from_model`, asserted in `rhino_scene.rs`); the reader still gates on `IFC::Coordinates` for older files. | Done before the export shipped. |
| D2 | IFC class for Rhino objects without `IFC::Class` | **Decided (maintainer, 2026-11-08):** `IfcBuildingElementProxy`, and a Rhino user can choose the class by setting the `IFC::Class` user text (Attribute User Text) on the object, which the import honours when it names a valid IFC product class. | Document the key in the user guide; invalid names fall back to the proxy with a warning. |
| D3 | Tree for a `.3dm` | **Decided, and shipped:** layer tree for any `.3dm`, plus a real `SpatialHierarchy` for files whose spatial layers carry `IFC::GlobalId` / `IFC::Class`. Both are one `SpatialHierarchy` off the store's own tables, so the hierarchy panel reads a `.3dm` as it reads an IFC. | The stamps are honoured whatever the provenance: the reader validates them, and D2 already lets a Rhino user choose a class by user text, so this is one rule rather than two. |
| D4 | Blocks | **Decided: GPU instancing.** | The reader returns `definitions` and `instances`, and bakes on request. `MeshData` has no transform field today, so the viewer needs an instance path through the federated mesh pipeline; measure against baking on a large-block file. |
| D5 | Earth anchor alignment | **Decided: align through the projection used by `reprojected` alignment.** | Treat Rhino's unset default anchor (0/0) as absent; ifc-lite's own exports keep aligning exactly through `IFC::WorldFromModel`. |
| D6 | Point clouds, curves, text dots | **Decided: render them.** | The reader returns all three as data. Point clouds go through the payload's `pointClouds` (as IFCX does); curves and text dots need a line/label primitive for federated models, which is viewer work. |
| D7 | Size cap | **Decided: measure in PR 1, then fix in code.** | Measured; see Size ceiling. |
| D8 | Grouping by GlobalId in foreign files | **Decided: merge only within the matching Rhino group.** | |

## Level 2 outlook: round-trip back to IFC

Level 1 keeps everything level 2 needs: the verbatim user text, Rhino object
UUIDs, layer paths and geometry.

- **Diff and patch an existing IFC.** Match by `IFC::GlobalId`, then report
  moved, deleted and added objects and changed user text against the source
  IFC. Write property edits back through the existing mutation layer.
  Geometry edits become `IfcFacetedBrep` / `IfcTriangulatedFaceSet` replacements
  on the matched element.
- **New objects.** Rhino objects with no GlobalId become new products: class
  from `IFC::Class` or the proxy default, container from the layer's spatial
  stamp, and the GlobalId from the Rhino UUID (`uuidToIfcGuid`, stable across
  re-imports).
- **Exact geometry.** rhino3dm.js cannot mesh or tessellate [ran], so exact
  Breps need the Python rhino3dm route or a Rhino plugin (the export spec's
  RhinoCommon adapter), not the browser.
- **Value types.** User text is string-only. Typed values come back from the
  source IFC by GlobalId, or from a type-hint convention the exporter would
  have to add (for example `IFC::Type::<Set>::<Prop>`) [unproven: needs its own
  decision].
- The CLI and MCP get `ifc-lite import model.3dm` on the same `readRhino3dm`
  through Node, which the package tests already exercise.
