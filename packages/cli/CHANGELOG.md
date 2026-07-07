# @ifc-lite/cli

## 0.17.0

### Minor Changes

- [#1656](https://github.com/LTplus-AG/ifc-lite/pull/1656) [`94f4713`](https://github.com/LTplus-AG/ifc-lite/commit/94f471365b7185822f15f02202ef52c81e4f203e) Thanks [@louistrue](https://github.com/louistrue)! - Add `ifc-lite extract-entities` — isolate a handful of entities from a large IFC into a small, valid, viewable standalone model, the "reproduce a suspect element" step of a geometry-triage loop.

  Selectors (unioned): `--product <GUID|expressId>` (repeatable / comma-list), `--type <IfcType>`, `--storey <GUID|name|expressId>` (every product placed under a storey via its placement chain), and `--detect [--top N]` (the meshes a geometry-triage pass ranks most unusual). The output carries each selected product's full forward reference closure plus the shared context roots (IfcProject, unit assignment, geometric contexts, and the site/building/storey spatial skeleton) and every spatial-containment relation whose members are all kept — so the result parses and renders on its own with zero dangling references. Add `--view` to open it in the viewer.

  Crucially, a selected element also carries its openings and their fillers: every `IfcRelVoidsElement` whose host is kept (plus the `IfcOpeningElement` cutter) and every `IfcRelFillsElement` whose opening is kept (plus the window/door). These relations point _backward_ to the host, so forward closure alone never reaches them — without this an isolated wall extracts as an uncut box, hiding the very void-cut geometry a triage loop needs to reproduce.

  `extract-entities <file> --detect --report [--json]` prints a triage report without extracting, separating HARD defects (non-finite or `|coord|>1e4` vertices after the per-element local-frame/RTC recentre — genuine corruption) from REVIEW heuristics (oversized AABB) that are frequently legitimate for thin or large elements and must be eyeballed, not trusted.

### Patch Changes

- [#1651](https://github.com/LTplus-AG/ifc-lite/pull/1651) [`52d861c`](https://github.com/LTplus-AG/ifc-lite/commit/52d861cdace765965dc79953916403b3ab0e3da6) Thanks [@louistrue](https://github.com/louistrue)! - Surface the rect-fast `deferTooManyOpenings` counter in the geometry diagnostics. The Rust `RectFastSummary` already emits it (the opening-count DoS cap, [#1649](https://github.com/LTplus-AG/ifc-lite/issues/1649)); the `GeometryDiagnostics.rectFast` and server-client types now include it (optional, defaulted to 0 when absent so older payloads merge cleanly), `mergeGeometryDiagnostics` sums it, and the CLI geometry report renders it in the rect_fast defer breakdown.

- Updated dependencies [[`5e1fe56`](https://github.com/LTplus-AG/ifc-lite/commit/5e1fe568b007f5f434db5f585e90551979f32aae), [`52d861c`](https://github.com/LTplus-AG/ifc-lite/commit/52d861cdace765965dc79953916403b3ab0e3da6)]:
  - @ifc-lite/wasm@3.0.12
  - @ifc-lite/geometry@3.1.3

## 0.16.1

### Patch Changes

- Updated dependencies [[`1d53646`](https://github.com/LTplus-AG/ifc-lite/commit/1d536460663b8ce607fb648ab2e996ac445ff651), [`fcbb667`](https://github.com/LTplus-AG/ifc-lite/commit/fcbb6679dd752f5b8be670c6a9e2d3fdc0b57e3d), [`7c65f23`](https://github.com/LTplus-AG/ifc-lite/commit/7c65f232952dcf0c1f7f6ebee3605fd556323035), [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47), [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47)]:
  - @ifc-lite/wasm@3.0.5
  - @ifc-lite/parser@3.7.0
  - @ifc-lite/data@2.4.0
  - @ifc-lite/mutations@1.18.0
  - @ifc-lite/mcp@0.7.0
  - @ifc-lite/ids@1.15.24

## 0.16.0

### Minor Changes

- [#1564](https://github.com/LTplus-AG/ifc-lite/pull/1564) [`0762522`](https://github.com/LTplus-AG/ifc-lite/commit/076252241ec4201462f7fcf0555c83606de5fecd) Thanks [@louistrue](https://github.com/louistrue)! - `diagnose-geometry` gains `--product <expressId|GlobalId>` and `--type <IfcType>` flags to narrow the worst-failing-hosts detail list to a single product or IFC type. Worst-failing hosts now also report a world-space bounding box and final triangle count when a void cut captured them, surfaced in both `--json` and the human-readable report.

  Fixed `--quiet`/`--verbose` on `diagnose-geometry`: its status line ("Wrote diagnostics to...") now routes through the leveled logger like every other command, so `--quiet` actually silences it instead of always printing to stdout via a raw `console.log`. The JSON/report payload itself is unaffected by verbosity, same as every other command.

- [#1497](https://github.com/LTplus-AG/ifc-lite/pull/1497) [`d7a3205`](https://github.com/LTplus-AG/ifc-lite/commit/d7a3205524e023f936b29ee1bc113d1d10e3b0b1) Thanks [@Blogbotana](https://github.com/Blogbotana)! - feat(parser): support opening `.ifcZIP` containers (issue [#1494](https://github.com/LTplus-AG/ifc-lite/issues/1494))

  The buildingSMART IFC container format — a zip archive wrapping a single
  `.ifc`/`.ifcxml` file — is now unwrapped transparently. New `@ifc-lite/parser`
  exports:

  - `isZipBuffer(buffer)` — cheap magic-byte check.
  - `unwrapIfcZip(buffer)` — returns the model file's bytes if `buffer` is a
    zip container, or `buffer` unchanged otherwise (safe to call
    unconditionally on every load). Throws if the archive has zero or more
    than one `.ifc`/`.ifcxml` entry rather than guessing which to load, or if
    the entry's declared uncompressed size exceeds 4 GiB (a zip-bomb guard,
    checked from the zip central directory — no decompression needed to check).
  - `unwrapIfcZipView(view)` — same contract for a Node `Buffer`/`Uint8Array`.

  `parseAuto` calls it automatically. The CLI and MCP loaders (`loadIfcFile`,
  `loadIfcModel`) unwrap before their STEP-signature check, so `ifc-lite info
model.ifcZIP` and MCP's `model_load` just work. The viewer's file picker and
  drag-and-drop now accept `.ifczip` alongside `.ifc`/`.ifcx`/`.glb`.

  The hosted Rust parsing server (`apps/server`) unwraps `.ifcZIP` too, in its
  multipart `extract_file` path (alongside the existing gzip handling), so an
  uploaded container is decompressed server-side before parsing and the viewer's
  multi-core server fast-path works for zipped uploads. It applies the same
  single-`.ifc`/`.ifcxml`-entry rule and bounds the decompressed size against the
  server's max-file-size ceiling (zip-bomb guard).

  Referenced resources inside the container (textures, documents) are not
  extracted in this pass — only the model file's bytes.

### Patch Changes

- [#1562](https://github.com/LTplus-AG/ifc-lite/pull/1562) [`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db) Thanks [@louistrue](https://github.com/louistrue)! - Weld per-face-duplicated faceted-brep vertices at the mesh SOURCE instead of per export. The faceted-brep mesher emits geometry per `IfcFace` with no cross-face vertex sharing, so a closed shell duplicates every shared corner once per incident face (~3-6x). That collapse now happens once, at the single per-element mesh funnel (`build_mesh_data` in `produce_element_meshes`), so every element -- render, GLB/OBJ export, and analysis -- arrives welded in its `MeshData`, and the previously separate per-export welds (from-bytes `to_yup` and the viewer's from-meshes GLB path) are removed as redundant. The weld keys on the exact position plus a quantized normal, so creases (a cube corner shared by three faces with distinct normals) stay split and flat/crease shading is preserved; world triangles, winding, and the world AABB are unchanged. It is deterministic and byte-identical cross-arch (native == wasm32, positions and topology identical, only the documented libm-trig normals differ), and closes the volume/watertightness gap for non-voided faceted breps on the render path (voided elements already welded via the coplanar-facet pass). The mesh-output determinism manifests are re-pinned for the one affected battery element (the round column [#500](https://github.com/LTplus-AG/ifc-lite/issues/500), an extruded circular profile: 216 -> 144 vertices, triangle count unchanged).

- Updated dependencies [[`218e613`](https://github.com/LTplus-AG/ifc-lite/commit/218e613b06cc5ca2a74c84f72e039b430be6caee), [`0762522`](https://github.com/LTplus-AG/ifc-lite/commit/076252241ec4201462f7fcf0555c83606de5fecd), [`d7a3205`](https://github.com/LTplus-AG/ifc-lite/commit/d7a3205524e023f936b29ee1bc113d1d10e3b0b1), [`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db), [`47bde10`](https://github.com/LTplus-AG/ifc-lite/commit/47bde10dcacddf8f99e1e6b2bf036c78c192c5ff), [`b157b48`](https://github.com/LTplus-AG/ifc-lite/commit/b157b4841bfa795f8a937a9be20c21b645757fbe)]:
  - @ifc-lite/clash@1.5.0
  - @ifc-lite/geometry@3.1.0
  - @ifc-lite/parser@3.6.0
  - @ifc-lite/mcp@0.6.0
  - @ifc-lite/wasm@3.0.4
  - @ifc-lite/export@2.5.0
  - @ifc-lite/ids@1.15.23

## 0.15.1

### Patch Changes

- [#1553](https://github.com/LTplus-AG/ifc-lite/pull/1553) [`369ee9b`](https://github.com/LTplus-AG/ifc-lite/commit/369ee9b680309ca70c569b3f26bd07acfb83c19d) Thanks [@louistrue](https://github.com/louistrue)! - Shrink GLB exports by welding per-face-duplicated vertices. The faceted-brep mesher emits geometry per `IfcFace` with no cross-face vertex sharing, so a closed shell duplicated every shared corner once per incident face (~3-6x) -- the direct cause of the ~8x-larger GLBs seen on structural (faceted-brep-heavy) models versus reference extractors. Exports now collapse vertices that share an identical position and coinciding normal at the single glTF write funnel, then remap indices. World triangles, the world AABB, and flat/crease shading are preserved exactly (creases keep distinct normals and stay split); the weld is deterministic and cross-arch, applies to every GLB path (in-memory, streaming, bounded, and the viewer's from-meshes export), and leaves `process_geometry` output and the mesh-output determinism manifests untouched.

- Updated dependencies [[`369ee9b`](https://github.com/LTplus-AG/ifc-lite/commit/369ee9b680309ca70c569b3f26bd07acfb83c19d)]:
  - @ifc-lite/wasm@3.0.3
  - @ifc-lite/geometry@3.0.3
  - @ifc-lite/export@2.4.1

## 0.15.0

### Minor Changes

- [#1512](https://github.com/LTplus-AG/ifc-lite/pull/1512) [`452b1c0`](https://github.com/LTplus-AG/ifc-lite/commit/452b1c0d9e7db215b9194f38503dec683a5d6046) Thanks [@louistrue](https://github.com/louistrue)! - CLI-wide verbosity convention: global `--verbose`, `--quiet`, `--debug`, and `--log-level <error|warn|info|debug>` flags (parsed and stripped before dispatch, so positional file paths are never confused with flag values). Human logs go to stderr only; stdout stays reserved for payloads and `--json`. Failures now print `Error [<command>]: <message>` with a remediation hint, and stack traces show under `--debug`/`--verbose` (the `DEBUG` env var still works). Parser diagnostics are no longer hard-silenced: they surface on stderr under `--verbose`. `export` gains `--diagnostics` (implied by `--verbose`), printing the same CSG/opening geometry report as `diagnose-geometry` from the export's own context.

- [#1491](https://github.com/LTplus-AG/ifc-lite/pull/1491) [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53) Thanks [@louistrue](https://github.com/louistrue)! - feat(export): large-model GLB reliability - bounded memory, fail-closed, byte returns

  Three related hardening changes on the export surface:

  - **Bounded-memory GLB.** Inputs at or above 64 MB (native override
    `IFC_LITE_GLB_STREAM_THRESHOLD_MB`, `0` disables) are exported through a
    two-pass streaming assembler: pass 1 records per-mesh metadata only, pass 2
    re-streams and bakes vertex bytes directly into an exactly-preallocated GLB.
    Peak memory is the final artifact plus one mesh batch instead of the whole
    model's meshes plus multiple full-buffer copies - this fixes the wasm
    `RuntimeError: unreachable` / OOM on large in-browser exports. Models without
    instanceable groups produce byte-identical output; instanced models keep
    identical world geometry (rep-identity instancing is skipped above the
    threshold, content-hash dedup is kept).

  - **Fail-closed empty GLB at the boundary.** `exportGlb` now throws a typed
    `Error` whose message starts with `NO_RENDER_GEOMETRY` when the visible mesh
    set is empty, instead of returning a structurally valid but empty GLB.
    `@ifc-lite/geometry` exports `NO_RENDER_GEOMETRY` and
    `isNoRenderGeometryError(err)` to match it; the CLI and MCP map it to their
    existing tailored messages.

  - **BREAKING: sibling exporters return bytes.** `exportObj`, `exportCsv`,
    `exportJson`, `exportJsonld`, `exportIfcx`, `exportStep`, `exportMerged` and
    `exportHbjson` (wasm boundary, `IfcLiteBridge`, and `GeometryProcessor`) now
    return `Uint8Array` (UTF-8) instead of `string`, so output is no longer capped
    by the V8 max-string ceiling (~512 MB) - the same escape GLB already had.
    Decode with `TextDecoder` where a string is genuinely needed; file writers
    should write the bytes directly.

- [#1481](https://github.com/LTplus-AG/ifc-lite/pull/1481) [`204cab4`](https://github.com/LTplus-AG/ifc-lite/commit/204cab48f8e3b6326a8005628ed5b7174d9d694c) Thanks [@louistrue](https://github.com/louistrue)! - feat(export): add `unitReconciliation: 'normalize'` merge mode

  `MergedExporter` can now rescale a model whose length unit differs from the first
  model's into the primary unit, so a mixed-unit merge produces one ordinary
  single-unit `IfcProject` with one `IfcUnitAssignment` (opens correctly everywhere,
  BIM Vision included) instead of a multi-project federation.

  - Every length-valued datum is rescaled: all `IfcCartesianPoint` /
    `IfcCartesianPointList` coordinates, scalar lengths (extrusion depths, profile
    dimensions, radii, thicknesses, `IfcVector.Magnitude`, CSG primitive sizes,
    `IfcBuildingStorey.Elevation`, `IfcSite.RefElevation`), `IfcLengthMeasure`
    property values, and `IfcQuantityLength`. Which attributes are length-valued is
    derived from the IFC schema registry, not hand-rolled.
  - Areas and volumes are converted by their own declared `AREAUNIT`/`VOLUMEUNIT`
    ratio (not the length factor squared/cubed), so a model with millimetre lengths
    but square-/cubic-metre quantities (the common authoring-tool default) is not
    corrupted.
  - Angles, direction ratios, counts, unit definitions and georeferencing offsets
    are left untouched. `MergeExportResult.stats.normalizedModelCount` reports how
    many models were rescaled, and advisories are surfaced for schemas the length
    registry does not fully cover (IFC4X3) and for georeferenced models.

  The CLI `merge` command gains a `--unit-reconciliation <auto|normalize|assume-shared>`
  flag, and the viewer's merged export adds a "Mixed units" selector.

- [#1484](https://github.com/LTplus-AG/ifc-lite/pull/1484) [`a48abac`](https://github.com/LTplus-AG/ifc-lite/commit/a48abacfacdf226702f2454859afe9abe018e029) Thanks [@Blogbotana](https://github.com/Blogbotana)! - feat(export): configurable spatial merge matching in `MergedExporter`

  `MergedExporter` unifies `IfcSite`/`IfcBuilding`/`IfcBuildingStorey` across
  merged models with a single fixed heuristic today. It now accepts explicit
  matching strategies, mirroring IfcOpenShell/BlenderBIM's "Merge Projects"
  recipe:

  - `mergeSites?: 'single' | 'by-name'` — `'single'` ignores Name and unifies
    iff each model contributes exactly one `IfcSite`; `'by-name'` matches only
    same-name (case-insensitive) sites, with no single-instance fallback.
  - `mergeBuildings?: 'single' | 'by-name'` — same strategy, for `IfcBuilding`.
  - `mergeStoreys?: 'by-name' | 'by-elevation' | 'by-name-then-elevation'` —
    `'by-name'`/`'by-elevation'` match on exactly one criterion with no
    fallback; `'by-name-then-elevation'` is the pre-existing combined heuristic
    made explicit.

  All three options are optional and, when omitted, preserve today's exact
  default behavior (name match, else single-instance fallback for site/building;
  name-then-elevation for storeys) — purely additive, no default behavior change.

  One edge-case hardening applies in every mode, including the default: when two
  sites (or buildings) in the same secondary model would match the same
  first-model target (e.g. identical names), only the first claims it and the
  second is kept as its own root instead of being silently collapsed onto the
  same target. This brings site/building matching to parity with the
  pre-existing storey behavior.

  The CLI `merge` command gains matching `--merge-sites` / `--merge-buildings` /
  `--merge-storeys` flags.

### Patch Changes

- Updated dependencies [[`8e43ecf`](https://github.com/LTplus-AG/ifc-lite/commit/8e43ecf540b88b942a4ec2127dd9bcf24ec244fa), [`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229), [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53), [`66f31ac`](https://github.com/LTplus-AG/ifc-lite/commit/66f31acb761209f7cf78e83ef01c02a1ec3dc13a), [`54b5c6b`](https://github.com/LTplus-AG/ifc-lite/commit/54b5c6b043ebd83dc9b10bd15e9973e6a58293cb), [`204cab4`](https://github.com/LTplus-AG/ifc-lite/commit/204cab48f8e3b6326a8005628ed5b7174d9d694c), [`a48abac`](https://github.com/LTplus-AG/ifc-lite/commit/a48abacfacdf226702f2454859afe9abe018e029), [`3d25765`](https://github.com/LTplus-AG/ifc-lite/commit/3d25765edc2cee40268a6d5a27d4055f88f76489), [`6a515ba`](https://github.com/LTplus-AG/ifc-lite/commit/6a515ba31bbe31bb6f018f7476cc9616e4691448), [`b66ff1d`](https://github.com/LTplus-AG/ifc-lite/commit/b66ff1dd915a0ff4f60198a511adb7ed7f714079)]:
  - @ifc-lite/wasm@3.0.0
  - @ifc-lite/geometry@3.0.0
  - @ifc-lite/data@2.3.0
  - @ifc-lite/query@1.14.11
  - @ifc-lite/mcp@0.5.0
  - @ifc-lite/extensions@0.3.3
  - @ifc-lite/export@2.4.0
  - @ifc-lite/clash@1.4.1
  - @ifc-lite/parser@3.5.2
  - @ifc-lite/viewer-core@0.2.7
  - @ifc-lite/ids@1.15.22

## 0.14.0

### Minor Changes

- 909c1b0: Add a typed `GeometryDiagnostics` contract for CSG / opening diagnostics.

  The WASM batch path already computed a rich CSG / opening diagnostic summary
  (opening classification, per-reason failure breakdown, per-host detail, silent
  rectangular no-op detection, rect_fast fast-path engagement) and then discarded it,
  logging only to the browser console. A package consumer could not subscribe to it
  without scraping console output.

  This surfaces it as a typed, serializable contract:

  - `rust/geometry` exposes a `GeometryDiagnostics` struct and a wasm-free
    `aggregate_diagnostics` built from the drained router data, so the same shape is
    producible on the WASM and native paths from a single drain.
  - The WASM `MeshCollection` exposes the per-batch `diagnostics` as a JS object
    (replacing the earlier two scalar getters).
  - `@ifc-lite/geometry` exports the `GeometryDiagnostics` type and
    `mergeGeometryDiagnostics`, and surfaces a per-load `diagnostics` object on the
    streaming `complete` event: the geometry worker merges per-batch diagnostics
    across batches and the parallel loader merges across workers, logging one
    aggregate console summary.
  - The viewer reads `event.diagnostics` and logs a concise summary when CSG failures
    or silent no-ops occur; the full typed object rides the streaming event for a UI
    or telemetry consumer to subscribe to.
  - Native parity: the `rust/processing` geometry pass drains opening classification +
    per-host diagnostics from each per-element router and aggregates them through the
    same `aggregate_diagnostics`, attaching the full contract to
    `ProcessingStats.geometry_diagnostics` (the WASM bundle and the server emit it). The
    native streaming bridge forwards it onto the viewer `complete` event, so the
    native-only deployed viewer surfaces the same diagnostics as the WASM path, and
    `@ifc-lite/server-client` types it on the stats response.
  - CLI / SDK surface: a new wasm `diagnoseGeometry(bytes)` binding runs the same
    `process_geometry` pass and returns only its `GeometryDiagnostics`, exposed as
    `GeometryProcessor.diagnoseGeometry` and an `ifc-lite diagnose-geometry <file.ifc>`
    command (human-readable report, or `--json` for the raw contract).

  `totalCsgFailures` and the classification counts are exact; `productsWithFailures`,
  `hostsWithOpenings` and `silentNoOps` are batch-summed upper bounds.

### Patch Changes

- 24e1648: Make the Rust-backed exporters reliable on large and degenerate inputs.

  Remove the ~512 MB input cap on GLB/glTF (and the sibling OBJ, CSV, JSON, JSON-LD,
  STEP, IFCX, HBJSON exporters). They decoded the entire input IFC byte buffer into a
  single JS string via `safeUtf8Decode` before crossing into WASM, where the binding
  immediately turned it back into bytes (`content.as_bytes()`). For an input over V8's
  `0x1fffffe8` (~512 MB) string ceiling that decode threw "Cannot create a string longer
  than 0x1fffffe8 characters", so files in the 0.5 GB+ range failed before any geometry
  ran. The boundary now passes the raw `Uint8Array`/`&[u8]` straight through (matching the
  existing `exportMerged` path), which removes the cap, drops a redundant full-buffer copy
  and a UTF-8 re-encode, and is byte-faithful for non-UTF-8 input.

  Scope: this lifts the cap on the INPUT side for all exporters. GLB returns a
  `Uint8Array`, so its output also escapes the V8 ceiling; the string-returning
  exporters (OBJ/CSV/JSON/JSON-LD/STEP/IFCX/HBJSON) still cap their serialized OUTPUT
  at the same ~512 MB string limit. In-browser, the wasm32 linear-memory heap (not the
  string cap) is the practical ceiling for the very largest models.

  Fail loud on an empty GLB export. A malformed-but-parseable model (or a filter whose
  matched entities carry no triangulated geometry) produced a structurally valid GLB with
  zero meshes, which the CLI and MCP tools wrote to disk and reported as success. Both now
  reject a zero-mesh GLB with a clear error (new `countGlbMeshes` helper in
  `@ifc-lite/export`).

  Guard the GLB assembler against the glTF 32-bit buffer limit. The assembler cast every
  buffer offset and byteLength `as u32`; past 4 GiB those casts silently wrapped (release
  builds disable overflow checks) and emitted a corrupt GLB. It now sums the binary buffer
  length in `usize` and asserts the 4 GiB ceiling with a clear message instead of wrapping.

- 7c45192: Instance repeated geometry in GLB/glTF export (50-85% smaller on repetitive models).

  The from-bytes GLB assembler baked every element occurrence in full, so a model with
  hundreds of identical windows, doors, or steel parts (one IFC `RepresentationMap`
  referenced by many `IfcMappedItem`s) emitted that geometry hundreds of times. The
  exporter now reuses the same representation-identity collation the GPU/native
  instancing path uses: each repeated shape is emitted ONCE and every occurrence is
  placed with a glTF node matrix carrying its world pose.

  Each occurrence's node matrix is recomputed in f64 from the per-occurrence world
  placement, the model RTC / site-local offset the baker subtracted, and the Z-up to Y-up
  basis change, then folded against the model-wide scene centre before the single f32
  downcast. Doing the relative transform in the post-RTC baked frame (not the placement's
  pre-RTC frame) is what keeps a ROTATED occurrence correct under a non-zero site/georef
  offset — otherwise it is mis-translated by `(R - I) * rtc`, kilometres at national-grid
  coordinates. The f64 composition keeps the absolute-magnitude terms cancelling to a
  model-relative, f32-precise translation even at national-grid scale.

  Only exact-bit groups are instanced (the template's local geometry IS each occurrence's),
  so the exported per-occurrence geometry is byte-faithful; rigid-tier and any
  singular-placement groups fall back to the flat path. Two round-trip tests reconstruct
  every instanced occurrence's world geometry from `root.translation * node.matrix *
template_local` and match the baked geometry to under a millimetre — one on a real model,
  one synthetic with a rotated instance at national-grid coordinates.

  Non-instanced occurrences keep the existing self-contained `world - scene_center` vertex
  bake (no node transform), so a consumer that ignores node transforms still sees them
  correctly placed. The flat remainder is additionally content-hash deduped (byte-identical
  baked meshes share one mesh placed by a node translation), so the output never regresses
  below the prior per-occurrence baseline on models without representation-level repeats.

  Measured GLB size: C20-Institute 4.0 -> 1.3 MB (-68%), AC20-Smiley 13.0 -> 2.4 MB (-82%),
  schependomlaan 15.5 -> 7.6 MB (-51%); models with no repeats are unchanged. Output is
  byte-deterministic. The viewer's from-meshes GLB path is unaffected (it carries no
  instancing side-channel and falls back to the flat content-hash dedup).

- Updated dependencies [e6bd2dd]
- Updated dependencies [24e1648]
- Updated dependencies [f9f0784]
- Updated dependencies [7c45192]
- Updated dependencies [6eb46f1]
- Updated dependencies [775e479]
- Updated dependencies [4f76955]
- Updated dependencies [909c1b0]
- Updated dependencies [3f25a72]
  - @ifc-lite/geometry@2.13.0
  - @ifc-lite/wasm@2.14.0
  - @ifc-lite/export@2.3.0
  - @ifc-lite/mcp@0.4.1

## 0.13.0

### Minor Changes

- [#1242](https://github.com/LTplus-AG/ifc-lite/pull/1242) [`fec82b9`](https://github.com/LTplus-AG/ifc-lite/commit/fec82b9f3eea3655f92413fce82387ddce2f9722) Thanks [@louistrue](https://github.com/louistrue)! - Add Rust-backed domain-format exporters. The new `ifc-lite-export` crate is the
  source of truth for Wavefront OBJ, glTF/GLB, CSV, JSON and JSON-LD (plus a
  native-only ara3d BOS/Parquet path). They are exposed via wasm
  (`exportObj`/`exportGlb`/`exportCsv`/`exportJson`/`exportJsonld`) and
  reachable from TypeScript through `GeometryProcessor.export*` and
  `IfcLiteBridge.export*`. Geometry exporters fold per-mesh RTC origin correctly (glTF
  emits it as a node translation, keeping f32 vertex precision at georef scale).

  STEP export also supports schema conversion (`IFC2X3`/`IFC4`/`IFC4X3`/`IFC5` entity-type
  renames + attribute trimming) and a mutation bridge — `exportStep` takes a `mutations_json`
  payload (`MutablePropertyView` attribute edits + property-set synthesis: new
  `IfcPropertySingleValue`/`IfcPropertySet`/`IfcRelDefinesByProperties` entities). New Rust exporters:
  **IFC5/IFCX** (`exportIfcx` — USD-style node graph: spatial hierarchy + classes + known
  IFC5 properties) and **Merged** (`exportMerged` — combine several models into one STEP,
  id-offset + project unification).

  The CLI `export` command gains `--format obj|gltf|glb|jsonld|step|ifcx` (Rust-backed;
  `--type`/`--storey`/`--where`/`--limit` act as the isolation set — for `step` the forward
  `#`-reference closure is added so a filtered export never dangles a reference; `--schema`
  converts entity types). The MCP `export_glb` tool is unstubbed, `export_ifcx` is unstubbed,
  and a new `export_obj` tool is added (all honour an optional `type` filter).

  Also makes the wasm geometry engine usable under Node: `IfcLiteBridge.init()` now reads
  the `.wasm` bytes itself when running in Node (whose `fetch()` cannot load `file://`),
  strictly Node-gated so the browser/worker path is unchanged. This additionally fixes
  headless `clash`/geometry commands that previously failed to initialize wasm in Node.

  The viewer's GLB export now assembles the binary in Rust over the meshes it already
  holds (`GeometryProcessor.exportGlbFromMeshes`, wasm `exportGlbFromMeshes`) instead of the
  TypeScript GLTFExporter — no re-meshing, and the per-element RTC origin rides a glTF node
  translation so georef-scale models keep vertex precision.

  **BREAKING (`@ifc-lite/export`):** `GLTFExporter`, `JSONLDExporter`, and `CSVExporter`
  (+ their option types) are removed — glTF/GLB, JSON-LD, and CSV are now produced in Rust. Use
  `GeometryProcessor.exportGlb` / `exportGlbFromMeshes`, `exportJsonld`, and
  `exportCsv(bytes, mode, …)` (mode ∈ `entities`|`properties`|`quantities`|`spatial`). All in-repo
  callers (viewer GLB / command-palette / mobile / location-map / main-toolbar CSV exports, LOD1
  generator) are migrated; the Rust CSV gained the spatial-hierarchy mode to match.

### Patch Changes

- Updated dependencies [[`fec82b9`](https://github.com/LTplus-AG/ifc-lite/commit/fec82b9f3eea3655f92413fce82387ddce2f9722), [`0a0a922`](https://github.com/LTplus-AG/ifc-lite/commit/0a0a922adba1dabc56e97cc5ce0c553ab7356b3e)]:
  - @ifc-lite/geometry@2.9.0
  - @ifc-lite/wasm@2.11.0
  - @ifc-lite/mcp@0.4.0
  - @ifc-lite/export@2.0.0
  - @ifc-lite/sdk@1.20.1

## 0.12.0

### Minor Changes

- [#1235](https://github.com/LTplus-AG/ifc-lite/pull/1235) [`1693b95`](https://github.com/LTplus-AG/ifc-lite/commit/1693b9593a07791439a6577bed5046d22fd21384) Thanks [@louistrue](https://github.com/louistrue)! - Add HBJSON (Honeybee / Ladybug Tools energy & daylight model) export.

  `ifc-lite export <file.ifc> --format hbjson` and `GeometryProcessor.exportHbjson(buffer, name)`
  produce a Honeybee-valid model: `IfcSpace` volumes become watertight, planar-faced Rooms
  (Floor / RoofCeiling / Wall) ready to load via `Model.from_hbjson` and run in Ladybug Tools /
  Pollination. `IfcWindow` and `IfcDoor` occurrences are placed as coplanar Apertures and Doors
  on the matching exterior walls. Rooms and openings are built analytically from extruded-area
  profiles (not the render mesh), so they are watertight by construction and wasm-safe.
  `IfcRailing` occurrences are emitted as shading `ShadeMesh` geometry, and `IfcMaterialLayerSet`
  build-ups become Honeybee opaque constructions (real layer names + thicknesses; thermal
  properties defaulted by material-name keyword, since IFC rarely carries them) assigned by face
  type. Shared interior walls are paired as `Surface` adjacencies so multi-zone energy models
  don't lose heat to ambient. Backed by a new pure-Rust `ifc-lite-export` crate (source of truth
  for CLI / SDK / wasm). Available in the viewer's export menu as "Export HBJSON (Energy Model)",
  on the CLI as `export --format hbjson`, and via the SDK as `bim.export.hbjson()` (delegated to a
  geometry-capable backend; the data-only SDK stays wasm-free).

### Patch Changes

- Updated dependencies [[`b6acbc4`](https://github.com/LTplus-AG/ifc-lite/commit/b6acbc4b84bcdb4a2d774515200d27edd7e831cb), [`1693b95`](https://github.com/LTplus-AG/ifc-lite/commit/1693b9593a07791439a6577bed5046d22fd21384)]:
  - @ifc-lite/mutations@1.16.0
  - @ifc-lite/export@1.21.0
  - @ifc-lite/data@2.2.0
  - @ifc-lite/geometry@2.8.0
  - @ifc-lite/sdk@1.20.0
  - @ifc-lite/wasm@2.10.0
  - @ifc-lite/ids@1.15.15

## 0.11.3

### Patch Changes

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Dead-code and dependency hygiene: remove unused internal barrels/shims (clash engine-ts re-exports, collab doc barrel, sdk transport/types) and drop unused dependencies (renderer/cli: @ifc-lite/wasm; cli/mcp: @ifc-lite/encoding; mcp: @types/node out of runtime dependencies; collab: ws devDeps; data: @types/proj4). No public API changes.

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`da1999f`](https://github.com/LTplus-AG/ifc-lite/commit/da1999fc6e482fa3d668b9aa98a840d2bb838112)]:
  - @ifc-lite/create@1.16.2
  - @ifc-lite/export@1.19.6
  - @ifc-lite/parser@3.2.0
  - @ifc-lite/geometry@2.6.1
  - @ifc-lite/clash@1.1.3
  - @ifc-lite/sdk@1.18.3
  - @ifc-lite/mcp@0.3.3
  - @ifc-lite/data@2.0.3
  - @ifc-lite/ids@1.15.10

## 0.11.2

### Patch Changes

- [#1055](https://github.com/LTplus-AG/ifc-lite/pull/1055) [`594b90c`](https://github.com/LTplus-AG/ifc-lite/commit/594b90c99cf5e2bc40735232e0b02691be7b2ed1) Thanks [@louistrue](https://github.com/louistrue)! - fix(ids): make IDS validation usable on large models with code-list IDS packs.

  Validating a 550k-entity model against an 848-spec IDS document took ~19
  minutes of CPU, produced multi-GB reports, and the CLI then hung forever
  after printing its results. Four root fixes:

  - parser: `yieldToEventLoop` leaked one open `MessageChannel` per yield;
    in Node an open `MessagePort` holds a libuv handle, so every CLI command
    on a large file kept the process alive after completion. Ports now close
    (helper consolidated into one shared module).
  - ids: `validateIDS` wraps the accessor in a per-run memoizing cache so
    property sets / types / attributes are extracted once per entity instead
    of once per entity _per specification_ (O(specs×entities) source
    re-parses → O(entities)). Enumeration constraints additionally compile
    into exact-match sets (real-world code lists carry 800+ values).
  - ids: per-entity result strings are now bounded — enumeration constraints
    render at most 10 values in failure messages, and the entity-independent
    requirement description is formatted once per requirement instead of per
    entity result (reports for failing models dropped from GBs to MBs).
  - cli: `ifc-lite ids` now uses the canonical `@ifc-lite/ids/bridge`
    accessor (the drifted local copy missed type-inherited property sets),
    reports real progress (`spec 312/848 (37%)` instead of
    `undefined (undefined/undefined)`), and skips retaining passing entity
    results for human-readable output (`--json` is unchanged).

  Behavior change (intentional): the CLI's PASS/FAIL verdict and exit code
  now come from the validator's per-spec status, which counts
  cardinality-only failures — a `minOccurs="1"` specification that matches
  zero entities now correctly FAILs (exit 1) where it previously passed
  silently. `bim.ids.summarize` likewise prefers the per-spec status when
  the report carries one, so `--json` and text mode agree on the verdict.

  Measured on the same model + IDS pack: 848 specs 19min→2min, 117 specs
  3.4min→12s, both with a clean exit instead of a hang.

- Updated dependencies [[`594b90c`](https://github.com/LTplus-AG/ifc-lite/commit/594b90c99cf5e2bc40735232e0b02691be7b2ed1)]:
  - @ifc-lite/parser@3.1.3
  - @ifc-lite/ids@1.15.8
  - @ifc-lite/sdk@1.18.2

## 0.11.1

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc), [`8d5bd67`](https://github.com/LTplus-AG/ifc-lite/commit/8d5bd6701dc9962c2de5e42a7462008b2b8c2885)]:
  - @ifc-lite/bcf@1.15.6
  - @ifc-lite/clash@1.1.2
  - @ifc-lite/create@1.16.1
  - @ifc-lite/data@2.0.2
  - @ifc-lite/encoding@1.14.7
  - @ifc-lite/export@1.19.5
  - @ifc-lite/extensions@0.3.2
  - @ifc-lite/geometry@2.4.1
  - @ifc-lite/ids@1.15.6
  - @ifc-lite/mcp@0.3.2
  - @ifc-lite/mutations@1.15.3
  - @ifc-lite/parser@3.1.1
  - @ifc-lite/query@1.14.10
  - @ifc-lite/sandbox@1.15.2
  - @ifc-lite/sdk@1.18.1
  - @ifc-lite/viewer-core@0.2.6
  - @ifc-lite/wasm@2.5.1

## 0.11.0

### Minor Changes

- [#1022](https://github.com/LTplus-AG/ifc-lite/pull/1022) [`7bd0459`](https://github.com/LTplus-AG/ifc-lite/commit/7bd045963b1339a35bd73d1aad18ff29de7db692) Thanks [@louistrue](https://github.com/louistrue)! - feat(spaces): interactive Space Sketch (DCEL) editor + headless generation

  A topology-aware space editor built on a persistent half-edge (DCEL) plate in
  the Rust geometry core, exposed via a stateful `SpacePlateHandle` wasm binding:

  - **Derive** rooms from a storey's walls, **drag** a shared vertex (both rooms
    follow), **split** a room between corners _or_ new nodes added anywhere on a
    wall, **merge** rooms across a shared wall, with undo/redo, and **bake** to
    real `IfcSpace` (via the existing `addSpace` path).
  - **Wall-axis recognition fixes** in `@ifc-lite/create`: read the extractor's
    reliable entity type instead of the columnar table's `'Unknown'` sentinel
    (every `Curve2D` Axis polyline — e.g. all of AC20-FZK-Haus — was skipped), and
    a body-footprint fallback (face sets, `IfcFacetedBrep`, vertically-extruded
    rect / arbitrary / IndexedPolyCurve profiles) for walls without an Axis.
  - Viewer "Space Sketch" tool: storey list with resolved names, auto-derive on
    selection, auto-escalating + manual snap tolerance to close centreline corner
    gaps.
  - **Headless generation** — derive IfcSpace across storeys from the CLI
    (`ifc-lite generate-spaces`), the SDK (`bim.spaces.generate`), or as a library
    function (`generateSpaces` from `@ifc-lite/create`), with auto-escalating snap,
    storey-datum ("slab") floor-to-floor heights, and rectangular corner cleanup
    ported into the TS detector.
  - **Production-grade baked spaces** — every derived `IfcSpace` now carries
    `Qto_SpaceBaseQuantities` (GrossFloorArea / NetFloorArea / GrossPerimeter /
    Height / GrossVolume, schema-aware) and an `IfcRelSpaceBoundary` per bounding
    wall. Generated spaces are stamped with `ObjectType 'IfcLite:GeneratedSpace'`,
    and a re-run skips a model that already contains them (idempotent; `--force`
    to override).

### Patch Changes

- Updated dependencies [[`cef9989`](https://github.com/LTplus-AG/ifc-lite/commit/cef99897ee287029c6db6bbaafcd2a35508af1be), [`7bd0459`](https://github.com/LTplus-AG/ifc-lite/commit/7bd045963b1339a35bd73d1aad18ff29de7db692)]:
  - @ifc-lite/create@1.16.0
  - @ifc-lite/wasm@2.5.0
  - @ifc-lite/sdk@1.18.0

## 0.10.1

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

- Updated dependencies [[`b33e1f7`](https://github.com/LTplus-AG/ifc-lite/commit/b33e1f7c4706fe4b0d850d3da782ea84267dd525), [`55fd14e`](https://github.com/LTplus-AG/ifc-lite/commit/55fd14e5017f626567b10622bb41ddac3311e70c), [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0), [`ca293ed`](https://github.com/LTplus-AG/ifc-lite/commit/ca293ed7080495b29dd555b191ae0095ff267e4b), [`90060b7`](https://github.com/LTplus-AG/ifc-lite/commit/90060b7eaad7a07bdab13907c1b52bb24fbc8597)]:
  - @ifc-lite/parser@3.1.0
  - @ifc-lite/geometry@2.3.0
  - @ifc-lite/query@1.14.9
  - @ifc-lite/mutations@1.15.2
  - @ifc-lite/export@1.19.4
  - @ifc-lite/viewer-core@0.2.5
  - @ifc-lite/mcp@0.3.1
  - @ifc-lite/data@2.0.1
  - @ifc-lite/sdk@1.17.1
  - @ifc-lite/clash@1.1.1
  - @ifc-lite/bcf@1.15.5
  - @ifc-lite/sandbox@1.15.1
  - @ifc-lite/extensions@0.3.1
  - @ifc-lite/wasm@2.3.0
  - @ifc-lite/ids@1.15.5

## 0.10.0

### Minor Changes

- [#891](https://github.com/LTplus-AG/ifc-lite/pull/891) [`d6b8986`](https://github.com/LTplus-AG/ifc-lite/commit/d6b89866b4c058531ce0c5c7472a297adc6580a8) Thanks [@louistrue](https://github.com/louistrue)! - Add representation-agnostic clash detection.

  `@ifc-lite/clash` is a new package: a source-agnostic clash core (STEP/IFCX
  adapters, BVH broad phase, exact triangle-intersection narrow phase, hard /
  clearance / touch classification) with a pluggable TS reference kernel and a
  Rust/WASM kernel kept in lockstep by a differential test. Results group into a
  _manageable_ set of BCF topics (deterministic topic GUIDs, caps-with-transparency,
  framing viewpoints, A/B coloring, optional snapshots) and round-trip status back.

  Surfaced through the existing tools:

  - `@ifc-lite/clash` — `rulesFromPresets(presets, mode, clearance?, reportTouch?)` builds
    runnable rules from any preset list (the discipline matrix is this over the built-ins),
    so hosts can run a user-curated rule set.
  - `@ifc-lite/viewer` — an interactive clash panel (run detection / discipline matrix /
    presets, A/B highlight + camera framing, configurable settings & custom rules, a
    controllable BCF export with optional rendered snapshots).
  - `@ifc-lite/sdk` — a `clash` namespace (`run`, `matrix`, `group`, presets).
  - `@ifc-lite/cli` — `ifc-lite clash <file>` with `--a/--b`, `--mode`, `--matrix`,
    `--clearance`, `--bcf`.
  - `@ifc-lite/mcp` — `clash_check` (omit selectors for a whole-model self-clash)
    and `clash_matrix`.

  The discipline matrix now threads a `clearance` value onto its rules, so
  `--matrix --mode clearance --clearance N` (and the SDK/MCP equivalents) report
  violations instead of silently dropping the override.

### Patch Changes

- Updated dependencies [[`d6b8986`](https://github.com/LTplus-AG/ifc-lite/commit/d6b89866b4c058531ce0c5c7472a297adc6580a8), [`94d9116`](https://github.com/LTplus-AG/ifc-lite/commit/94d91161abc58b5804bd979d841d7475714ee5ad)]:
  - @ifc-lite/clash@1.1.0
  - @ifc-lite/sdk@1.17.0
  - @ifc-lite/mcp@0.3.0
  - @ifc-lite/wasm@2.1.1

## 0.9.1

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85), [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/parser@3.0.0
  - @ifc-lite/export@1.19.3
  - @ifc-lite/wasm@2.0.0
  - @ifc-lite/data@2.0.0
  - @ifc-lite/extensions@0.3.0
  - @ifc-lite/create@1.15.1
  - @ifc-lite/ids@1.15.4
  - @ifc-lite/mcp@0.2.1
  - @ifc-lite/query@1.14.8
  - @ifc-lite/sdk@1.16.1
  - @ifc-lite/viewer-core@0.2.4
  - @ifc-lite/mutations@1.15.1

## 0.9.0

### Minor Changes

- [#690](https://github.com/LTplus-AG/ifc-lite/pull/690) [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d) Thanks [@louistrue](https://github.com/louistrue)! - Introduce `@ifc-lite/extensions` package and the `ifc-lite ext` CLI
  subcommand — the Phase 0 foundation of the user-customization /
  AI-authored-extensions system designed in
  `docs/architecture/ai-customization/`.

  The package exposes:

  - **Manifest validator** — hand-rolled, dependency-free; produces
    structured `{ path, code, hint }` errors for use by the future
    AI repair loop.
  - **Capability grammar** — parser, matcher, OCAP catalogue, risk
    classifier, and set-diff for re-consent flows.
  - **`when` clause language** — parser + evaluator for the slot
    visibility expressions used by host UI.
  - **`SlotRegistry`** — in-memory pub/sub for contribution points;
    the substrate for Phase 1's host UI bindings.
  - **Bundle loader and `.iflx` pack/unpack** — directory and gzipped
    JSON envelope variants, deterministic round-trip.

  The CLI adds `ifc-lite ext validate <path>` (returns structured JSON
  with `--json`) and `ifc-lite ext init <dir>` (scaffolds a minimal
  valid bundle).

  No host integration yet. UI loader, runtime activation, sandbox
  wiring, audit log, AI authoring, flavors, and self-improvement loops
  arrive in subsequent phases.

- [#690](https://github.com/LTplus-AG/ifc-lite/pull/690) [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d) Thanks [@louistrue](https://github.com/louistrue)! - Phase 5 prototype — Ed25519 signing for extension bundles.

  The hosted registry is gated on a decision criterion (50 flavors / 10
  authors before opening), but the cryptographic kernel ships today so
  the design isn't abstract and authors can sign bundles before any
  registry exists.

  New design doc:
  `docs/architecture/ai-customization/10-registry-and-signing.md` —
  distribution threat model, signing scheme, key management, signed
  envelope shape, verification flow, registry architecture sketch,
  trust UX (TOFU), revocation, phase 5 build plan, non-goals, open
  questions.

  New `@ifc-lite/extensions/signing` module:

  - **Keys** — `generateKeyPair`, `exportPublicKey`, `exportPrivateKey`,
    `importPublicKey`, `importPrivateKey`, `fingerprintFromBytes`.
    Uses WebCrypto Ed25519 (Node ≥ 18.17, modern browsers). Keys
    serialise as `.iflk` JSON files with format/version/algorithm
    discriminator. Fingerprints are colon-separated SHA-256 of the
    raw 32-byte public key.
  - **Canonical hashing** — `canonicalContentHash` produces a
    deterministic SHA-256 over the bundle's file map. Insertion-order-
    independent; uses ASCII unit/record separators between
    path/bytes/record to make segment boundaries unambiguous.
  - **Sign / verify** — `signBundle` produces a `SignatureBlock`
    committed to the canonical hash. `verifyBundle` recomputes, checks
    format, imports key, runs `crypto.subtle.verify`. Throws
    `SignatureMismatchError` on any failure;
    `SignatureFormatError` for envelope-shape problems;
    `KeyFormatError` for malformed key files.

  `.iflx` envelope extension:

  - Optional `signature` field on pack / unpack.
  - `packBundle(bundle, signature?)` accepts a signature argument.
  - New `unpackBundleWithSignature(bytes)` returns
    `{ bundle, signature? }` so callers (loader, CLI) can verify and
    display the signer fingerprint.
  - Existing `unpackBundle` continues to work — signed bundles unpack
    fine, the signature is silently ignored. Backward-compatible.

  New CLI subcommands under `ifc-lite ext`:

  - `keygen --out <prefix> [--label <name>]` — Ed25519 keypair, writes
    `.public.iflk` and `.private.iflk`. Best-effort POSIX 0600 on the
    private file.
  - `pack <bundle-dir> [--out <bundle.iflx>] [--sign --key <private.iflk>]`
    — pack a bundle directory into `.iflx`, optionally signed.
  - `sign <bundle> --key <private.iflk> [--out <bundle.iflx>]` —
    attach a signature to an existing bundle (directory or unsigned
    `.iflx`).
  - `verify <bundle.iflx> [--key <public.iflk>] [--json]` — inspect
    a `.iflx`, optionally checking the signer matches an expected
    public key. JSON mode emits a structured envelope.

  Package-side housekeeping:

  - `packages/extensions/tsconfig.json`: added `"DOM"` to `lib` so
    WebCrypto types (`CryptoKey`, `CryptoKeyPair`) are available. Was
    already implicitly required for `crypto.subtle` calls in
    `storage/hash.ts`.
  - Top-level barrel exports the new signing surface.

  Tests: 333 (up from 307 / +26). New coverage: keypair generation
  identity, public/private key file round-trip, canonical hash
  determinism and order-independence, sign+verify happy path,
  content tamper detection, contentHash tamper, substituted public
  key, algorithm/format error paths, signed `.iflx` envelope
  round-trip, tamper detection through the pack→unpack→verify chain.
  Smoke-tested end-to-end against the canonical `good` bundle
  fixture.

  Plan tracked in `09-implementation-plan.md` — P5.T2 closed,
  P5.T1/T3-T8 remain gated on the registry decision.

### Patch Changes

- Updated dependencies [[`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`f209e34`](https://github.com/LTplus-AG/ifc-lite/commit/f209e342c306041ea045bc108595676efa671eec)]:
  - @ifc-lite/extensions@0.2.0
  - @ifc-lite/wasm@1.19.0

## 0.8.0

### Minor Changes

- [#615](https://github.com/louistrue/ifc-lite/pull/615) [`7a7cf79`](https://github.com/louistrue/ifc-lite/commit/7a7cf79c181004f9974bd303181aeeaa97d6869d) Thanks [@louistrue](https://github.com/louistrue)! - Add `@ifc-lite/mcp` — Model Context Protocol server for ifc-lite, exposing
  the BIM runtime to any MCP-aware LLM agent (Claude Desktop, Cursor,
  ChatGPT, Goose, Windsurf, Zed, custom). v0.1 ships with stdio + Streamable
  HTTP transports, scope-gated tool surface across discovery / query /
  geometry / validation (IDS + audit) / mutation / BCF / bSDD / diff /
  export / viewer, an `ifc-lite://` resource scheme, eleven pre-baked
  prompt templates, and an `ifc-lite mcp` CLI subcommand.

  The 3D viewer is a first-class workflow:
  • `viewer_open` boots the WebGL viewer in-process and swaps streaming
  adapters into the headless backend so every `bim.viewer.*` /
  `bim.visibility.*` call drives the live scene.
  • `viewer_colorize`, `viewer_isolate`, `viewer_fly_to`,
  `viewer_color_by_property`, `viewer_set_section` make agent-driven
  visualization a single tool call.
  • User picks in the browser flow back to MCP via SSE and surface as
  `notifications/resources/updated` on `ifc-lite://viewer/selection`.
  `viewer_get_selection` reads the latest pick; `viewer_wait_for_selection`
  blocks until the next click.
  • `viewer_ask` emits agent-friendly wording so the agent can request
  user permission before opening a browser tab.
  • CLI flags `--viewer`, `--viewer-port`, and `--open` automate startup.

### Patch Changes

- Updated dependencies [[`7a7cf79`](https://github.com/louistrue/ifc-lite/commit/7a7cf79c181004f9974bd303181aeeaa97d6869d), [`7a7cf79`](https://github.com/louistrue/ifc-lite/commit/7a7cf79c181004f9974bd303181aeeaa97d6869d)]:
  - @ifc-lite/ids@1.14.11
  - @ifc-lite/mcp@0.2.0

## 0.7.0

### Minor Changes

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Add the `bim.store.*` namespace — high-level editing of an already-parsed
  `IfcDataStore` via the existing mutation overlay. Closes the merge-roundtrip
  gap from #592 (you can edit `IfcRectangleProfileDef.XDim` or drop a fresh
  `IfcColumn` into a model without round-tripping through a script + re-parse).

  **`@ifc-lite/mutations`** — new `StoreEditor` facade plus four
  `MutablePropertyView` extensions: positional-attribute mutations, overlay
  entity creation/deletion (with watermark seeding), and three helpers used by
  the viewer's undo/redo (`removePositionalMutation`, `restoreFromTombstone`,
  `restoreNewEntity`).

  **`@ifc-lite/create`** — new `in-store/` module: `addColumnToStore` builds a
  12-entity IfcColumn sub-graph (placement, profile, extruded solid,
  representation, product shape, rel-contained-in-spatial-structure) anchored
  to a target `IfcBuildingStorey`. `resolveSpatialAnchor` walks the parsed
  store to find the IfcOwnerHistory, the 'Body' representation context, and
  the storey's local placement.

  **`@ifc-lite/sdk`** — new `StoreNamespace` exposed as `bim.store` on
  `BimContext`. Methods: `addEntity`, `removeEntity`, `setPositionalAttribute`,
  `addColumn`. Backed by `StoreBackendMethods` on `BimBackend`; the
  `RemoteBackend` proxy round-trips them through the transport.

  **`@ifc-lite/sandbox`** — `bim.store.*` is bridged into the QuickJS sandbox
  with full TypeScript types via `bim-globals.d.ts` and an LLM cheat sheet in
  the system prompt. Gated on a new `store: true` permission (default
  `false`, mirrors the existing `mutate` permission pattern).

  **`@ifc-lite/cli`** — `HeadlessBackend.store` is now functional (was a
  no-op before). Scripts run via the CLI can edit a parsed model and export it
  with mutations applied.

  **`@ifc-lite/viewer`** — three new UI surfaces:

  - Raw STEP tab in `PropertiesPanel` — lists every positional STEP argument
    with an inline pen-icon editor for scalar values (numbers, refs, enums,
    null). Mutated rows show a purple dot and tinted background.
  - `EntityContextMenu` gains "Delete entity" (red, calls `removeEntity`
    with toast + undo support) and "Add column here…" (emerald, only enabled
    when the right-clicked entity is an `IfcBuildingStorey`).
  - `AddColumnDialog` modal — storey picker sorted by elevation, position
    (storey-local metres), cross-section, height, name, optional collapsible
    for Description/ObjectType/Tag. Anchor-resolution failures surface
    inline, not as thrown exceptions.

  Plus four new actions on `mutationSlice` (`setPositionalAttribute`,
  `removeEntity`, `addColumn`, dialog open/close) backed by per-model
  `StoreEditor` caches, with undo/redo wired for `UPDATE_POSITIONAL_ATTRIBUTE`,
  `CREATE_ENTITY`, and `DELETE_ENTITY`.

  **`@ifc-lite/parser`** — `package.json` `exports` re-ordered to put `types`
  before `import` so downstream consumers using TS5 `nodenext` resolution
  pick up the type declarations.

  **`@ifc-lite/geometry`** — re-exports `MetadataBootstrapEntitySummary` and
  `MetadataBootstrapSpatialNode` from the package index (used by viewer
  desktop services).

  **`@ifc-lite/renderer`** — `GPUBufferDescriptor` ambient declaration gains
  `mappedAtCreation?: boolean`. Internal change; the renderer was already
  using it at runtime to skip a Mojo IPC round-trip on Chrome/Dawn.

- [#576](https://github.com/louistrue/ifc-lite/pull/576) [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742) Thanks [@louistrue](https://github.com/louistrue)! - Add IFC scheduling entity support across the scripting SDK, LLM assistant, and
  CLI headless backend.

  **Create API** — `IfcCreator` gains `addIfcWorkSchedule`, `addIfcWorkPlan`,
  `addIfcTask` (with inline `IfcTaskTime`), `addIfcRelSequence` (with
  `IfcLagTime`), `assignTasksToWorkSchedule` (`IfcRelAssignsToControl`),
  `assignProductsToTask` (`IfcRelAssignsToProcess`), and `nestTasks`
  (`IfcRelNests`).

  **SDK** — new `bim.schedule` read namespace (`data()`, `tasks()`,
  `workSchedules()`, `sequences()`) backed by the parser's
  `extractScheduleOnDemand`. New `ScheduleBackendMethods` is now part of
  `BimBackend`; the viewer's `LocalBackend`, the `RemoteBackend` proxy, and the
  CLI `HeadlessBackend` all implement it.

  **Sandbox** — new `bim.schedule.*` QuickJS namespace plus schedule methods on
  `bim.create.*`, all carrying LLM semantic contracts so the auto-generated
  system prompt teaches the assistant when to use them. Autocomplete types
  (`bim-globals.d.ts`) regenerated.

### Patch Changes

- Updated dependencies [[`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`16d7a63`](https://github.com/louistrue/ifc-lite/commit/16d7a6361a78bb39a2bd61bba6990db5d3df0c04), [`945bb30`](https://github.com/louistrue/ifc-lite/commit/945bb30061ca044f4a51001f7299c17350ce99cf), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`18c6a37`](https://github.com/louistrue/ifc-lite/commit/18c6a37f1cc1426daa32ee60457dd0580a5257f5)]:
  - @ifc-lite/create@1.15.0
  - @ifc-lite/mutations@1.15.0
  - @ifc-lite/sdk@1.15.0
  - @ifc-lite/sandbox@1.15.0
  - @ifc-lite/parser@2.2.0
  - @ifc-lite/query@1.14.7
  - @ifc-lite/wasm@1.16.7
  - @ifc-lite/export@1.18.0

## 0.6.2

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`7a1aeb7`](https://github.com/louistrue/ifc-lite/commit/7a1aeb7fabdb4b9692d02186fe4254fc561bece4), [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/wasm@1.16.1
  - @ifc-lite/bcf@1.15.2
  - @ifc-lite/create@1.14.5
  - @ifc-lite/data@1.15.1
  - @ifc-lite/encoding@1.14.6
  - @ifc-lite/export@1.17.2
  - @ifc-lite/ids@1.14.9
  - @ifc-lite/mutations@1.14.5
  - @ifc-lite/parser@2.1.6
  - @ifc-lite/query@1.14.6
  - @ifc-lite/sandbox@1.14.5
  - @ifc-lite/sdk@1.14.6
  - @ifc-lite/viewer-core@0.2.3

## 0.6.1

### Patch Changes

- [#461](https://github.com/louistrue/ifc-lite/pull/461) [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7) Thanks [@louistrue](https://github.com/louistrue)! - Clean up package build health for georeferencing work by fixing parser generation issues, making export tests resolve workspace packages reliably, removing build scripts that masked TypeScript failures, tightening workspace test/build scripts, productizing CLI LOD generation, centralizing IFC GUID utilities in encoding, and adding mutation test coverage for property editing flows.

- Updated dependencies [[`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7), [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7)]:
  - @ifc-lite/data@1.15.0
  - @ifc-lite/export@1.17.1
  - @ifc-lite/parser@2.1.5
  - @ifc-lite/query@1.14.5
  - @ifc-lite/encoding@1.14.5
  - @ifc-lite/bcf@1.15.1
  - @ifc-lite/mutations@1.14.4
  - @ifc-lite/ids@1.14.8

## 0.6.0

### Minor Changes

- [#388](https://github.com/louistrue/ifc-lite/pull/388) [`30e4f04`](https://github.com/louistrue/ifc-lite/commit/30e4f048dba5e615f44d3d358cdec56dfc83eb14) Thanks [@louistrue](https://github.com/louistrue)! - Add 3D viewer package and CLI `view`/`analyze` commands for interactive browser-based model visualization with REST API

### Patch Changes

- [#382](https://github.com/louistrue/ifc-lite/pull/382) [`55a8227`](https://github.com/louistrue/ifc-lite/commit/55a82272390ae9b89d90f121c984c24fe9bd8a73) Thanks [@louistrue](https://github.com/louistrue)! - Fix GlobalId uniqueness validation to only check entity types that inherit from IfcRoot, using the schema registry dynamically instead of scanning all entities

- Updated dependencies [[`30e4f04`](https://github.com/louistrue/ifc-lite/commit/30e4f048dba5e615f44d3d358cdec56dfc83eb14)]:
  - @ifc-lite/viewer-core@0.2.0

## 0.5.1

### Patch Changes

- [#380](https://github.com/louistrue/ifc-lite/pull/380) [`7fb3572`](https://github.com/louistrue/ifc-lite/commit/7fb3572fe3d3eb8076fca19e26a324c66bd819de) Thanks [@louistrue](https://github.com/louistrue)! - Fix 10 bugs from v0.5.0 test report

  **@ifc-lite/cli:**

  - fix(eval): `--type` and `--limit` flags no longer parsed as part of the expression
  - fix(mutate): support multiple `--set` flags and entity attribute mutation (`--set Name=TestWall`)
  - fix(mutate): restrict ObjectType writes to entities that actually define that attribute
  - fix(ask): exterior wall recipe falls back to all walls with caveat when IsExternal property is missing
  - fix(ask): WWR calculation uses exterior wall area per ISO 13790, falls back only when IsExternal data is truly missing
  - fix(ask): generic count recipe matches any type name (`how many piles` → IfcPile)
  - fix(ask): add largest/smallest element ranking recipes
  - fix(stats): add IfcPile and IfcRamp to element breakdown
  - fix(query): warn when group-by aggregation yields all zeros (missing quantity data)

  **@ifc-lite/create:**

  - fix: generate unique GlobalIds using crypto-strong randomness (Web Crypto API) with per-instance deduplication

- Updated dependencies [[`7fb3572`](https://github.com/louistrue/ifc-lite/commit/7fb3572fe3d3eb8076fca19e26a324c66bd819de)]:
  - @ifc-lite/create@1.14.4

## 0.5.0

### Minor Changes

- [#376](https://github.com/louistrue/ifc-lite/pull/376) [`7d3843b`](https://github.com/louistrue/ifc-lite/commit/7d3843b3e94e2d6e24863cc387469df722d48428) Thanks [@louistrue](https://github.com/louistrue)! - Comprehensive CLI bug fixes and new features:

  **Bug fixes:**

  - `--version` now reads from package.json (was hardcoded "0.2.0")
  - `eval --type`/`--limit` flags no longer concatenated into expression string
  - `--where` filter now searches both property sets and quantity sets for numeric filtering
  - `export --storey` properly filters entities by storey (was silently ignored)
  - Quantities available as export columns (e.g. `--columns Name,GrossSideArea`)
  - `--unique material`, `--unique storey`, `--unique type` now supported
  - `--avg`, `--min`, `--max` aggregation flags produce actual computed results
  - `eval --json` wraps output in a JSON envelope
  - `--type Wall` auto-prefixes to `IfcWall` with a note
  - `--sum` with non-existent quantity shows helpful error and suggestions
  - `--group-by` validates keys and errors on invalid options
  - `--limit` with `--group-by` now limits groups, not entities

  **New features:**

  - `stats` command: one-command building KPIs and health check (exterior wall area, GFA, material volumes)
  - `mutate` command: modify properties via CLI with `--set` and `--out`
  - `ask` command: natural language BIM queries with 15+ built-in recipes
  - `--sort`/`--desc` flags for sorting query results by quantity values
  - `--group-by` now works with `--avg`, `--min`, `--max` (not just `--sum`)

## 0.4.0

### Minor Changes

- [#374](https://github.com/louistrue/ifc-lite/pull/374) [`e20157b`](https://github.com/louistrue/ifc-lite/commit/e20157bd8c0a61e3ec99ea8bae963fba4862517c) Thanks [@louistrue](https://github.com/louistrue)! - ### CLI

  **Bug fixes:**

  - `export --where` now filters entities (was silently ignored)
  - `--group-by storey` resolves actual storey names via spatial containment instead of showing "(no storey)"

  **New flags:**

  - `--property-names`: discover available properties per entity type (parallel to `--quantity-names`)
  - `--unique PsetName.PropName`: show distinct values and counts for a property
  - `--group-by` + `--sum` combo: aggregate quantity per group (e.g. `--group-by material --sum GrossVolume`)

  **UX improvements:**

  - `info` command splits entity types into "Building elements" and "Other types" sections

  ### SDK

  - `bim.quantity(ref, name)` 2-arg shorthand now searches all quantity sets (previously required 3-arg form with explicit qset name)

### Patch Changes

- Updated dependencies [[`e20157b`](https://github.com/louistrue/ifc-lite/commit/e20157bd8c0a61e3ec99ea8bae963fba4862517c)]:
  - @ifc-lite/sdk@1.14.5

## 0.3.0

### Minor Changes

- [#372](https://github.com/louistrue/ifc-lite/pull/372) [`d2ebb34`](https://github.com/louistrue/ifc-lite/commit/d2ebb3457e261934df41c8f7f647531de6198078) Thanks [@louistrue](https://github.com/louistrue)! - Fix multiple CLI bugs and add new query features:

  **Bug fixes:**

  - **info/diff**: Resolve "Unknown" entity type spam by using IFC_ENTITY_NAMES map for UPPERCASE→PascalCase conversion
  - **loader**: Reject non-IFC files (missing ISO-10303-21 header) and empty files with clear error messages
  - **props**: Return proper error for nonexistent entity IDs instead of empty JSON structure
  - **bcf list**: Fix empty topics by adding Map serialization support to JSON output
  - **query --where**: Fix boolean property matching (IsExternal=true now works); error on malformed syntax instead of silently returning all results
  - **query --relationships**: Add structural relationship types (VoidsElement, FillsElement, ConnectsPathElements, AssignsToGroup, etc.) to parser; handle 1-to-1 relationships
  - **query --spatial**: Fall back to IfcBuilding containment when no IfcBuildingStorey exists
  - **eval**: Support const/let/var and multi-statement expressions (auto-wraps in async IIFE)
  - **model.active().schema**: Add `schema` alias so scripts can access schema version

  **New features:**

  - **query --where operators**: Support `!=`, `>`, `<`, `>=`, `<=`, `~` (contains) in addition to `=`
  - **query --sum**: Aggregate a quantity across matched entities with disambiguation warnings when similar quantities exist (e.g., `--sum GrossSideArea`)
  - **query --storey**: Filter entities by storey name (e.g., `--storey Erdgeschoss`)
  - **query --quantity-names**: List all available quantities per entity type with qset context, sample values, and ambiguity warnings — critical for LLM-driven quantity analysis
  - **query --group-by**: Pivot table grouped by type, material, or any property (e.g., `--group-by material`)
  - **query --spatial --summary**: Show element type counts per storey instead of listing every element
  - **eval**: Auto-return last expression value in multi-statement mode (no explicit `return` needed)
  - **validate**: Check quantity completeness — warns when building elements lack quantity sets
  - **--version**: Show version number in help output

### Patch Changes

- Updated dependencies [[`d2ebb34`](https://github.com/louistrue/ifc-lite/commit/d2ebb3457e261934df41c8f7f647531de6198078)]:
  - @ifc-lite/data@1.14.4
  - @ifc-lite/parser@2.1.2
  - @ifc-lite/ids@1.14.5

## 0.2.0

### Minor Changes

- [#364](https://github.com/louistrue/ifc-lite/pull/364) [`385a3a6`](https://github.com/louistrue/ifc-lite/commit/385a3a62f71f379e13a2de0c3e6c9c4208b9de14) Thanks [@louistrue](https://github.com/louistrue)! - Add @ifc-lite/cli — BIM toolkit for the terminal. Query, validate, export, create, and script IFC files from the command line. Designed for both humans and LLM terminals (Claude Code, Cursor, etc.). Includes headless BimBackend, 10 commands (info, query, props, export, ids, bcf, create, eval, run, schema), JSON output mode, and pipe-friendly design.

### Patch Changes

- Updated dependencies [[`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8)]:
  - @ifc-lite/parser@2.1.1
  - @ifc-lite/export@1.15.1
