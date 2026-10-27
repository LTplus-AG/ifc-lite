# @ifc-lite/wasm

Pre-built WebAssembly bindings for the IFClite Rust core, covering STEP parsing and geometry tessellation (including the pure-Rust exact CSG kernel).

> **You probably don't need to use this package directly.** It's the WASM binary plus generated JS/TypeScript bindings that `@ifc-lite/parser`, `@ifc-lite/geometry`, and `@ifc-lite/renderer` consume internally. Reach for it when you want raw access to the Rust core without the higher-level wrappers.

## Installation

```bash
npm install @ifc-lite/wasm
```

The package includes generated private JavaScript helpers under `pkg/snippets/`
when the WASM bindings import them. Keep these files beside the generated glue;
copying only `ifc-lite.js` and the `.wasm` file can leave an incomplete runtime.
The canonical build and prebuilt fetch generate npm ignore metadata so
wasm-pack's broad Git ignore does not exclude these helpers from publication.
`pnpm build:wasm:fetch` validates the static helper dependency closure and runtime
exports before installation, preserving committed types and an existing runtime
if validation fails. Validation parses code without evaluating the generated JavaScript.
Dynamic imports remain lazy and are outside this static dependency check.

## Direct WASM use

The text-based entity scanner (`scanEntitiesFast`) takes the raw IFC text
(a `string`) — decode the buffer first; `scanEntitiesFastBytes` takes the raw
`Uint8Array` bytes directly. The geometry methods (`buildPrePassOnce`,
`processGeometryBatch`, see below) also take the raw `Uint8Array` bytes.

```typescript
import init, { IfcAPI } from '@ifc-lite/wasm';

await init();                         // load and instantiate the WASM module

const api = new IfcAPI();
const buffer = await fetch('model.ifc').then(r => r.arrayBuffer());
const content = new TextDecoder().decode(buffer);

// Fast entity scan — returns an array of entity references
const refs = api.scanEntitiesFast(content);
console.log(`Entities: ${refs.length}`);

api.free();                           // free the API instance
```

`api.extrusionDefinitions(bytes, ids)` returns exact authored
`IfcExtrudedAreaSolid` sources and placed product occurrences without decoding
meshes. Omit `ids` for all products, pass `new Uint32Array()` for none, or
selected product STEP IDs for a filtered view. Repeated mapping targets share a source key while each
occurrence retains its f64 `world_from_source` matrix and deterministic ordinal.
Complete sources with valid positive net profile area have
`nominal_quantities` in raw squared/cubed IFC file units; unsupported or
invalid sources have `null`.
For a complete source-profile point, apply `profile_position`, then
`position_matrix`, then `world_from_source`; the last matrix includes file-unit
conversion and maps to absolute IFC Z-up metres. An absent optional `Position`
leaves its matrix field `null`, so use identity for that step when composing
rather than expecting an identity array. Check `status` before interpreting a
null matrix; unsupported sources and bounded output are reported by `status`
and `diagnostics`. CSG operands carry
`source_modified=true` because their final body can differ.

## Meshes (pre-pass + job batches)

Geometry runs as a single pre-pass (one scan that produces a flat job list
plus unit scale, RTC offset, void/style indices) followed by
`processGeometryBatch` calls over slices of that job list. Pass the IFC
**bytes** (`Uint8Array`) to these methods:

```typescript
import init, { IfcAPI } from '@ifc-lite/wasm';

// Your renderer, and your own adapter from a wasm mesh to its mesh type.
declare const scene: { add(m: unknown): void };
declare function toThreeMesh(mesh: unknown): unknown;

await init();
const api = new IfcAPI();
const modelBuffer = await fetch('model.ifc').then(r => r.arrayBuffer());
const bytes = new Uint8Array(modelBuffer);

const pre = api.buildPrePassOnce(bytes);
// Large-coordinate models: pre.needsShift / pre.rtcOffset give the RTC origin.
for (let start = 0; start < pre.totalJobs; start += 100) {
  const end = Math.min(start + 100, pre.totalJobs);
  const jobs = pre.jobs.slice(start * 3, end * 3);
  const collection = api.processGeometryBatch(
    bytes, jobs, pre.unitScale,
    pre.rtcOffset?.[0] ?? 0, pre.rtcOffset?.[1] ?? 0, pre.rtcOffset?.[2] ?? 0,
    pre.needsShift,
    pre.voidKeys, pre.voidCounts, pre.voidValues,
    pre.styleIds, pre.styleColors,
  );
  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);
    scene.add(toThreeMesh(mesh)); // mesh.expressId, .ifcType, .positions, .normals, .indices, .color
    mesh.free();
  }
  collection.free();
}

api.clearPrePassCache();
api.free();                           // release the API instance when done
```

### Auxiliary geometry in the mesh frame

Grid, alignment, and symbolic parsers accept the mesh pre-pass decision through
their explicit-frame variants. `RtcFrame` coordinates are IFC Z-up metres:

```typescript
import type { IfcAPI, RtcFrame } from '@ifc-lite/wasm';

declare const api: IfcAPI;
declare const pre: ReturnType<IfcAPI['buildPrePassOnce']>;
declare const content: string;

const frame: RtcFrame = {
  x: pre.rtcOffset?.[0] ?? 0,
  y: pre.rtcOffset?.[1] ?? 0,
  z: pre.rtcOffset?.[2] ?? 0,
  needsShift: pre.needsShift,
};

const grids = api.parseGridLinesInFrame(content, frame);
const axes = api.parseGridAxesInFrame(content, frame);
try {
  const alignments = api.parseAlignmentLinesInFrame(content, frame);
  const symbols = api.parseSymbolicRepresentationsInFrame(content, frame);
  try {
    console.log(grids.length, axes.length, alignments.length, symbols.totalCount);
  } finally {
    symbols.free();
  }
} finally {
  axes.free();
}
```

`needsShift: false` means no RTC subtraction, even when the inactive coordinates
are non-zero. “Raw IFC” here describes only that RTC step: each parser still
applies its documented unit scaling and output-axis conversion. It is distinct
from having no frame.
The methods without `InFrame` remain available for standalone parsing and
detect a frame from the whole source. That standalone choice is not guaranteed
to match an earlier streaming sample or a federation override; reuse the exact
pre-pass frame whenever these results accompany already-produced meshes.

> Most consumers should use [`@ifc-lite/geometry`](../geometry/README.md)'s
> `GeometryProcessor` instead — it wraps this pre-pass/job-batch flow with a
> Web-Worker pool, RTC coordinate handling, and progressive streaming.

## Exports

| Class | Purpose |
|---|---|
| `IfcAPI` | Top-level entry point — `scanEntitiesFast` / `scanEntitiesFastBytes` / `scanGeometryEntitiesFast`, `buildPrePassOnce` / `buildPrePassStreaming`, `processGeometryBatch`, `extractProfiles`, `parseSymbolicRepresentations` |
| `MeshCollection`, `MeshDataJs` | Tessellated geometry output |
| `ProfileCollection`, `ProfileEntryJs` | Cross-section profile data (extruded-area solids) |
| `SymbolicRepresentationCollection`, `SymbolicCircle`, `SymbolicPolyline` | 2D symbolic representations (for plan / annotation views) |

All classes implement `free()` and `[Symbol.dispose]()` — call `free()` (or use `using`) to release Rust-side memory.

## When to use a higher-level package instead

| You want… | Use |
|---|---|
| A typed, idiomatic TS API for parsing | [`@ifc-lite/parser`](../parser/README.md) |
| Streaming geometry with worker support | [`@ifc-lite/geometry`](../geometry/README.md) |
| WebGPU rendering | [`@ifc-lite/renderer`](../renderer/README.md) |
| To avoid managing WASM lifecycles by hand | Any of the above |

## Rust source

This package ships the bindings only. The Rust source lives in [`rust/wasm-bindings/`](https://github.com/LTplus-AG/ifc-lite/tree/main/rust/wasm-bindings) and the core in [`rust/core/`](https://github.com/LTplus-AG/ifc-lite/tree/main/rust/core). Available on crates.io as `ifc-lite-core`.

## API

See the [WASM API Reference](https://ifclite.dev/docs/api/wasm/).

## License

[MPL-2.0](https://mozilla.org/MPL/2.0/)


For appearance authoring, `IfcAPI.catalogAppearance` resolves current IFC product
classes and type memberships from an effective STEP snapshot before planning.
It shares bounded native decoding with `planAppearance`; run both in a worker and
validate the source revision before using a catalog or applying a plan. See the
[WASM API guide](../../docs/api/wasm.md#effective-appearance-scope-catalog) for the
request, response and limits.

`IfcAPI.planPageAppearance(content, requestJson, rgba)` adds a bounded finite-page
compositor. It returns an `IFPA` metadata/PNG envelope with per-item digest-named
assets and ordinary atomic IFC edits. Outside-page albedo is resampled from the
original canonical style/texture, not a repeated or clamped page border. Run in
a cancellable worker and retain all generated assets with the command. See the
[WASM API guide](../../docs/api/wasm.md#finite-page-appearance-output).

`IfcAPI.planAnnotationPlane` creates a bounded calibrated image `IfcAnnotation`
plan for an explicit spatial container, reusing canonical native geometry. Run it
in a worker and publish its typed entities, source-image lease and returned mesh
as one existing model/history transaction. See the [WASM API guide](../../docs/api/wasm.md#calibrated-annotation-creation)
for the Z-up geometry/top-down UV and allocator/source validation contract.

`IfcAPI.planCapturedMesh` creates a bounded `IfcBuildingElementProxy` plan from
an already segmented textured triangle mesh, retaining independent UV seams and
the original image URI. It uses the same native authoring and geometry path as
annotation creation. See [captured surface creation](../../docs/api/wasm.md#captured-textured-surface-creation)
for coordinate, budget and atomic host-commit requirements.

Captured-mesh planning preserves optional `repeatS`/`repeatT` image sampler flags
(default `false`); UVs remain bounded to `[0, 1]`.

`IfcAPI.registerScanCorrespondences` fits bounded manual source-scan/IFC point
pairs and returns a proper rigid transform plus separate fitting and held-out
residuals. Frames and asset identities are bound into the report; the call does
not align a loaded model or approve scan accuracy. See the
[registration contract](../../docs/api/wasm.md#scan-correspondence-registration).

`IfcAPI.segmentScanPoints` detects planes in an xyz `Float32Array` point cloud
(voxel means, PCA normals, region growing, a robust refit and coplanar
merging). It also detects cylinders, such as columns and pipes, among the
remaining voxels (seeded RANSAC, then a least-squares refit), and wide round
and polygonal columns among rings of vertical planes; a column's surface is
not also reported as planes. The JSON report is independent of point order. See the
[segmentation contract](../../docs/api/wasm.md#scan-plane-segmentation); the
typed wrapper is `@ifc-lite/geometry/scan-segmentation`.

`IfcAPI.proposeScanElements` turns that report into proposed walls, slabs,
columns and pipes in the IFC model frame, each with a confidence and its source
detections; it creates nothing. See the
[proposal contract](../../docs/api/wasm.md#scan-element-proposals); the typed
wrapper is `@ifc-lite/geometry/scan-proposals`.

`IfcAPI.planMeshTransfer` composes registered opaque textured-mesh observations
onto supported direct IFC tessellations using the shared atlas planner. Unknown
samples retain existing target albedo; the IFPA response includes explicit
coverage and frozen-input bindings. Entirely unknown transfer has no applicable
plan. See the [transfer contract](../../docs/api/wasm.md#registered-textured-mesh-appearance-transfer)
for source identity, coordinate frames, budgets and host acceptance requirements.

`IfcAPI.preparePdfVectorPage` validates bounded ordered PDF vector graphics states
and preserves source operator identity, calibrated transforms and paint state.
Content the planner cannot convert (text, images, clips, transparency,
patterns, unqualified dashed strokes, curved/hairline strokes, unknown operators) is returned
as a fidelity report with counts, page extents and visibility, and an
`exact`/`rasterOnly` verdict; `IfcAPI.planPdfFillAnnotation` plans a partial
page only when the request quotes that report's digest as the user's
acceptance. It emits no IFC entities and makes no flattened-geometry fidelity
claim; see the
[preparation contract](../../docs/api/wasm.md#pdf-vector-graphics-state-preparation-and-fidelity-report).
Qualified positive dash patterns on open and closed straight subpaths preserve
phase, odd-array repetition, subpath reset, joins across vertices and run caps.
The closing edge participates in the pattern. PDF 1.0–1.7 retain caps where the
first and last on-dash pieces meet at the closure seam; PDF 2.0 joins them.
PDF.js's effective format version is bound into the page DTO; an unknown version
reports `dashVersion`, and a PDF 1.x dash covering the complete closed perimeter
reports `dashTopology`. Explicit close-path and close-and-stroke operators share
the versioned behavior.
Combined fill and dashed-stroke paints can still refuse atomically when
multiple run boundaries produce crossings outside the current fill-region
qualifier.

## Retained alignment station frames

`AlignmentAxisJs` evaluates one `IfcAlignment` through the canonical Rust
evaluator. Its `GlobalId` and `Name` properties use exact IFC EXPRESS names;
`expressId`, `geometricHorizontalLengthMeters` and `approximate` are derived
metadata. The caller owns the handle and must call `free()` in `finally`.

```ts
import init, { AlignmentAxisJs } from '@ifc-lite/wasm';

await init();
const content = await (await fetch('alignment.ifc')).text();
const axis = new AlignmentAxisJs(content, 39);
try {
  const sample = axis.evaluate(10);
  console.log(axis.GlobalId, axis.Name, sample);
} finally {
  axis.free();
}
```

`evaluate(distanceMeters)` returns a `Float64Array` containing horizontal
distance, absolute IFC Z-up point X/Y/Z in metres, and normalized world tangent
X/Y/Z. Distance is alignment-local geometric horizontal length from the physical
start, independent of authored chainage and different from 3D arc length. No
renderer origin or axis conversion is applied. Nonfinite or out-of-range
distances and unresolved units, curves or placements fail explicitly. The
`approximate` flag identifies supported approximation paths; it must be exposed
to precision-sensitive consumers. Whole-source parsing belongs in a disposable
worker when used by the viewer, so releasing the tool also releases WASM pages.

## Rust diff bindings

After initializing `@ifc-lite/wasm/diff`, `DiffModel` owns fingerprint columns for repeated synchronous comparisons. Its constructor accepts a string dictionary, five string indices per entity (key, IFC class, data hash, geometry hash, container), presence flags, six bounding-box coordinates per entity, volumes, component offsets, and component key/value indices. Raw column dictionary strings, comparison options and result keys preserve arbitrary UTF-16 code units. The internal TypeScript column adapter still rejects lone surrogates; the public TypeScript comparison API remains unchanged until the later facade cutover in #8042. An absent optional string uses `0xffffffff`; flag bits 0, 1, and 2 represent a bounding box, volume, and components. Call `.free()` in `finally` for each model.

Class matching uses the running JavaScript host's Unicode version for `trim().toUpperCase()`, including Node 22's older casing tables. Each model retains its unique non-ASCII IFC class names in Rust. After decoding comparison options, the boundary normalizes those names and non-ASCII exclusion/family members once per unique string, catching host exceptions before entering the pure Rust comparison. A scoped map also preserves normalized outputs as fixed points and is restored before result conversion. Native Rust callers retain their toolchain's Unicode mappings. ASCII IFC names require no JavaScript normalization calls.

This normalization contract assumes standard, idempotent string intrinsics. The boundary looks up the host methods at comparison time, but does not reproduce the TypeScript engine's per-entity method observation count or order for custom `String.prototype` overrides. Host exceptions from normalization retain their original thrown value, and the same models can be reused after a caught failure. Runtime parity regressions are in `test/diff-runtime-unicode-parity.test.mjs`; set `IFC_LITE_REQUIRE_UNICODE_WASM=1` to fail on missing built artifacts instead of skipping, and run against both Node 22 and Node 24.

`DiffModel.compare` returns row indices instead of JavaScript references. Keep the original fingerprint arrays and restore those references on the JavaScript side; opaque references never cross into WASM. The model can be reused for more comparisons before freeing it.

`diffStableHash` accepts UTF-16 code units, including unpaired surrogates. `diffBuildDataFingerprint` and `diffBuildComponentFingerprints` accept IFC adapter projections directly.

These two raw typed boundaries preserve arbitrary UTF-16 code units, including lone surrogates in typed names, material/classification strings, property/quantity object keys and recursively nested values. Only known record fields are read; ignored extras (including assigned-type `globalId`) are not observed or hashed. Each known field and nested value is read once. Property-value objects are content, so their keys and values participate in the fingerprint. The decoder mirrors the Rust input schema and must be kept in sync when that schema changes. Scalar strings use a checked bulk copy; non-scalar strings use original code units. The public `@ifc-lite/diff` index still uses the unchanged TypeScript engine. The TypeScript column adapter and raw lineage scalar guards remain until their corresponding lossless cutovers land.

`diffCreateSidecar`, `diffValidateSidecar`, and `diffSerializeSidecar` handle the small JSON sidecar documents; date validation uses the host's `Date.parse`. Sidecar serialization includes the trailing newline.

`diffLineageConflicts(entries)` returns ordered conflict diagnostics, and `diffKeyAliasesFromLineage(entries)` returns head/base pairs in insertion order for constructing a JavaScript `Map`. `diffRekeyByLineage(keys, entries, deleted, policy)` migrates external keys using `copy-to-all`, `largest-share`, or `orphan-on-split`. These helpers accept lineage objects directly, preserving non-finite share values for policy validation. Deleted keys have no `relation` field in their result. `largest-share` orphans splits with missing, empty, mismatched, non-finite or negative shares, or a tied maximum; invalid evidence does not throw. Zero is valid and shares need not sum to one. In this staging payload, every raw lineage string (base/head keys, reason, relation, rekey keys, deleted keys, and policy) must be well-formed UTF-16. The bindings reject unpaired surrogates before serde or wasm-bindgen can replace them; literal U+FFFD and valid surrogate pairs remain accepted. This limited scalar domain is temporary: the full lossless `JsString` engine/facade followup removes the rejection before public cutover.

These bindings are the staged backend for issue #8042. The public `@ifc-lite/diff` facade has not switched to them yet; existing consumers keep their current initialization contract until integration and performance qualification complete.

The Rust diff engine is a separate `@ifc-lite/wasm/diff` payload, built from `rust/diff-wasm` by `scripts/build-wasm.sh`. Its `DiffModel`, canonical fingerprint, sidecar and lineage bindings are loaded by explicit diff initialization; they are excluded from both geometry bundles. The committed `pkg-diff/ifc-lite-diff.d.ts` supports wasm-free typechecking.

The real IFC parity runner (`node scripts/diff-real-fixture-parity.mjs`) reports executed/total pairs. Missing fixtures are skipped with a `pnpm fixtures` hint; zero executed pairs exits with status 2 (incomplete), rather than claiming parity.

### Experimental retained whole-model engine

Build the separate `pkg-retained` bundle with `BUILD_RETAINED=1 bash scripts/build-wasm.sh`
and stage the SMLib transport at `/smlib/`. Its `IfcAPI.retainedModel(bytes, ids?)`
returns a `Promise<RetainedModelRun>`. The default `pkg` does not expose this method.

The run buffers results until completion. Call `run.next()` until it returns
`undefined`, then `run.free()`. Results follow the canonical processor's file
order; `ids` filters products, and an empty ID array selects none. Type products
and representationless jobs are skipped (orphan type geometry remains exact-only).

A published result has `status: 'published'`, `expressId`, `ifcType`, and `parts`.
Each part has object-local metre `Float64Array` positions, `Uint32Array` indices,
a column-major `Float64Array` `worldFromObject` into absolute IFC Z-up metres,
and `curved`. Every publication carries `marker: 'PresentationObligationsUnmet'`
and a nonempty `obligationsUnmet` list; consumers must display that marker. This
is shape-only output, without opening, layer, appearance or persistent-face authority.

A refusal has `status: 'refused'`, `expressId`, `ifcType`, a typed snake-case
`code`, optional `{site, entity?, cause}` `origin`, and `kernelStatus` for kernel
failures. It has no parts. A failed part refuses the entire product. There is no
exact fallback. One independently qualified worker is reused; worker failures
retire it, contract faults preserve it, and replacement is capped at three.
The worker is released before the completed run is returned.
