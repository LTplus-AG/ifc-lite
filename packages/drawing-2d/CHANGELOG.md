# @ifc-lite/drawing-2d

## 1.19.0

### Minor Changes

- [#1794](https://github.com/LTplus-AG/ifc-lite/pull/1794) [`631c3a0`](https://github.com/LTplus-AG/ifc-lite/commit/631c3a0813e722fa65ff052108c2cea3ac905801) Thanks [@louistrue](https://github.com/louistrue)! - Add DXF import as a 2D reference underlay ([#1782](https://github.com/LTplus-AG/ifc-lite/issues/1782)): `importDxf` parses ASCII DXF (LINE, LWPOLYLINE/POLYLINE with bulges, CIRCLE, ARC, ELLIPSE, SPLINE, SOLID/TRACE, HATCH, TEXT/MTEXT, DIMENSION blocks, INSERT/BLOCK with nested transforms) into world-plan geometry (metres, +Y = north) with per-layer visibility, ACI/true-colour and lineweight resolution, $INSUNITS scaling, and a unitless-file millimetre heuristic. `SVGExporter` gains an `underlays` option to composite DXF reference layers beneath exported drawings, and `applyDxfPlacement` positions underlays (offset/rotation/scale) in drawing space.

### Patch Changes

- Updated dependencies [[`2a7c7ff`](https://github.com/LTplus-AG/ifc-lite/commit/2a7c7ffe0ac27a8cc315e5d4a633c56469646cf0), [`90522d2`](https://github.com/LTplus-AG/ifc-lite/commit/90522d218d5a9c4df0760349b5bfc60916a23f8f), [`502c61b`](https://github.com/LTplus-AG/ifc-lite/commit/502c61bc7c0ae1ac313ed93ab335fdd942471c72), [`502bdbf`](https://github.com/LTplus-AG/ifc-lite/commit/502bdbf5c4c4c86999f4e662b71ee5b0b16307ae)]:
  - @ifc-lite/geometry@3.3.0

## 1.18.6

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a), [`d0647c9`](https://github.com/LTplus-AG/ifc-lite/commit/d0647c9a1801fc03b7c5d32314e53ef922c56f2f), [`26de705`](https://github.com/LTplus-AG/ifc-lite/commit/26de705b8608b9cd75e90411288c7ada96b3352b), [`bc1531f`](https://github.com/LTplus-AG/ifc-lite/commit/bc1531f899e5f8d18d1a6ff1ef6d997236a01243)]:
  - @ifc-lite/geometry@3.1.4

## 1.18.5

### Patch Changes

- Updated dependencies [[`8e43ecf`](https://github.com/LTplus-AG/ifc-lite/commit/8e43ecf540b88b942a4ec2127dd9bcf24ec244fa), [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53), [`3d25765`](https://github.com/LTplus-AG/ifc-lite/commit/3d25765edc2cee40268a6d5a27d4055f88f76489), [`b66ff1d`](https://github.com/LTplus-AG/ifc-lite/commit/b66ff1dd915a0ff4f60198a511adb7ed7f714079)]:
  - @ifc-lite/geometry@3.0.0

## 1.18.4

### Patch Changes

- [#1311](https://github.com/LTplus-AG/ifc-lite/pull/1311) [`207a4fb`](https://github.com/LTplus-AG/ifc-lite/commit/207a4fba4b86b2db67e8784b4d7b05a52cd86960) Thanks [@louistrue](https://github.com/louistrue)! - Reconstruct per-layer section fills from open (cap-free) material-layer bands. The geometry slicer no longer caps the layer interface planes — capping doubled each shared interface into a coincident, non-watertight "ghost face" sheet and ~tripled the triangle count on layered walls. With the interfaces left open, the 2D section's polygon builder is now bidirectional (each open band closes at the interface chord) and, for 3+ layer walls, stitches the disconnected end strips of an interior layer (which has no wall face) back into a closed fill at the interface chords — so every layer keeps its section fill.

  Harden that reconstruction on OPENING-cut walls so the 3D section cap covers every layer (no more wall-reads-hollow in section view). An opening splits each layer into disconnected solid chunks; the old greedy nearest-endpoint stitch hopped an interior layer's strip to the strip ACROSS the opening, emitting one self-overlapping polygon that bridged the void and failed to fill. Closure now runs along the interface lines (the principal/length axis of the band, so it is robust to rotated walls): endpoints are paired CONSECUTIVELY along each interface line, which closes each solid chunk and leaves the opening between chunks empty. Ambiguous layouts fall back to the previous stitch, so no case is made worse.

  Add an opaque base-cap backstop so a 3D section cut can NEVER read see-through, even on a wall the per-layer reconstruction cannot resolve. For each multi-material entity the builder also emits its full closed cross-section (the watertight union of the bands always closes, so this needs no interface stitching), carried in a new `Drawing2D.layerBaseCutPolygons` that ONLY the 3D section overlay consumes (the flat 2D drawing, SVG export, and measure/snap paths are untouched). The overlay draws this opaque base first and the per-layer colours over it, so the colours show where they reconstruct and solid cut material shows everywhere else.

  Fix multilayer walls reading HOLLOW in normal (uncut) 3D, not just in section. The renderer backface-culled material-layer slices on the assumption their winding was reliably outward — correct for the OLD closed per-layer slabs (the cull hid their coincident interface caps). Since the slabs became open bands whose union is the wall's watertight outer skin (no caps), and IFC winding is not reliably outward, culling dropped inward-wound faces and punched holes, so the wall looked like a thin see-through shell. Layer slices now render DOUBLE-SIDED like all other IFC geometry: every face of the watertight skin draws, so the wall reads solid. With no coincident caps left there is nothing to z-fight, so the cull that motivated the special pipeline is removed (the `GEOM_CLASS_LAYER_SLICE` tag stays — it now only marks per-layer section fills).

## 1.18.3

### Patch Changes

- [#1160](https://github.com/LTplus-AG/ifc-lite/pull/1160) [`631511e`](https://github.com/LTplus-AG/ifc-lite/commit/631511eedb135ea8bfc7caf640edea8862b86a59) Thanks [@louistrue](https://github.com/louistrue)! - Restore per-layer slicing of single-solid walls/slabs with an `IfcMaterialLayerSetUsage`. Slicing turns one solid into one coloured sub-mesh per material layer (geometry_id = the layer's `IfcMaterial`) so the build-up is visible in 3D. The "Merge Multilayer Walls" toggle now does what its label promises for these walls too — "render walls as one solid": with the toggle on, the layer index is not attached, so each wall stays a single swept solid instead of slicing into layers (off, the default, shows the layered build-up).

  The slicing kernel stayed intact, but [#874](https://github.com/LTplus-AG/ifc-lite/issues/874) (mesh-production unification) dropped the `set_material_layer_index` wiring from every pipeline, so the router's index was always `None` and `try_layered_sub_meshes` never fired — layered walls silently rendered as a plain single solid in the browser, native, and server paths. Re-wire it: build the `MaterialLayerIndex` once per load (cached on the IfcAPI for the streaming path, with a cheap substring bail-out so files with no layer set pay nothing) and attach it to every batch router. This also restores the "Merge Multilayer Walls" toggle for models whose sliceable walls carry their geometry as `IfcBuildingElementPart`s — the merged parent now actually draws its sliced solid instead of leaving a gap.

  2D section now shows the layers too. The section cutter carries each sub-mesh's colour onto its cut segments (CPU and GPU paths), and the polygon builder splits one entity's cut into a polygon per material colour — single-material elements still produce one colourless polygon, so their existing per-`ifcType` / per-entity fill is unchanged. When the viewer shows IFC materials, each sliced layer fills with its own `IfcMaterial` colour instead of one colour for the whole wall, and the layer divisions are drawn as outlines — matching the 3D build-up.

  Two follow-on robustness fixes:

  - **3D layer glitch (z-fighting).** Adjacent layer slabs share the parent wall's `expressId`, so the renderer's per-entity depth nudge (keyed on `entityId`) gave their coincident interior interface caps the SAME depth — under `cullMode: 'none'` + MSAA that z-fought into a flickering comb that read as "see inside / not solid". The shader now folds the per-draw `baseColor` into the depth-nudge hash; batches are keyed by colour, so abutting layers (distinct colours) land on distinct depths. Constant per draw, so flat faces stay flat and curved surfaces are unaffected.

  - **Cap watertightness on irregular profiles.** A layer slab's innermost cut is built by two successive plane clips; on a non-convex `IfcArbitraryClosedProfileDef` the two passes deposit geometrically-coincident section vertices that differ by ~1 ULP. `cap_half_space_clip` welded by exact f32 bits, so those twins stayed separate, the boundary chain dead-ended and a cap sub-loop was silently dropped — leaving open edges (a hole you could see through and a section with no fill there). The cap now welds on a spatial grid tied to its on-plane tolerance, collapsing the twins so the loop closes. Single-plane callers (opening cuts) have no such twins and are unaffected.

  - **3D section cut read hollow.** The live 3D section cap (`Section2DOverlayRenderer`) filled each cut polygon with a naive convex fan over the outer ring only, ignoring holes — a long-standing KNOWN LIMITATION. On the concave cross-sections that arbitrary IFC profiles (and material-layer slabs) cut into, the fan inverts and leaves the cut face uncovered, so a sectioned wall read as a hollow shell. The fill now uses the renderer's existing hole-aware ear-clipping (the same one the annotation-fill path uses), so the cut face is solid. The cap also now honours a per-polygon colour: a material-layer wall fills each layer of its 3D section cut with that layer's `IfcMaterial` colour (matching the 3D solids and the 2D section), while single-material cuts keep the uniform cap style + hatch unchanged via a sentinel.

  - **Solid layered 3D walls via backface culling.** Rendering a material-layer wall as N thin coincident-faced layer solids made it shimmer / read as a hollow shell — adjacent layers' interface caps z-fight under the viewer's double-sided rendering (culling is globally off because general IFC winding is unreliable), and same-material adjacent layers can't be depth-separated. The layer slices DO have reliable outward winding, though, so they're now tagged `geometryClass` 3 and the renderer draws that class with a dedicated **backface-culling** pipeline: the build-up stays visible on the wall's faces and edges, but the interior coincident caps never rasterise, so the wall reads as a clean solid (and a section cut through it shows the interior material surface rather than a hollow shell). The 2D/section cut consumes the same class — it never culls — for its per-layer fills. Cache `FORMAT_VERSION` → 9 so stale caches re-mesh with the class-3 slices.

- Updated dependencies [[`631511e`](https://github.com/LTplus-AG/ifc-lite/commit/631511eedb135ea8bfc7caf640edea8862b86a59)]:
  - @ifc-lite/geometry@2.7.6

## 1.18.2

### Patch Changes

- [#1114](https://github.com/LTplus-AG/ifc-lite/pull/1114) [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb) Thanks [@louistrue](https://github.com/louistrue)! - Per-element local frame: eliminate f32 "fan" corruption on building-scale and georeferenced models.

  When a mesh is stored at f32 precision while its vertices sit at building-scale world coordinates (a model whose extent reaches ~200 m from the coordinate origin), the f32 mantissa only resolves ~15 µm there, so vertices closer than one ULP collapse to the same value and the triangles joining them fan out as long needles across the model. Lowering the global RTC threshold is the wrong lever (it is reserved for >10 km federation re-basing), and a single global recentre still leaves the model genuinely spanning ~200 m.

  Each element's vertices are now stored RELATIVE to a per-element `MeshData.origin` (the f64 AABB centre, snapped to the kernel reconcile grid `1/65536 m`), so the f32 coordinates stay element-small and collapse-free at any building or georef scale; the world position is `origin + position`. The renderer reconstructs world space with a per-batch model-matrix translate around a single shared scene origin (so abutting elements in different colour batches stay bit-coincident with no seam z-fighting), and the selection-highlight / GPU-picker buffers replicate the batch's exact f32 path so highlights are bit-coincident with no depth bias. The local frame is ON for the wasm (viewer) path and opt-in for native/server, so determinism snapshots and server output stay absolute-coordinate byte-identical.

  Every world-space consumer of element geometry now folds `origin` (`world = origin + position`): camera/scene bounds, the CPU raycast + BVH narrow phase, snap detection, the section cutters (CPU + GPU), the BIM↔scan deviation BVH, the spatial index, clash (world-frame triangles fed to both the TS and Rust kernels), the glTF / IFC5 / Parquet exporters, the Cesium GLB overlay, the construction-projection outline + storey-band derivation, and the federation alignment / mesh-duplicate paths. `MeshData.origin` is serialized in the geometry cache (format version 6, which auto-heals stale entries). Position differences (normals, edge vectors, areas) are origin-invariant and unchanged.

  This composes with the sub-grid sliver hygiene pass: the local frame removes the f32-storage fans, and `Mesh::clean_degenerate` removes the sub-grid slivers the finer-grained CSG host emits.

- Updated dependencies [[`d2086aa`](https://github.com/LTplus-AG/ifc-lite/commit/d2086aa0c5ab5e4d4f98cb25498f58a88c24443c), [`4af01aa`](https://github.com/LTplus-AG/ifc-lite/commit/4af01aabe1c669864c3c3d1757789d7de81beaec), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`977b41d`](https://github.com/LTplus-AG/ifc-lite/commit/977b41db04a83d912f85cc9167cd564ffcb0aafb), [`e42b703`](https://github.com/LTplus-AG/ifc-lite/commit/e42b70324a9d5caab23257d52e96df0198d8caa9), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb)]:
  - @ifc-lite/geometry@2.7.0

## 1.18.1

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/geometry@2.4.1

## 1.18.0

### Minor Changes

- [#1001](https://github.com/LTplus-AG/ifc-lite/pull/1001) [`8862e79`](https://github.com/LTplus-AG/ifc-lite/commit/8862e790491f334ab3aeb36fca8b9ee5bb69e832) Thanks [@louistrue](https://github.com/louistrue)! - Scope construction projection to the current floor and exclude openings ([#979](https://github.com/LTplus-AG/ifc-lite/issues/979) follow-up).

  - **Current-floor scoping.** On a plan cut of a multi-storey model the projection
    bands now clamp to the storey the cut sits in, instead of projecting the whole
    model height — so a roof two levels up no longer draws on the ground-floor plan.
    New `@ifc-lite/drawing-2d` exports back this: `currentFloorBands` (pure band
    math) and `storeyFloorsFromMeshes` (per-storey floor levels from mesh-Y in the
    render frame, plus the `StoreyFloorMesh` type). The caller derives band depths
    from these; storey-less / single-storey / federated models fall back to the
    full-extent bands unchanged.
  - **Opening exclusion.** `IfcOpeningElement` and the rest of the
    `IfcFeatureElement` family no longer participate in projection.
    `Drawing2DGenerator.generate` filters them from BOTH the profile and the
    mesh-silhouette paths via the new `isFeatureElementType` helper, and the Rust
    `extract_profiles` (`@ifc-lite/wasm`) skips `is_subtype_of(IfcFeatureElement)`
    at the source so opening void cross-sections never become projection profiles.

## 1.17.0

### Minor Changes

- [#989](https://github.com/LTplus-AG/ifc-lite/pull/989) [`1effb90`](https://github.com/LTplus-AG/ifc-lite/commit/1effb900edd0a70db75f90839a4cc9f8fecb8d5e) Thanks [@louistrue](https://github.com/louistrue)! - Construction projection for 2D floor plans ([#979](https://github.com/LTplus-AG/ifc-lite/issues/979)). Project geometry beyond the
  section cut as architectural reference lines — thin solid for the visible floor
  side, dashed for overhead elements (beams, roofs, eaves).

  New public API:

  - `SectionConfig.projectionBelowDepth` / `projectionAboveDepth` — band depths
    for the visible/overhead split (default to `projectionDepth`).
  - `GeneratorOptions.outlineProvider` — inject a winding-robust footprint outline
    (the Rust `meshOutline2d` binding) for non-extruded geometry; falls back to
    the mesh silhouette when absent.
  - `projection-bands` exports: `classifyDepthRange`, `classifySegmentBand`,
    `signedDepth`, `bandVisibility`, `projectPointForPlane`,
    `getViewDirectionForPlane`, `outlineToProjectionLines`, and the
    `ProjectionBand` / `ProjectionBandDepths` / `MeshOutline2D` types.

  `Drawing2DGenerator.generate`'s projection stage now sources lines from
  profile boundaries + mesh silhouettes (replacing the noisy crease-edge path)
  and classifies them into the below/above bands.

### Patch Changes

- Updated dependencies [[`b6f352f`](https://github.com/LTplus-AG/ifc-lite/commit/b6f352f75e1431cf926eca0dcb3344aead140c2f)]:
  - @ifc-lite/geometry@2.4.0

## 1.16.2

### Patch Changes

- [#946](https://github.com/LTplus-AG/ifc-lite/pull/946) [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0) Thanks [@louistrue](https://github.com/louistrue)! - Fix a batch of verified findings from a full-codebase review (security, correctness,
  data-loss, and resource/memory leaks). Highlights:

  **Security**

  - collab-server: a malformed WebSocket frame no longer crashes the whole process
    (decode is wrapped; a bad frame is rejected/audited instead of throwing).
  - mcp: the local HTTP transport now validates `Host`/`Origin` and no longer sends a
    wildcard `Access-Control-Allow-Origin`, closing a DNS-rebinding/CSRF hole; the
    `AuthScope.modelIds` allowlist is now enforced at model resolution.
  - server-bin: `extractZip` uses `execFileSync` (argv, no shell), removing command
    injection via archive/destination paths.
  - export / sdk / cli / mcp / lists / viewer CSV exporters now neutralize spreadsheet
    formula injection (CWE-1236) consistently.
  - create-ifc-lite: validates the project name (no path traversal) and drops the
    unused `execSync`-based downloader.
  - embed-sdk: inbound `postMessage` now validates `event.origin`.

  **Correctness / data-loss**

  - parser: `lengthUnitScale` survives the worker transport; the nested STEP list
    parser is string-aware (commas/parens inside quoted values no longer mis-split).
  - mutations: deleting a property from a session-created pset and replaying
    `UPDATE_ATTRIBUTE` / `CREATE_PROPERTY_SET` mutations now work.
  - export: merged-export ID remapping no longer rewrites `#N` inside quoted strings.
  - drawing-2d: GPU section cutter triangle upload/readback use correct WGSL std-layout
    offsets and strides.
  - ifcx: cyclic children no longer abort the parse; spatial children round-trip; the
    mesh transform guards a zero/non-finite homogeneous `w`.
  - data / cache: a `NULL` string property value stays `null` instead of becoming `""`.
  - pointcloud, bcf, server-client, query, viewer-core, viewer store/federation: assorted
    decoding, federation-id, and selection-state fixes.

  **Resource / memory leaks**

  - geometry, query (DuckDB), renderer (GPU buffers), collab (federation presence),
    sandbox (host log capture + runtime), mcp (clash mesh cache), server-bin (signal
    listeners), and the viewer renderer on unmount now release resources deterministically.

  **Hardening (apps, not published)**

  - server: a dedicated `server-release` Cargo profile (`panic = "unwind"`) plus a
    `CatchPanicLayer` contain a malformed-IFC parse panic to the offending request
    instead of aborting the whole server.
  - desktop (Tauri): a Content-Security-Policy is set, and unused `shell:*` /
    `fs:allow-write|mkdir|remove` capabilities (and the unused shell plugin) are removed.

  **Second pass** (additional verified findings)

  - collab-server: S3 log load now follows `ListObjectsV2` pagination (no dropped frames);
    awareness frames are size-capped + rate-limited; path-lock verify runs after role/rate-limit;
    the blob route requires auth and `/metrics` can be token-gated.
  - server-bin: downloaded binaries are SHA-256 verified against a release sidecar (fail-closed on
    mismatch, warn-if-absent for older releases).
  - extensions: inner-ring capability check fails _closed_ for unknown namespaces; signing
    canonicalization is now injective (length-prefixed).
  - correctness/leaks: mutations quantity type+unit preserved on replay; `findByProperty` boolean
    comparisons; Parquet REAL columns kept as Float64; blob GC fail-safe on missing `uploadedAt`;
    spatial-hierarchy + codegen cycle guards; BVH NaN edge; bSDD/playground caches bounded;
    point-cloud GPU asset freed on federation error; mcp `parseColor` rejects non-hex; bcf/SVG/STEP
    output escaping; and more.

- Updated dependencies [[`55fd14e`](https://github.com/LTplus-AG/ifc-lite/commit/55fd14e5017f626567b10622bb41ddac3311e70c), [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0)]:
  - @ifc-lite/geometry@2.3.0

## 1.16.1

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/geometry@2.0.0

## 1.16.0

### Minor Changes

- [#650](https://github.com/louistrue/ifc-lite/pull/650) [`2ff772d`](https://github.com/louistrue/ifc-lite/commit/2ff772d0174f8cd6657f7e4090e15bc7744e8158) Thanks [@louistrue](https://github.com/louistrue)! - Arbitrary-normal section planes with face-pick (Bonsai-style) and a
  properly-rendered cap on tilted planes (#243). Click any face in the
  section tool's "Pick" mode to cut through it; the kept half-space
  defaults to the side facing the camera. The cardinal "Down / Front /
  Side" presets are unchanged.

  Renderer:

  - New `planeBasis(normal)` + `nearestCardinalAxis(normal)` exports
    derive a deterministic in-plane basis used by both the cap renderer
    and the 2D cutter — without a single shared derivation the cap hatch
    rotated when state was reconstructed.
  - `SectionPlaneRenderOptions` and `SectionPlane` gain optional
    `normal` + `distance` fields. When set, the shader clips on that
    plane verbatim (no axis mapping, no building-rotation, no
    position-percentage math) and the gizmo renders as a violet quad
    oriented from `planeBasis(normal)`.
  - `Section2DOverlayRenderer.uploadDrawing` accepts an optional
    `customPlane = { origin, tangent, bitangent }`. When supplied it
    replaces the cardinal-axis 2D→3D coordinate swap with
    `origin + tangent·x + bitangent·y`, so the cap silhouette lands
    exactly on the tilted plane (the bug PR #581 hid by suppressing the
    cap entirely for non-cardinal planes).

  Drawing-2d:

  - `SectionPlaneConfig` gains an optional `customPlane`. `SectionCutter`
    uses it verbatim for the plane equation and projects intersections
    to 2D via `(dot(p − origin, tangent), dot(p − origin, bitangent))`,
    matching the cap renderer's lift exactly.
  - `DrawingGenerator` now rebuilds the CPU cutter on each `generate()`
    call so a switch from cardinal to custom (or between custom planes)
    takes effect immediately.

  Tests: 11 new viewer tests covering normalisation, sign-preserving
  cardinal mapping, basis orthonormality, half-space flip, slice
  clearing on cardinal preset, and degenerate-normal handling. 6 new
  renderer tests covering basis derivation across cardinal axes,
  near-axis tilts, and the +Y / −Y reference-axis boundary.

## 1.15.3

### Patch Changes

- [#561](https://github.com/louistrue/ifc-lite/pull/561) [`8f4df0e`](https://github.com/louistrue/ifc-lite/commit/8f4df0e50e22419353829114b5af80cfd5d45805) Thanks [@louistrue](https://github.com/louistrue)! - 3D section cap with screen-space hatches, driven by exact cut polygons.

  ### `@ifc-lite/renderer`

  - **3D cut surface (cap) rendering.** `Section2DOverlayRenderer` gained
    a fill pipeline that paints the user's cap style on top of the exact
    polygons `SectionCutter` produces from triangle-plane intersection.
    Eight built-in screen-space hatch patterns are supplied via the new
    `section-cap-style.ts` module: `solid`, `diagonal`, `crossHatch`,
    `horizontal`, `vertical`, `concrete` (clean dot grid, ISO 128-50),
    `brick`, `insulation`. Pattern ids match the numeric branches in the
    fill fragment shader and are pinned by unit tests so changes can't
    drift silently. New `Section2DOverlayCapStyle` shape carries fill,
    stroke, pattern id, spacing/angle/width, and a secondary cross-hatch
    angle.
  - **Outline + fill toggle independently.** `Section2DOverlayOptions`
    has new `showFills` and `showOutlines` booleans, both honoured by
    `Section2DOverlayRenderer.draw()`, so callers can hide the cut hatch
    without losing the line drawing or vice versa.
  - **Cap respects model depth.** Both fill and outline pipelines test
    with `depthCompare: 'greater-equal'` (reverse-Z) and don't write
    depth, so when the camera looks through closer model geometry the
    cap is occluded naturally. Cap polygons live exactly on the plane,
    so equal-depth ties tie cleanly with greater-equal.
  - **Cap fill landed exactly on the plane.** Removed the old 0.3 m
    vertical bias that made the hatch visibly drift off the slider
    position; the fill now sits on the cut surface itself.
  - **Depth format unified at `depth24plus-stencil8`.** Main, instanced,
    section-plane preview, and 2D overlay pipelines all declare the same
    depth/stencil format and route through `PIPELINE_CONSTANTS.DEPTH_FORMAT`
    so the literal lives in exactly one place. All in-pass pipelines also
    declare both colour attachments (main colour + objectId, the latter
    with `writeMask: 0`) so WebGPU validation passes regardless of which
    shaders render inside the section render pass.
  - **`flipped` flag plumbed end-to-end.** Main and instanced fragment
    shaders pack `enabled` (bit 0) + `flipped` (bit 1) into one flag slot
    and negate the keep side when flipped — slider position stays where
    it is, only the kept half swaps.
  - **`SectionCapStyle`, `HatchPatternId`, `DEFAULT_CAP_STYLE`, and
    `HATCH_PATTERN_IDS` exported from the package** as the canonical
    styling primitives consumed by the viewer store and the fill shader.
  - **Renderer log on first section enable** (`[Section] Y-up bounds
used for clip: …`) so a user can verify the slider range matches
    their geometry without opening a debugger.

  ### `@ifc-lite/drawing-2d`

  - **Plane equation no longer changes when `flipped`.** Both
    `SectionCutter` and `gpu-section-cutter` now build the plane normal
    from `getAxisNormal(axis, false)` regardless of the flipped flag.
    Previously the flipped normal was paired with an unchanged
    `planeDistance`, which described a different plane (`y = -position`
    instead of `y = position`) — the cutter then looked for intersections
    far outside the model and produced an empty 2D drawing. `flipped` is
    still honoured by `projectTo2D` so the resulting drawing mirrors
    correctly when viewed from the opposite side.

  ### `viewer`

  - **`SectionCapControls` panel.** New compact controls inside the
    expanded Section panel: independent Display toggles for _Surfaces_
    (cap fill) and _Lines_ (outline), hatch pattern dropdown, fill +
    stroke colour pickers, and Spacing / Angle / Width number inputs in
    a 3-col grid. The hatch fieldset disables itself when Surfaces are
    off so users can't tweak settings that don't apply. Every control
    has an explicit `id`/`htmlFor` association via `useId()` for
    assistive tech.
  - **Flip button reflects state.** Now toggles `variant` to `default`,
    carries `aria-pressed`, and swaps `aria-label`/`title` between
    "Flip cut direction" and "Unflip cut direction".
  - **Auto-enable on slider/axis change.** Moving the position slider or
    picking a direction now sets `enabled: true` so users no longer get
    stuck in a no-op "preview mode" wondering why nothing cuts. The
    bottom toggle relabelled "Clip on/off" instead of the old
    "Cutting/Preview" wording that read as if the cut was always live.
  - **2D panel auto-fits on Flip.** `useViewControls` now triggers
    `fitToView` on `sectionPlane.flipped` change as well as axis change,
    so flipping doesn't park the polygons off-screen and leave the
    panel blank.
  - **Cap style persists across reloads.** `showCap`, `showOutlines`,
    and the full `capStyle` (fill, stroke, pattern, spacing, angle,
    width, secondary angle) round-trip to `localStorage` under the keys
    `ifc-lite:section-cap-show`, `ifc-lite:section-outlines-show`, and
    `ifc-lite:section-cap-style`. `resetSectionPlane()` clears them so
    the default button actually resets. `resetViewerState()` (called on
    every IFC load) preserves persisted cap settings and only clears
    axis/position/enabled/flipped — so opening a new file no longer
    wipes the user's hatch and colour choices.
  - **Cap style types deduplicated.** `SectionCapHatchId` and
    `SectionCapStyle` in the viewer store are now re-exports of the
    renderer's `section-cap-style.ts`, so adding a new pattern only
    requires editing the renderer.
  - **localStorage failures are diagnosable.** Every persistence catch
    in `sectionSlice` now logs via `console.warn` instead of a bare
    `catch {}` — quota / private-mode / serialisation failures still
    fall back gracefully but show up in devtools.

## 1.15.2

### Patch Changes

- [#552](https://github.com/louistrue/ifc-lite/pull/552) [`aeb5edf`](https://github.com/louistrue/ifc-lite/commit/aeb5edf89605d103582f68866c92d69ef6cb4635) Thanks [@louistrue](https://github.com/louistrue)! - Fix `ERR_MODULE_NOT_FOUND` when the published packages are loaded by Node's native ESM resolver (SSR, serverless, Vitest Node mode, CI test runners, etc.).

  Several relative imports in the source omitted the `.js` extension. Under the old workspace `moduleResolution: "bundler"` TypeScript tolerated them and emitted the specifiers verbatim, so `dist/*.js` shipped extensionless relative imports. Bundlers (Vite/webpack/esbuild) resolved them transparently, but Node's native ESM resolver strictly requires the file extension and threw `ERR_MODULE_NOT_FOUND` — most visibly in `@ifc-lite/renderer`'s `dist/snap-detector.js` importing `./raycaster`.

  All offending relative imports have been rewritten to include explicit `.js` (or `/index.js` for directory imports), and every publishable package's TypeScript config now uses `module: "nodenext"` + `moduleResolution: "nodenext"` so the TypeScript compiler rejects extensionless relative imports at build time, preventing regressions. Every published package has been smoke-imported via `node --input-type=module` to verify the fix end-to-end.

## 1.15.1

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/geometry@1.16.2

## 1.15.0

### Minor Changes

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Add LOD geometry generation, profile projection for 2D drawings, and streaming server integration

### Patch Changes

- Updated dependencies [[`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0)]:
  - @ifc-lite/geometry@1.16.0

## 1.14.3

### Patch Changes

- Updated dependencies [[`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0)]:
  - @ifc-lite/geometry@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies [[`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607)]:
  - @ifc-lite/geometry@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies [[`02876ac`](https://github.com/louistrue/ifc-lite/commit/02876ac97748ca9aaabfc3e5882ef9d2a37ca437)]:
  - @ifc-lite/geometry@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.7.0

## 1.4.0

### Minor Changes

- Initial release of drawing-2d and mutations packages

  - @ifc-lite/drawing-2d: 2D architectural drawing generation (section cuts, floor plans, elevations)
  - @ifc-lite/mutations: Mutation tracking and property editing for IFC models
