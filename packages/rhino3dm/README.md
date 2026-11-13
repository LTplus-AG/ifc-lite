# @ifc-lite/rhino3dm

Read and write Rhino `.3dm` through the pinned `rhino3dm` runtime, loaded lazily.

- `readRhino3dm` turns `.3dm` bytes into plain `RhinoImport` data.
- `writeRhino3dm` turns an encoded IFC-lite RhinoScene v1 (JSON manifest plus a
  little-endian binary blob) into `.3dm` bytes. It performs no IFC interpretation.

## Reading

```ts
import { readRhino3dm, RhinoReadError } from '@ifc-lite/rhino3dm';

declare const bytes: Uint8Array;
try {
  const model = await readRhino3dm(bytes, {
    subdLevel: 2,            // 0 to 3, default 2
    maxTriangles: 30_000_000, // drawing budget, the default
    bakeInstances: false,    // true bakes blocks into `meshes`
    onProgress: (done, total) => console.log(done, total),
  });
  for (const mesh of model.meshes) {
    const entity = model.entities[mesh.entity];
    // World position of vertex i, metres, Z-up: mesh.origin[k] + mesh.positions[i * 3 + k]
    console.log(entity.globalId, entity.ifcClass, mesh.indices.length / 3);
  }
} catch (error) {
  if (error instanceof RhinoReadError) console.error(error.code, error.message);
  else throw error;
}
```

The result is plain objects and typed arrays, so it crosses a worker boundary
by structured clone. A typed array is not itself transferable, so transfer
`array.buffer`; no two arrays share one, so all of them can go on one list.

- **Coordinates** are metres, Z-up. Every geometry record carries a double
  `origin` and f32 offsets from it, so survey-scale coordinates keep their
  precision. A file ifc-lite exported with `local` coordinates is moved back to
  the IFC world frame through its `IFC::WorldFromModel` document string.
- **Entities** are the drawn top-level objects, in file order. Each has a valid,
  unique `globalId`: its `IFC::GlobalId` user text, or one derived from the
  Rhino object UUID. Objects sharing a GlobalId merge into one entity only when
  they sit in a Rhino group named that GlobalId, which is how the exporter
  writes a multi-part element. The merged entity holds the user text of every
  part; a key whose value differs between parts is kept as `<key> #2`.
- **IFC class:** set the `IFC::Class` user text (Attribute User Text) on an
  object in Rhino to choose its class, for example `IfcWall`. Without it, or
  with a name that is not an instantiable IFC product class, the entity is an
  `IfcBuildingElementProxy`; an invalid name adds one warning.
- **Properties:** user text is sorted into `propertySets`. A key splits at its
  first `::` into set and property; a key without one goes to
  `Attribute User Text`; Rhino facts (layer, object type, object id, material)
  go to `Rhino`. All values are strings.
- **Geometry:** meshes as stored; Breps and extrusions through the render
  meshes Rhino cached in the file (rhino3dm.js has no mesher); SubDs as the
  control net at `subdLevel`. Curves are polylines, sampled when they are not
  polylines already. Point clouds and text dots come back as data. Points,
  text, hatches, dimensions, lights and bare surfaces are counted in `skipped`.
- **Blocks** come back as `definitions` (each block's own meshes) and
  `instances` (one per placement, nested blocks flattened into a composed
  double-precision transform). `bakeInstances` writes world-space copies into
  `meshes` instead. A block that contains itself is skipped and reported, and
  a member that is hidden or on a layer that is off is not drawn.
- **Budget:** `maxTriangles` bounds what is drawn, and has to be a whole
  number of triangles, 0 or more: a budget that cannot be exhausted is not a
  budget. A block counts once per placement. A vertex counts a third of a
  triangle and a mesh at least its triangles, so neither blocks nor large
  vertex arrays can grow memory without bound. Text dots have their own limit
  of 100,000 per file. `skipped` and `warnings` say what was left out.
- **Visibility:** `entities[i].hidden` is true when the object is hidden or a
  layer on its path is off; for a merged entity, when every part is. Each
  mesh, instance, point cloud, curve and text dot carries `hidden` for its own
  object, so a consumer can hide exactly what Rhino hides.
- **Layers** come parent first with colour, visibility, user text and, when a
  layer carries `IFC::GlobalId` and `IFC::Class` stamps, its `spatial` element.

`RhinoReadError.code` is one of `not-3dm`, `newer-archive` (saved by a Rhino
newer than 8), `too-large` (above the 400 MB cap, or the wasm heap ran out) and
`no-renderable-geometry` (for example surfaces saved without render meshes).
Hitting the triangle budget is not itself an error: the read stops drawing and
says so in `warnings` and `skipped.budget`. If it leaves nothing drawn at all,
as a budget below the first object's triangles does, the read throws
`no-renderable-geometry` like any other file that draws nothing.

After initialization a read is synchronous, so in a browser run it in a
worker. The contract and its evidence are in
[`docs/architecture/rhino-3dm-import.md`](../../docs/architecture/rhino-3dm-import.md).

## Writing

```ts
import { writeRhino3dm } from '@ifc-lite/rhino3dm';

// The encoded scene comes from Rust: `build_rhino_scene` then `RhinoScene::encode` in the
// ifc-lite-export crate. In JS, `exportRhinoScene` from `@ifc-lite/geometry` returns it.
declare const manifestJson: string;
declare const binaryBlob: Uint8Array;
const scene = { manifest: manifestJson, blob: binaryBlob };
const { bytes, warnings, objectCount } = await writeRhino3dm(scene, {
  version: 8, // 7 or 8; default 8
  onProgress: (done, total) => console.log(done, total),
  // Browser bundlers: serve rhino3dm/rhino3dm.wasm at this URL.
  locateFile: (path, prefix) => path.endsWith('.wasm') ? `/wasm/${path}` : prefix + path,
});
```

`EncodedRhinoScene`, `Write3dmOptions`, `RhinoSceneManifest` and its component
types are exported. `parseRhinoScene` returns the validated manifest; malformed
JSON, unsupported format/version, invalid references, alignment, triangle
indices and invalid scalar values throw `RhinoSceneError`. Writing an archive
version other than 7 or 8 also throws `RhinoSceneError`.

The MIT-licensed `rhino3dm@8.35.0` runtime is pinned and imported lazily via
`rhino3dm/rhino3dm.module.js`. Its WASM is 2.67 MB (1.04 MB gzip); importing this
package loads neither the runtime nor WASM. Initialization is shared across
writes, and the first call's `locateFile` applies to that runtime. Failed
initialization can be retried. A browser build must serve the WASM separately;
Vite does not automatically copy it from this dynamic import.

Layers, materials, groups, blocks and objects retain manifest order. A layer's
`userStrings` are written as layer user text (`Layer.setUserString`); the scene
uses them for the IFC identity of project and spatial layers. Vertex positions
use double precision. All created Embind objects are explicitly released, also
when writing or progress callbacks throw. Table, settings and mesh-list wrappers are released before their parent; the
underlying document/mesh data stays owned by that parent.

**Object identity:** JS `ObjectAttributes.id` is read-only, so `objectId` is
ignored. `IFC::GlobalId` user text carries IFC identity; see the architecture
spec's “Object identity” section. Rhino generates GUIDs and timestamps, so
`.3dm` bytes are not deterministic; compare read-back semantics instead.

Tests round-trip archives 7 and 8, including blocks, non-symmetric transforms,
earth anchors and survey-scale vertex precision. The heap-growth check is
skipped on 8.35.0: its heap views and wasmMemory are closure-private, with no
exported heap-size API. Three repeated writes and recovery from a thrown
progress callback are still exercised.

The writer validates and parses the scene once and returns `{ bytes, warnings, objectCount }`. Progress starts at `(0, objectCount)` and advances once per object, instances included. After initialization the write is synchronous, so in a browser run it in a worker if the page must stay responsive.

The writer sets `EarthAnchorPoint.earthBasepointElevationZero` to
`BasepointZero.MeanSeaLevel` because IFC `RefElevation` is above mean sea level.
In rhino3dm 8.35.0 this setting works in memory but does not survive archive
write/read: [openNURBS writes an unset coordinate system into the newer field](https://github.com/mcneel/opennurbs/blob/8.x/opennurbs_3dm_settings.cpp#L4088-L4091),
which overrides the legacy value when read. Expected-failure tests track this
upstream limitation for archive versions 7 and 8.
