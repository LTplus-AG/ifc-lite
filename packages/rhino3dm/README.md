# @ifc-lite/rhino3dm

Convert an encoded IFC-lite RhinoScene v1 (JSON manifest + little-endian binary
blob) into Rhino `.3dm` bytes. This adapter performs no IFC interpretation.

```ts
import { writeRhino3dm } from '@ifc-lite/rhino3dm';

// Today the encoded scene comes from Rust: `build_rhino_scene` then `RhinoScene::encode`
// in the ifc-lite-export crate (manifest JSON + blob). The JS binding is not released yet.
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

Layers, materials, groups, blocks and objects retain manifest order. Vertex positions
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
