# Mesh-output determinism

The pipeline-level determinism contract for emitted geometry, enforced by a
pinned manifest. It complements the kernel's predicate sign manifest
(`rust/geometry/src/kernel/manifest.rs`), which pins exact-predicate SIGNS;
this contract pins the actual bytes the pipeline emits.

## What is byte-stable

Running `process_geometry` over the synthetic fixture in
`ifc_lite_processing::determinism` produces, bit-for-bit:

- Per mesh, in emit order: `express_id`, `geometry_class`, position f32 bits,
  normal f32 bits, triangle indices, and the per-element f64 `origin`. These are
  hashed into THREE separate per-mesh fields so the cross-target guard can hold
  each to a different standard: `positions_hash` (positions) and
  `indices_origin_hash` (identity + topology + placement) are byte-identical on
  every target for every mesh, with no exemption; `normals_hash` is the only
  surface allowed the documented trig gap, and only for the curved mesh. This is
  what makes the "positions are byte-identical cross-target, even for the round
  column" claim below a test-enforced invariant rather than prose.
  Emit order itself is part of the contract: entity jobs are processed in file
  scan order and rayon's ordered collect preserves it, so the mesh list is
  identical regardless of thread count (verified with `RAYON_NUM_THREADS=1`).
- The three flat prepass wire arrays, which are an EXPLICIT sorted contract
  since this change (previously an implicit FxHashMap-iteration artifact):
  - `flat_voids` `(keys, counts, values)` sorted by host id, u32 ascending
    (`rust/processing/src/prepass.rs`);
  - `flat_material_colors` `(ids, counts, rgba8)` sorted by element id, u32
    ascending. Per-host opening lists and per-element colour lists keep their
    file order.
  - `flat_styles_rgba8` `(ids, rgba8)` sorted by id, u32 ascending (ids span
    geometry, material and element ids across the layered style precedence).
    Each array carries its own hash and entry count in the manifest
    (`voids_hash`, `material_colors_hash`, `styles_hash`), so a drift report
    names the wire surface that diverged.

The fingerprint (FNV-1a 64, same scheme as the kernel manifest) is pinned in
`rust/processing/tests/manifests/mesh_determinism.json` together with mesh,
vertex and triangle counts and per-mesh hashes, so a failure identifies WHICH
mesh diverged.

## At what settings

- `TessellationQuality::Medium` -- the byte-identity density (see
  `rust/geometry/src/tessellation.rs`).
- Local-frame vertex storage ON. This is the one flag whose DEFAULT differs
  per target (`local_frame_enabled()` in
  `rust/geometry/src/router/transforms/mod.rs`: ON for wasm32, the shipping
  viewer path; OFF for native unless `IFC_LITE_LOCAL_FRAME=1`). The manifest
  harness equalizes it by forcing the flag ON on every target via
  `ifc_lite_geometry::local_frame_set_enabled_override(Some(true))`, so the
  pinned bytes are the local-frame output (per-element f64 `origin` +
  element-local f32 positions). Native default output (absolute f32 coords)
  is a different, internally deterministic encoding of the same geometry and
  is NOT what the manifest pins.
- `OpeningFilterMode::Default`, default streaming options, no env overrides
  (`IFC_LITE_RECT_FAST`, `IFC_LITE_DISABLE_DEGENERATE_BACKSTOP` etc. unset).

## Across which targets

- x86_64 native == arm64 native: both assert the SAME manifest file
  (`mesh_determinism.json`). The arm64 leg runs in
  `.github/workflows/determinism.yml`.
- wasm32: asserts its own pinned manifest
  (`mesh_determinism.wasm32.json`), which is byte-identical to the native one
  EXCEPT the documented trig gap below. A native-side guard test
  (`wasm_manifest_differs_only_in_the_trig_gap`) pins that the two files never
  drift apart beyond that gap, and fails loudly (with unification
  instructions) if the gap ever closes.

Both legs call the same `compute_mesh_manifest()` in
`rust/processing/src/determinism.rs`, so fixture and hashing cannot drift
between targets.

## Known gap: libm trig ULP (wasm32 vs native)

Circle tessellation computes profile points with `sin`/`cos`. Platform libms
disagree by ~1 ULP on some inputs; f32 rounding absorbs that in positions
(they ARE byte-identical), but the smooth radial side normals of
circular-ish extrusions (`extrude_profile` in
`rust/geometry/src/extrusion.rs`) are derived from the f64 profile points, so
near-zero normal components (true value ~0, e.g. sin at the angle pi) keep
the full residue: measured -7.0e-17 native vs -2.1e-17 wasm32 on the fixture
column. Closing this requires deterministic trig (e.g. the pure-Rust `libm`
crate) in the profile tessellation path -- a separate work item. Until then
the round column's `normals_hash` is the ONLY divergence between the two pinned
manifests: its `positions_hash` and `indices_origin_hash` match native ==
wasm32 (empirically confirmed and asserted per-field by the guard), so a future
change that diverged the curved mesh's POSITIONS across targets would fail the
guard instead of hiding inside a combined per-mesh hash.

## What was fixed to get here

`consolidate_coplanar` (`rust/geometry/src/csg/consolidate.rs`) grouped cut
triangles into plane buckets keyed in an `FxHashMap` and emitted the output
mesh in bucket iteration order. FxHasher mixes usize-wide chunks, so its
iteration order differs between 64-bit native and 32-bit wasm32: the same
CSG cut emitted the same triangles in a different order per target. The
buckets are now a `BTreeMap` (Ord-keyed, target-independent iteration; same
pattern as `facet_weld`'s normal buckets), which made every CSG-cut mesh in
the battery byte-identical native == wasm32.

## What is NOT covered

- Other tessellation tiers (Lowest/Low/High/Highest) are internally
  deterministic but not cross-tier comparable, and are not pinned.
- Native default (local-frame OFF) output is not pinned; it shares all the
  same code except the frame subtraction.
- The kernel predicate sign manifest is a separate, existing guarantee; this
  contract does not replace it and the battery here does not exercise every
  kernel path (it covers rect-fast cuts; kernel-cut coverage rides the
  geometry crate's snapshot suite).
- Wire arrays other than voids/material-colors/styles (job lists, entity
  index payloads) are diagnostics/routing, not geometry, and are not pinned.

## Re-pinning

An intended geometry change re-pins both files: run
`cargo test -p ifc-lite-processing --test mesh_determinism -- --nocapture`,
copy the printed actual JSON into `mesh_determinism.json`, then run
`wasm-pack test --node rust/wasm-bindings --test mesh_determinism` and copy
its printed actual JSON into `mesh_determinism.wasm32.json`. The
`wasm_manifest_differs_only_in_the_trig_gap` guard verifies the pair stays
in lockstep.
