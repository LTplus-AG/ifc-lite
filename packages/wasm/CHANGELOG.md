# @ifc-lite/wasm

## 2.1.0

### Minor Changes

- [#887](https://github.com/LTplus-AG/ifc-lite/pull/887) [`175f8e3`](https://github.com/LTplus-AG/ifc-lite/commit/175f8e3ed93acba35f2efcb57993dd137ff7a241) Thanks [@louistrue](https://github.com/louistrue)! - Render IFC4x3 `IfcGridPlacement` so products laid out on a structural grid
  land on their grid-axis intersections instead of stacking at world origin
  (issue [#883](https://github.com/LTplus-AG/ifc-lite/issues/883)).

  The fix is in the shared `ifc-lite-geometry` Rust crate, so it ships on both
  surfaces that compile it: the WebAssembly build (`@ifc-lite/wasm`) and the
  native server binary downloaded by `@ifc-lite/server-bin` (pinned to its own
  package version, so it needs the bump to pull a rebuilt binary). The desktop
  app (Tauri) and the Docker server image compile the same crate and pick the
  fix up through their own build pipelines.

  The placement resolver dispatched only on `IfcLocalPlacement` and
  `IfcLinearPlacement` — every other placement type fell through to identity.
  The reporter's `ifcgrid.ifc` placed 25 `IfcColumn`s via
  `IfcGridPlacement → IfcVirtualGridIntersection`, so they all collapsed onto
  the same spot instead of spreading across the grid.

  This change:

  - Recognises `IfcGridPlacement` in the placement resolver. `PlacementRelTo`
    (the grid's own placement) composes exactly like `IfcLocalPlacement`;
    `PlacementLocation (IfcVirtualGridIntersection)` is resolved by reading the
    two referenced `IfcGridAxis` curves, intersecting them in the grid plane,
    applying the per-axis lateral `OffsetDistances` (each axis shifted along its
    left normal) and the optional elevation, then composing `parent * local`.
  - Implements full `IfcGridPlacementDirectionSelect` coverage for
    `PlacementRefDirection`: an `IfcDirection` sets local +X directly; an
    `IfcVirtualGridIntersection` points local +X from the placement location to
    that second intersection; null / unresolved inherits the grid orientation.

  Out of scope (documented in code):

  - Grid axes are treated as straight lines (chord of the first→last curve
    sample); curved axes would need arc-length sampling.

  Regression coverage:

  - `grid_placement_tests` in `rust/geometry/src/router/transforms.rs` — inline
    unit tests that assert the resolved transform directly: the axis-intersection
    origin, both `PlacementRefDirection` variants, the `OffsetDistances`
    perpendicular shift + elevation, and `PlacementRelTo` composition. No
    committed fixture (per AGENTS.md §9); the unit tests are self-contained.

- [#889](https://github.com/LTplus-AG/ifc-lite/pull/889) [`32c2f01`](https://github.com/LTplus-AG/ifc-lite/commit/32c2f014c668b97247d6cec236e53d1573201662) Thanks [@louistrue](https://github.com/louistrue)! - Render `IfcAlignment` as a thin centerline **line** instead of a triangulated
  ribbon, matching how IfcGrid axes and IfcAnnotation curves draw.

  `IfcAlignment` carries its geometry in the `Axis` curve (`IfcAlignmentCurve` or
  `IfcPolyline`), not a `Representation`. Previously the streaming batch mesher
  routed it through the whole-element `IfcAlignmentProcessor`, which sampled the
  directrix into a thin solid ribbon strip — visually wrong for what is a
  centerline. Now the alignment is sampled straight into a line-list overlay:

  - **`@ifc-lite/wasm`** gains `IfcAPI.parseAlignmentLines(content)`, which walks
    every `IfcAlignment`, resolves its `Axis` directrix, samples the centerline
    (1 file-unit station spacing, adaptive cap at 5000 samples) and returns a flat
    `Float32Array` of 3D line-list vertices `[x0,y0,z0, x1,y1,z1, …]` in the
    renderer's Y-up, RTC-subtracted, metres world space — the same frame the mesh
    pipeline produces, so the line lands on the same ground as the terrain.
  - **`@ifc-lite/geometry`** surfaces it as `GeometryProcessor.parseAlignmentLines`.
  - **`@ifc-lite/renderer`** gains `uploadAlignmentLines3D` / `clearAlignmentLines3D`,
    drawing the centerline through the existing line pipeline (separate buffer).

  The batch mesher no longer special-cases `IfcAlignment` into the ribbon
  processor (reverted to the prior skip), so alignments are lines-only — never
  both. In the viewer the centerline renders whenever a model carries an
  alignment (no toggle).

  Regression coverage: `alignment_lines` unit tests in
  `rust/wasm-bindings/src/api/alignment_lines.rs` pin the contract — a planar
  polyline alignment emits an even-count line-list whose start maps to the
  renderer origin and whose extent matches the directrix, and a file with no
  alignment emits an empty array.

## 2.0.0

### Major Changes

- [#874](https://github.com/LTplus-AG/ifc-lite/pull/874) [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85) Thanks [@louistrue](https://github.com/louistrue)! - Remove unused public exports that had zero consumers anywhere in the monorepo (coordinated breaking change). Each was verified against internal code, the other apps, the examples, the scaffolding templates, and the docs before removal.

  - **@ifc-lite/geometry**: drop `LODGenerator` / `LODConfig` / `LODMesh` (`lod.ts`), `DEFAULT_MATERIALS` / `getDefaultColor` / `getDefaultMaterialColor` / `MaterialColor` (`default-materials.ts`), and `calculateDynamicBatchSize`.
  - **@ifc-lite/parser**: drop `StyleExtractor` (and its `IFCMaterial` / `StyleMapping` types) and `OpfsSourceBuffer`.
  - **@ifc-lite/data**: drop `isBuildingLikeSpatialTypeName` — the enum-based `isBuildingLikeSpatialType` and the other spatial-type predicates stay.
  - **@ifc-lite/extensions**: drop `slugify` and `suggestedExtensionId`; the sibling id helpers (`suggestedCommandId`, `flavorImportedId`, `flavorMergedId`, `DEFAULT_FLAVOR_ID`) are retained.
  - **@ifc-lite/wasm**: drop the debug-only `debugProcessEntity953` / `debugProcessFirstWall` methods and the never-wired `scanEntityIndexShard` (Path C sharded-scan) export.

  Also removes the dead `ifc-lite-engine` crate (no workspace dependents) and the no-op `serde` feature on `ifc-lite-core` (it gated no code).

### Patch Changes

- [#874](https://github.com/LTplus-AG/ifc-lite/pull/874) [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85) Thanks [@louistrue](https://github.com/louistrue)! - Centralize IFC STEP entity scan selection behind a typed scanner helper, remove the unused duplicate `parseEntityOnDemand` implementation, keep the legacy `parse()` adapter on the shared scan path, route LOD exports through shared/adaptive ingestion paths, persist cache entity-index columns to avoid cache reload rescans, and update public docs away from legacy sync parse/geometry paths.

## 1.21.0

### Minor Changes

- [#871](https://github.com/LTplus-AG/ifc-lite/pull/871) [`cf01790`](https://github.com/LTplus-AG/ifc-lite/commit/cf01790e6b1859916d2f7df2b70ad0f562821416) Thanks [@louistrue](https://github.com/louistrue)! - Render IFC4x3 `IfcLinearPlacement` so products placed at a station along
  an `IfcAlignment` land on the alignment instead of at world origin
  (issue [#859](https://github.com/LTplus-AG/ifc-lite/issues/859)).

  The placement resolver previously dispatched only on `IfcLocalPlacement`
  — every other placement type fell through to identity. The reporter's
  `linear-placement-of-signal.ifc` (railway track with signals, signs and
  referents authored via `IfcLinearPlacement`) showed the obvious symptom:
  only one signal rendered, all stacked at world origin, instead of the
  dozens authored at varying stations along the gradient curve.

  This change:

  - Recognises `IfcLinearPlacement` in the placement resolver and resolves
    it by walking `RelativePlacement (IfcAxis2PlacementLinear)` →
    `Location (IfcPointByDistanceExpression)` → sampling the `BasisCurve`
    at `DistanceAlong`, then composing the curve-aligned frame with the
    authored lateral / vertical / longitudinal offsets. Falls back to the
    optional `CartesianPosition (IfcAxis2Placement3D)` when sampling fails
    rather than collapsing to identity.
  - Adds an `IfcGradientCurve` arm to `ProfileProcessor::get_curve_points`
    that delegates to the `BaseCurve` (attr 2). Without this every linear
    placement on a gradient curve errored out at the curve walker.
  - Adds an `IfcCurveSegment` (IFC4x3) fallback inside the composite-curve
    walker: emit each segment's `Placement.Location` as a sparse polyline
    sample and let the new linear-distance sampler interpolate between
    segment starts. For the railway fixture's long line segments this is
    exact at segment boundaries and within a few metres elsewhere — already
    a vast improvement over "all at origin". Per-segment parent-curve
    evaluation is follow-up scope.

  Out of scope (logged as follow-ups under [#859](https://github.com/LTplus-AG/ifc-lite/issues/859)):

  - Full `IfcGradientCurve` vertical evaluation so signals snap to the
    authored z grade instead of inheriting the base curve's z.
  - Per-segment `ParentCurve` sampling inside each `IfcCurveSegment` for
    sub-segment accuracy on clothoid / arc segments.

  Regression coverage:

  - `rust/geometry/tests/issue_859_linear_placement.rs` — drives the
    reporter's fixture. Asserts `Route Indicator_01` ([#3020](https://github.com/LTplus-AG/ifc-lite/issues/3020), station
    353.1 m) and `Route Indicator_02` ([#3031](https://github.com/LTplus-AG/ifc-lite/issues/3031), station 853.1 m) land in MGA
    projected territory (∼452 600 / 4 539 528 etc.) instead of world
    origin, with a measured separation within 10 m of the authored 500 m.
    Pre-fix both centroids collapsed to ≈ (0, 0, 0).

  Fixture `tests/models/issues/859_linear_placement_of_signal.ifc`
  (228 KB) added to the manifest.

## 1.20.0

### Minor Changes

- [#861](https://github.com/LTplus-AG/ifc-lite/pull/861) [`cc28f46`](https://github.com/LTplus-AG/ifc-lite/commit/cc28f4675b7cdca67ff6c97a6461337e17468fd2) Thanks [@louistrue](https://github.com/louistrue)! - Replace the in-tree BSP CSG kernel with Manifold (elalish/manifold) in
  the wasm build, matching the native path. Fixes the `RangeError: too
much recursion` / `unreachable executed` failures on degenerate IFC
  geometry (notably issue [#841](https://github.com/LTplus-AG/ifc-lite/issues/841) House.ifc) at the cost of ~250 KB added
  to the wasm bundle.

  The previous status — Manifold blocked on `wasm32-unknown-unknown` by
  upstream `wasm-cxx-shim` libc++ issues — was resolved in
  `wasm-cxx-shim` v0.5.0 / `manifold-csg-sys` 3.5.100 (May 2026). Flip
  `rust/wasm-bindings/Cargo.toml` to depend on
  `ifc-lite-geometry/manifold-csg-wasm-uu` and provision the
  cross-toolchain on Vercel via `scripts/vercel-install.sh`:

  - `dnf install clang20 lld20 cmake` from AL2023.
  - Fetch matching `libcxx-N.N.N.src.tar.xz` headers from the LLVM
    release page; cached under `/vercel/cache/wasm-cxx/` so subsequent
    deploys reuse them.

  Local dev: `brew install llvm lld` on macOS, `apt install clang-20
lld-20 libc++-20-dev libc++abi-20-dev` on Debian/Ubuntu. The
  wasm-cxx-shim toolchain file auto-detects standard install paths.

  `docs/architecture/geometry-pipeline.md` updated to reflect the new
  status, build prerequisites, and runtime properties (single-threaded
  on wasm, no exception runtime).

  Same correctness as the native Manifold path; wasm bundle grows from
  ~1.5 MB to ~1.7 MB after the existing `wasm-opt -O3` pass.

  ## Post-process for visual quality

  Manifold's raw output splits previously-single coplanar faces into
  many adjacent strips along the cutter boundary, and the verts on
  those strip boundaries are emitted as distinct (numerically
  near-coincident) topological points. Shipping that to the renderer
  as-is gave two visible artefacts on the PR's first deploy preview
  (`02_BIMcollab_Example.ifc`):

  1. **Scar lines on coplanar surfaces** — visible horizontal striations
     on walls / slabs / roofs where adjacent strips had slightly
     different vertex normals after per-vertex averaging.
  2. **Stretched sliver triangles** — long red "rays" shooting out of
     the building from rare boundary-intersection degenerate
     triangles.

  `manifold_to_mesh` now does a post-process pass:

  - Compute initial per-vertex face normals.
  - `Mesh::welded(1 µm position, 1 mrad normal)` — collapses pure
    numerical-noise duplicates while preserving crisp corner verts
    (perpendicular faces meeting at a point have distinct normals and
    stay separate).
  - Re-derive area-weighted normals on the welded mesh.

  The 1 µm tolerance is file-unit-relative (the CSG runs on the router's
  pre-scaled mesh) so it's safe for both metre and millimetre IFCs. An
  earlier attempt at the broader `Mesh::welded_by_position` collapsed
  legitimate distinct verts on rounded sanitary geometry and regressed
  `bath_csg_solid_test::subtracted_a_cavity` from ~0.55 m³ to 0.0326 m³;
  the normal-aware variant keeps the bath intact.

  Follow-up scope: a crease-angle smooth-group pass would make hard
  corners (wall-meets-floor) shade crisply while keeping coplanar
  surfaces uniform. The current post-process softens those corners
  slightly because position-only welding can't tell a real corner
  vertex from a numerical-noise duplicate without the normal-eps gate,
  and the gate's threshold is too tight to catch all the noise on
  boundary-coincident input.

- [#852](https://github.com/LTplus-AG/ifc-lite/pull/852) [`eada6ad`](https://github.com/LTplus-AG/ifc-lite/commit/eada6ad841d0dd5179088a8ba0b2bc6783d33e8d) Thanks [@louistrue](https://github.com/louistrue)! - Expose full 2D symbol data in the server's `ParseResponse` at parity
  with the browser-side parser (issue [#843](https://github.com/LTplus-AG/ifc-lite/issues/843)). The server now ships the
  same primitives the browser does: `IfcGrid` axis lines + bubble + tag
  glyphs, `IfcAnnotation` polylines, `IfcIndexedPolyCurve`,
  `IfcCircle` disks, `IfcEllipse` tessellations, `IfcTrimmedCurve` arcs
  with `PLANEANGLEUNIT` scaling + sense-agreement + wrap-around,
  `IfcCompositeCurve` recursion, `IfcGeometricSet` /
  `IfcGeometricCurveSet` recursion, `IfcMappedItem` with `MappingOrigin`

  - `MappingTarget` transform composition, `IfcTextLiteral` /
    `IfcTextLiteralWithExtent` with placement composition / `BoxAlignment`
    / cap-height derived from extent box, `IfcAnnotationFillArea` with
    outer ring + optional hole rings, and `IfcStyledItem` colour
    resolution (`IfcTextStyle` → `IfcColourRgb`, `IfcFillAreaStyle` →
    `IfcColourRgb`).

  The full 2 100-line extractor that used to live in
  `rust/wasm-bindings/src/api/symbolic.rs` has been moved into
  `ifc_lite_processing::symbolic` as the canonical implementation.
  Both pipelines now call the same function:

  - HTTP server: `extract_symbolic_data(&content) -> SymbolicData`
    serialised under `symbolic_data` in `ParseResponse`.
  - WASM bindings: `IfcAPI.parseSymbolicRepresentations(content)` is now
    a thin wrapper that calls `extract_symbolic_data` and converts the
    result into the existing `SymbolicRepresentationCollection`
    `wasm_bindgen` type via a new `from_data()` constructor.

  Net effect: zero behaviour change for the JS side (the
  `SymbolicRepresentationCollection` API surface is unchanged) but the
  server response now carries every primitive the renderer can paint,
  not just the scaffolding subset that the first cut had been
  deliberately scoped to.

  Coordinate handling at parity:

  - Per-product `ObjectPlacement` resolution via `IfcLocalPlacement`
    chain (translations accumulate after rotation by parent, rotations
    accumulate to orient symbols).
  - Per-representation `ContextOfItems.WorldCoordinateSystem` is
    composed in when present and non-trivial.
  - Auto-detected RTC offset is subtracted (same threshold the mesh
    pipeline uses).
  - Y-axis flip (`y → -y`) to match the renderer's section-cut coord
    convention.

  P1 review feedback from chatgpt-codex on the original commit
  (`symbolic.rs:181` — "Apply placements before emitting symbolic
  coordinates") was already addressed by an earlier commit on this
  branch (`ac72f039`) and remains addressed here: placements flow
  through `resolve_object_placement` for every entity.

  Regression coverage:

  - `rust/processing/tests/issue_843_symbolic_data.rs` — original
    three tests updated for the new behaviour. Grid extraction also
    emits axis lines + bubble texts now; the annotation-only count is
    filtered by `representation = "Annotation"`.
  - `rust/processing/tests/issue_843_symbolic_parity.rs` — four new
    tests driving a richer synthetic IFC4 file that exercises every
    new primitive family: `IfcCircle` disk, `IfcTextLiteralWithExtent`
    text, `IfcAnnotationFillArea` fill, `IfcEllipse` tessellation.
  - Full `cargo test -p ifc-lite-geometry --tests`: 267 passed,
    0 regressions.

### Patch Changes

- [#847](https://github.com/LTplus-AG/ifc-lite/pull/847) [`df912ca`](https://github.com/LTplus-AG/ifc-lite/commit/df912cafb1f3632abadee5134324165e5c1a084f) Thanks [@louistrue](https://github.com/louistrue)! - Render `IfcRationalBSplineSurfaceWithKnots` /
  `IfcBSplineSurfaceWithKnots` surfaces and `IfcSphere` CSG primitives
  when they appear directly under a `'Surface3D'` shape representation
  (issue [#842](https://github.com/LTplus-AG/ifc-lite/issues/842)).

  The B-spline tessellator (Cox-de Boor + rational weights) already
  existed for surfaces nested inside `IfcAdvancedFace`, but standalone
  surface items had no processor registered and `Surface3D`
  representations were filtered out at the router. Wire the same
  tessellator behind a `BSplineSurfaceProcessor`, add a `SphereProcessor`
  for the remaining `IfcCsgPrimitive3D` leaf used in the reporter's
  fixture, and allow `'Surface3D'` representations through the
  representation-type allow-list in `process_element` /
  `process_element_with_submeshes`.

  Regression coverage:

  - `rust/geometry/tests/issue_842_bspline_and_sphere.rs` — full pipeline
    against the reporter's NURBS marker fixture, asserting that the proxy
    containing the two 5×5 rational B-spline patches plus nine IfcSphere
    markers produces both surface tessellation and sphere meshes spanning
    the expected X extent.

  Fixture `tests/models/issues/842_rational_bspline_surface.ifc` added
  to the manifest (5.7 KB).

- [#849](https://github.com/LTplus-AG/ifc-lite/pull/849) [`9e2a644`](https://github.com/LTplus-AG/ifc-lite/commit/9e2a6440ff658f0c5fd58fc23d193fb8ddd897a4) Thanks [@louistrue](https://github.com/louistrue)! - Render `IfcAlignment` directrix curves and confirm `IfcGeographicElement`
  terrain meshes load (issue [#844](https://github.com/LTplus-AG/ifc-lite/issues/844)).

  `IfcGeographicElement` already routes through the standard pipeline —
  its `'Body','Tessellation'` representation hits the existing
  `TriangulatedFaceSetProcessor`. The issue was only ever the
  `IfcAlignment` side: in IFC4X1 the alignment carries its curve in a
  dedicated `Axis` (`IfcAlignmentCurve`) attribute and the file's
  `Representation` is typically `$`, so `process_element` bailed before
  reaching any geometry.

  Add `IfcAlignmentProcessor` that consumes the Axis curve via the
  existing `AlignmentCurve` evaluator (full IFC4X1 horizontal + vertical
  parser already used by `SectionedSolidHorizontalProcessor`) and
  samples it at 1 m intervals into a thin triangulated ribbon centred on
  the directrix. Short-circuit `process_element` for `IfcAlignment` so
  the missing-representation path falls through to the ribbon processor.

  Regression coverage:

  - `rust/geometry/tests/issue_844_terrain_and_alignment.rs` — drives the
    reporter's IFC4X1 fixture. Verifies both `IfcGeographicElement` [#30](https://github.com/LTplus-AG/ifc-lite/issues/30)
    (Terrain) tessellates and `IfcAlignment` [#59](https://github.com/LTplus-AG/ifc-lite/issues/59) (the 'A1' alignment,
    8 horizontal + 24 vertical segments) renders as a ribbon spanning
    more than 2 m on its longest axis.

  Fixture `tests/models/issues/844_terrain_and_alignment.ifc` (530 KB)
  added to the manifest.

- [#851](https://github.com/LTplus-AG/ifc-lite/pull/851) [`b2d6f2a`](https://github.com/LTplus-AG/ifc-lite/commit/b2d6f2a023935446ae8e9b7dc6e436dedd1555ad) Thanks [@louistrue](https://github.com/louistrue)! - Propagate `IfcRelVoidsElement` cuts to aggregated parts so
  `IfcWallElementedCase` walls (and any host whose body lives on its
  aggregated children) actually show the authored openings (issue [#845](https://github.com/LTplus-AG/ifc-lite/issues/845)).

  The reporter's fixture is the canonical IFC4
  `ifcwallelementedcase` model: an `IfcWall` with no body
  representation that aggregates a track frame plus drywall panels via
  `IfcRelAggregates`. The openings are authored directly against the
  wall, so the existing void path ran the cut against an empty host
  mesh — the kernel logged "Rectangular cut SILENT NO-OP" and the
  window/door cutouts never reached the panel geometry that actually
  covers them.

  Build a parent → children index from `IfcRelAggregates` during the
  entity scan and, after the void index is collected, breadth-first
  push every opening on a host down through the aggregation tree
  (visited-set cycle guard, deduplicate against authored direct voids).
  Each aggregated leaf now sees the openings and clips its mesh against
  them.

  Regression coverage:

  - `rust/processing/src/processor.rs` — four `propagate_voids_to_aggregated_parts`
    unit tests cover the full sub-tree walk, dedup against authored
    voids, aggregate cycles, and no-op when the host has no parts.
  - `rust/processing/tests/issue_845_wall_elemented_case.rs` — drives the
    reporter's fixture through `process_geometry` and asserts both
    drywall panel meshes ([#145](https://github.com/LTplus-AG/ifc-lite/issues/145) Panel Forward, [#146](https://github.com/LTplus-AG/ifc-lite/issues/146) Panel Reverse) end
    up with substantially more triangles than the pristine 12-tris
    slab — proof the openings now carve into them.

  Fixture `tests/models/issues/845_wall_elemented_case.ifc` (25 KB)
  added to the manifest.

- [#848](https://github.com/LTplus-AG/ifc-lite/pull/848) [`4632362`](https://github.com/LTplus-AG/ifc-lite/commit/46323626deed90ac5d5221569831ea6fcd6e0889) Thanks [@louistrue](https://github.com/louistrue)! - Fix `IfcRevolvedAreaSolid` rendering when the solid's `Position` is not
  identity or the revolution axis is offset from the profile origin
  (issue [#846](https://github.com/LTplus-AG/ifc-lite/issues/846)).

  The old `RevolvedAreaSolidProcessor` had two bugs:

  1. It ignored the `Position` (`IfcAxis2Placement3D`) attribute that
     places the swept solid's coordinate system in the enclosing
     representation. The profile and axis values were used as-if in the
     final object coord system.
  2. It misused the 2D profile vertex `(x, y)` as `(radius, height)`
     along the axis — only correct when the axis runs through the
     profile origin along the profile's Y axis. For the reporter's beam
     the axis sits 1.3 m offset from the profile and points along −Y,
     so the old code produced a tiny ring near the axis line instead of
     the authored 45° I-beam sweep.

  The fix applies `parse_axis2_placement_3d` to lift the swept-solid
  local coords into the surrounding object frame and rotates each
  profile vertex around the axis line using a proper Rodrigues
  decomposition into parallel and perpendicular components relative to
  the axis direction.

  Second follow-up: after the cap topology was fixed by earcut, the rendered
  I-beam profile still came out as a smooth blob because the side quads and
  caps shared profile-ring vertices — the viewer's vertex-normal averaging
  blended the flange face normal with the perpendicular web face normal at
  every sharp 90° crease in the IPE200 cross-section. Flat-shade the whole
  revolved solid (per-triangle vertex duplication, each triangle carries its
  own face normal) so creases stay crisp.

  Regression coverage:

  - `rust/geometry/tests/issue_846_revolved_beam.rs` — drives the reporter's
    beam-varying-extrusion-paths fixture. Asserts beam [#227](https://github.com/LTplus-AG/ifc-lite/issues/227) sweeps an arc
    ≥ 0.9 m long with a ≥ 0.15 m perpendicular profile extent, that beam
    [#210](https://github.com/LTplus-AG/ifc-lite/issues/210) (plain extrusion) is unaffected, that the cap triangulation is
    manifold (no edge shared by 3+ triangles), and that the mesh ships
    per-triangle normals so the renderer can't re-smooth the creases.

  Fixture `tests/models/issues/846_revolved_beam.ifc` (4.4 KB) added to
  the manifest.

  This PR was branched on top of PR [#847](https://github.com/LTplus-AG/ifc-lite/issues/847) (issue [#842](https://github.com/LTplus-AG/ifc-lite/issues/842) — IfcRationalBSplineSurfaceWithKnots),
  so the manifest update here also carries an `issues/842_rational_bspline_surface.ifc`
  entry inherited from that base. Once [#847](https://github.com/LTplus-AG/ifc-lite/issues/847) lands on `main` and this PR
  rebases, the 842 entry will already be on main and the diff collapses to
  just the 846 entry. Documented per PR [#848](https://github.com/LTplus-AG/ifc-lite/issues/848) review (coderabbit Minor) so
  the scope of the manifest delta is clear.

- [#870](https://github.com/LTplus-AG/ifc-lite/pull/870) [`14d69d3`](https://github.com/LTplus-AG/ifc-lite/commit/14d69d3359a0415d7bc8798411483a9f47c75ff3) Thanks [@louistrue](https://github.com/louistrue)! - Render `IfcTriangulatedIrregularNetwork` (terrain TIN) representations
  (issue [#859](https://github.com/LTplus-AG/ifc-lite/issues/859) follow-up to PR [#866](https://github.com/LTplus-AG/ifc-lite/issues/866)).

  PR [#866](https://github.com/LTplus-AG/ifc-lite/issues/866) stopped `IfcSolidStratum` (and the other concrete
  `IfcGeotechnicalStratum` leaves) from being silently dropped at
  `has_geometry_by_name`. That uncovered a second silent failure: the
  stratum's body is typically an `IfcTriangulatedIrregularNetwork`, and
  the geometry router rejected it with
  `"Unsupported representation type: IfcTriangulatedIrregularNetwork"`
  because no processor was registered for the type — the user's
  `UT_Tin_in_MGA_56.ifc` reached the viewer with 0 meshes and an empty
  viewport.

  `IfcTriangulatedIrregularNetwork` is a subtype of
  `IfcTriangulatedFaceSet`. It adds an optional `ClosedOrOpen` list at
  the tail but inherits Coordinates / Closed / CoordIndex in the same
  attribute slots — so the existing `TriangulatedFaceSetProcessor` is
  correct for TIN as-is. The fix:

  - Adds `IfcTriangulatedIrregularNetwork` to
    `TriangulatedFaceSetProcessor::supported_types()` so the router
    registers it against the same processor.
  - Extends the `IfcTriangulatedFaceSet | IfcPolygonalFaceSet` match
    arms in `router/processing.rs` (RTC detection / large-coord checks)
    and `router/layers.rs` (no-position geometry list) to also include
    TIN.
  - Adds TIN to `core::fast_parse::should_use_fast_path` so the
    direct-byte CoordIndex parser is used on real terrain meshes.

  Regression coverage:

  - `rust/geometry/tests/issue_859_tin_irregular_network.rs` — builds a
    minimal in-memory IFC4x3 file with an `IfcGeographicElement` whose
    body is a 2-triangle TIN, asserts the router produces a mesh with
    the authored bbox and triangle count. Pre-fix the call errored at
    the dispatch layer.

## 1.19.2

### Patch Changes

- [#839](https://github.com/LTplus-AG/ifc-lite/pull/839) [`8c1632c`](https://github.com/LTplus-AG/ifc-lite/commit/8c1632ceb63ff4cfdbac4f2936d54d2d3a7e2f1b) Thanks [@louistrue](https://github.com/louistrue)! - Improve IFC annotation legibility in 3D (issue [#812](https://github.com/LTplus-AG/ifc-lite/issues/812) follow-up):

  - **All annotation text now billboards to the camera.** Previously only
    IfcGridAxis tags rebuilt in the screen-aligned basis; IfcAnnotation
    text (dimensions, leader labels, room tags) kept its authored
    in-plane orientation. In oblique views that text collapsed to a
    smeared sliver of pixels — the "distorted dimension labels in
    FZK-Haus" symptom from the issue. The shader path was already
    per-instance billboard-aware, so the change is just a flag flip at
    upload time; anchor and alignment are unchanged.

  - **Grid bubbles no longer paint a white disc behind the tag.** The
    bubble interior is now transparent, so geometry behind a grid line
    reads through the bubble in 3D. The black outline ring (◯) and tag
    glyph are unchanged — the white ● fill instance has been removed
    from `emit_bubble`, which also drops one text instance per bubble.

  - **Annotation text no longer z-fights coplanar surfaces.** Now that
    every glyph billboards, the quad faces the camera with zero depth
    slope across its screen extent — which means the text pipeline's
    `depthBiasSlopeScale: -0.5` contributes ~0 and only the small `-4`
    constant survives, not enough to beat MSAA jitter on a label drawn
    exactly on a wall/floor face (visible as dimension digits strobing
    against terrain in 3D). The symbolic-overlay text shader now applies
    the same `clip.z + 5e-5 * clip.w` reverse-Z nudge the section-2D
    line pipeline already uses — depth-format-independent, slope-
    independent, and large enough to clear coplanar jitter without
    pulling the label visibly off the surface.

- [#840](https://github.com/LTplus-AG/ifc-lite/pull/840) [`231e494`](https://github.com/LTplus-AG/ifc-lite/commit/231e494e7ee920c5219d7fa5c5c6dde4c2bced2a) Thanks [@louistrue](https://github.com/louistrue)! - Fix `IfcOpeningElement` punching through the entire wall when the
  authored opening pokes past one wall face (issue [#832](https://github.com/LTplus-AG/ifc-lite/issues/832)).

  `router/voids.rs::extend_opening_along_direction` is a Revit/ArchiCAD
  heuristic that stretches an opening AABB along its own extrusion axis
  to make sure the AABB clip lands cleanly on both wall faces. It was
  designed for the "opening modelled too short" pattern — opening fully
  inside the wall in extrusion direction. When an opening is _offset_
  so part of it sticks out one face (e.g. a 1 m × 1 m × 0.2 m opening
  positioned so its 0.2 m depth straddles the wall's +X face at exactly
  the wall-thickness boundary), the heuristic over-extended through
  the wall and the AABB clip removed BOTH the touched and untouched
  wall faces — the "punched-through slot" the bug reporter saw on
  wall [#222](https://github.com/LTplus-AG/ifc-lite/issues/222) in `ifc-opening.ifc`.

  The fix adds a gate that bails out of the extension when the
  opening's projection on its own extrusion axis pokes past either
  wall projection — comparing projections (not raw coords) so the
  sign of the extrusion direction is irrelevant. The author's bite
  is preserved verbatim and the AABB clip only removes the wall
  material the opening actually intersects.

  Regression coverage:

  - `rust/geometry/tests/issue_832_opening_representations.rs` — full
    pipeline test against the reporter's 5-wall fixture, asserting
    each wall ends up with a bounded hole and the wall faces the
    opening doesn't reach remain pristine 2-triangle rectangles.
  - `router::voids::reveal_tests::test_extend_opening_skipped_when_opening_pokes_past_wall`
    — direct unit test pinning the new gate, covering both `+X` and
    `-X` extrusion-direction polarity.
  - The existing [#604](https://github.com/LTplus-AG/ifc-lite/issues/604) "exact-match coplanarity pad" regression
    (`test_extend_opening_pads_past_wall_on_exact_match`) still passes
    unchanged — the new gate intentionally does not fire when the
    opening fits exactly inside the wall.

  Fixture `tests/models/issues/832_opening_representations.ifc` (11 KB,
  SHA-256 `0a81eda40a3b…`) added to the manifest. The bytes need to be
  uploaded to the `fixtures-v1` GitHub Release via `pnpm fixtures:upload`
  once merged.

- [#838](https://github.com/LTplus-AG/ifc-lite/pull/838) [`279d897`](https://github.com/LTplus-AG/ifc-lite/commit/279d897dd6e28214930a6b0fffe01dd813141ee0) Thanks [@louistrue](https://github.com/louistrue)! - `GeometryRouter::get_or_cache_by_hash` now performs a full equality
  check on every hash hit before reusing the cached `Arc<Mesh>` (issue
  [#833](https://github.com/LTplus-AG/ifc-lite/issues/833)). The previous fast path returned a hash match without checking
  geometry, on the theory that `FxHasher`'s 64-bit output collides only
  ~1 in 2^64. Under wasm32 codegen on `schependomlaan.ifc`, two slabs
  with mirrored rectangular cross-sections (a 7.43 m × 3 m profile in
  +X+Y vs −X−Y) hashed to the same value: the second slab's local mesh
  was silently replaced by the first, and after placement the slab
  rendered as a "floating" mesh 7.43 m off the building. Native x86_64
  hashes both meshes distinctly, which is why the bug only surfaced in
  the browser — the regression was invisible to the Rust integration
  tests until we forced a collision in the new
  `router::caching::tests::collision_does_not_silently_swap_meshes`
  test.

  On a true match (the cache's intended fast path — repeated geometry
  across N storeys, instanced doors / windows) we still return the
  shared `Arc`, so dedup behaviour is preserved. On a false-positive
  hash hit we return a fresh `Arc` without overwriting the existing
  entry, so subsequent identical lookups continue to dedupe.

- [#836](https://github.com/LTplus-AG/ifc-lite/pull/836) [`d83fc42`](https://github.com/LTplus-AG/ifc-lite/commit/d83fc424a6b9d2a786e2dfaabe1dc2fb8746d07c) Thanks [@louistrue](https://github.com/louistrue)! - `IfcSectionedSolidHorizontal` now renders with full directrix curve
  evaluation (issue [#828](https://github.com/LTplus-AG/ifc-lite/issues/828)). The IFC4x1 infrastructure entity — used for
  road / bridge / alignment models with varying cross-sections — was
  previously erroring "Unsupported representation type". The new
  `SectionedSolidHorizontalProcessor` plus the `crate::alignment`
  evaluator sweep each profile along the actual `IfcAlignmentCurve`:

  - **Horizontal alignment** — `IfcLineSegment2D`, `IfcCircularArcSegment2D`,
    and `IfcTransitionCurveSegment2D` (linear-curvature clothoid;
    Bloss / cubic-parabola / sine / cosine subtypes degrade to a
    clothoid with matching endpoint curvatures, which is geometrically
    continuous instead of a jump). Each segment's StartPoint /
    StartDirection / SegmentLength is taken as authoritative — the
    evaluator does not assume segments are pre-joined.
  - **Vertical alignment** — `IfcAlignment2DVerSegLine`,
    `IfcAlignment2DVerSegParabolicArc`, and `IfcAlignment2DVerSegCircularArc`.
    Circular vertical curves use the parabolic approximation
    `z ≈ z₀ + g₀·s + ±s²/(2R)`, sub-mm-accurate for typical highway radii.
  - **Plane-angle unit conversion** — `StartDirection` values are scaled
    via `EntityDecoder::plane_angle_to_radians()`, so files declaring
    `PLANEANGLEUNIT = .DEGREE.` (like the issue's fixture) get the right
    geometry.
  - **Mesh construction** — each station gets a placement frame with
    `+X` perpendicular-right of travel and `+Z` along global up
    (FixedAxisVertical=true; cant/superelevation TODO). Side walls are
    one quad per profile edge per station pair with flat-shaded face
    normals; caps are earcut triangulations of the start and end
    profiles. A topology change (varying vertex count between adjacent
    cross-sections) closes the current sub-sweep with a cap and reopens
    a new one.
  - **Falls back gracefully** when the directrix isn't an
    `IfcAlignmentCurve` (e.g. an arbitrary polyline) to a straight
    sweep along the body's local +Y axis.

  Two profile types in the same fixture are also closed out:

  - **`IfcAsymmetricIShapeProfileDef`** — six steel-girder profiles
    used this entity. Added a 12-point CCW builder with independent
    top/bottom flange widths and thicknesses; the IFC4 WR3 fallback
    (`TopFlangeThickness ← BottomFlangeThickness`) applies when the
    optional attribute is `$`. Fillet radii and flange slopes are
    parsed but ignored (same posture as the symmetric I-shape).
  - **`IfcMirroredProfileDef` with implicit operator.** Per IFC4 §8.6.2.21
    this subtype writes `$` for `Operator` and reflects the parent
    about its local Y-axis. The previous code errored "Operator not
    found"; it now short-circuits with an explicit X-mirror plus
    contour-winding reversal. `IfcDerivedProfileDef` with a null
    operator is now treated as identity instead of failing.

  Regression tests:

  - `every_sectioned_solid_horizontal_in_fixture_lofts` — all 16
    sectioned solids in the fixture loft to non-empty meshes
    (pre-fix: 9/16).
  - `sectioned_solid_horizontal_lofts_pier_69` — pier [#69](https://github.com/LTplus-AG/ifc-lite/issues/69) has the
    expected curved bounds (~134 m principal span, several metres
    of lateral deflection that would be zero for a straight sweep,
    ~10+ m vertical from the parabolic sag at the far end).
  - Three alignment-evaluator unit tests pin the line-segment, arc, and
    parabolic-vertical math against the fixture's authored numbers.

## 1.19.1

### Patch Changes

- [#834](https://github.com/LTplus-AG/ifc-lite/pull/834) [`bdb9978`](https://github.com/LTplus-AG/ifc-lite/commit/bdb997842fe38627fefbcddf250fc0136289bc84) Thanks [@louistrue](https://github.com/louistrue)! - Three IFC geometry fixes plus a Dutch / metric-export properties-panel fix.

  - **[#820](https://github.com/LTplus-AG/ifc-lite/issues/820) — `IfcTrimmedCurve` parameter values now respect `PLANEANGLEUNIT`.**
    `process_trimmed_conic` previously called `.to_radians()` unconditionally,
    silently shrinking a 240° arc to ~4° on files that declare
    `IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)` (e.g. the Renga-exported
    `RadianValuesOverPI.ifc` wall whose trim values are `5.7596`/`9.9484`
    radians). Added `extract_plane_angle_to_radians` to `ifc_lite_core::units`
    and a lazy lookup on `EntityDecoder` so the right scale (1.0 for RADIAN
    files, π/180 for DEGREE conversion-based units) is applied without
    per-call IFC scanning.

  - **[#821](https://github.com/LTplus-AG/ifc-lite/issues/821) — `IfcBooleanResult.DIFFERENCE` falls back to the un-cut host when
    the subtract emits an empty mesh from a non-empty host.** Revit IFC2x3
    exports (e.g. `TallBuilding.ifc`) sometimes author top-trim
    `IfcPolygonalBoundedHalfSpace` planes that land exactly on the wall's top
    with `AgreementFlag = .T.`, making the spec-strict half-space material
    region exactly cover the wall body — the strict subtract returns nothing
    and the wall vanishes. Production viewers (BIMVision, IfcOpenShell) revert
    to the host in this case; the processor now does the same and records the
    loss as `BoolFailureReason::DifferenceEmptiedHost` so it surfaces in CSG
    diagnostics rather than disappearing silently.

  - **[#819](https://github.com/LTplus-AG/ifc-lite/issues/819) — `IfcTriangulatedFaceSet` flat-shades by default.** Without
    per-vertex `Normals` the downstream normal accumulator was smooth-averaging
    face normals across every shared vertex, smearing crisp facet edges into
    muddy gradients on faceted geometry (visible on the
    `IFC4TessellationComplex.ifc` dome compared to BIMVision's flat-shaded
    render). The processor now duplicates vertices per-triangle and writes
    per-face normals, matching what `IfcPolygonalFaceSet` already does and
    the IfcOpenShell / web-ifc default.

  - **Layer thickness display in the properties panel** (`MaterialCard`)
    showed "60.0 m" for a 60 mm prefab slab on `LENGTHUNIT=MILLI.METRE`
    files. `material-resolver` now multiplies the raw `IfcMaterialLayer.LayerThickness`
    by `store.lengthUnitScale` before storing it, so `formatThickness` sees a
    proper metres value and reports "60.0 mm".

  Adds three regression tests pinned to fixtures under `tests/models/issues/`:

  - `issue_819_triangulated_normals.rs`
  - `issue_820_trimmed_curve_planeangleunit.rs`
  - `issue_821_difference_emptied_host.rs`

  Catalogue updated; fixtures will be uploaded to the `fixtures-v1` release.

- [#835](https://github.com/LTplus-AG/ifc-lite/pull/835) [`ee6dbae`](https://github.com/LTplus-AG/ifc-lite/commit/ee6dbaedcc205b08728fa3e235bc3028d32b65e3) Thanks [@louistrue](https://github.com/louistrue)! - Resolve element colours that are authored via the `IfcMaterial` chain
  (orphan `IfcStyledItem` → `IfcStyledRepresentation` →
  `IfcMaterialDefinitionRepresentation`).

  Files like schependomlaan.ifc and the bulk of ArchiCAD / Revit IFC2x3
  exports don't attach `IfcStyledItem` to the geometry items themselves —
  they attach styles to the underlying `IfcMaterial`. The streaming prepass
  (`buildPrePassStreaming`) already folds those resolved colours into
  `geometry_styles` keyed by the element's own express ID, but
  `resolve_element_color` previously only looked them up by traversing the
  representation chain and never checked the element-keyed entries. The
  data sat unused and every such element rendered as the per-type grey
  default.

  `resolve_element_color` now:

  1. Walks the representation chain as before (direct `IfcStyledItem` on a
     geometry item — including `IfcMappedItem` recursion via
     `find_color_for_geometry` — wins by IFC precedence).
  2. Falls back to `geometry_styles.get(&entity.id)` for the element-keyed
     material-chain colour the prepass already computed.

  Verified on `tests/models/ara3d/duplex.ifc`: 371 of 486 meshes (76%) now
  pick up authored material colours (22 distinct colours from the IFC's
  materials palette) instead of falling through to default grey. Direct
  `IfcStyledItem`-on-geometry-item still wins where present.

  Adds five inline unit tests to `rust/wasm-bindings/src/api/styling.rs`
  covering: empty styles → None, direct-only, material-only, both (direct
  wins), unrelated → None.

## 1.19.0

### Minor Changes

- [#659](https://github.com/LTplus-AG/ifc-lite/pull/659) [`f209e34`](https://github.com/LTplus-AG/ifc-lite/commit/f209e342c306041ea045bc108595676efa671eec) Thanks [@louistrue](https://github.com/louistrue)! - Render IfcAnnotation 2D representations as a 3D drawing-layer overlay
  (closes [#653](https://github.com/LTplus-AG/ifc-lite/issues/653)). Implements the BIMVision-style "model + annotations =
  engineering drawing" effect described by the OP.

  What's covered:

  - **Rust WASM**: new `SymbolicText` and `SymbolicFillArea` types
    carried alongside the existing symbolic polyline output. The parser
    walks `IfcTextLiteralWithExtent.Placement` and
    `IfcAnnotationFillArea.OuterBoundary`/`InnerBoundaries` (across
    `IfcPolyline` and `IfcIndexedPolyCurve`).
  - **TS hook**: `useSymbolicAnnotationsRichData()` returns 3D-lifted
    texts + fills with per-storey resolution. Module-level parse cache
    is now keyed on `byteLength + FNV-1a fingerprints of head/mid/tail`,
    so federated views with same-size IFCs no longer alias each other.
    Storey elevation handling distinguishes "no authored elevation"
    from "elevation = 0.0" (the previous sentinel collapsed both to
    the fallback Y).
  - **Renderer**: two new WebGPU pipelines — `SymbolicFillPipeline`
    (ear-clipping triangulation with rightmost-vertex bridge-edge
    hole stitching, premultiplied-alpha blend) and
    `SymbolicTextPipeline` (Canvas2D glyph atlas → instanced WebGPU
    quads). Both declare matching MSAA sample count + the 2-color-
    target attachment shape used by the main render pass, and run with
    reverse-Z `greater-equal` depth compare so they composite correctly
    against the scene.
  - **Viewport wiring**: `Viewport.tsx` calls the new hook unconditionally
    whenever the user enables the IFC Annotations toggle — no section-
    plane gating, since annotations are a free-floating drawing layer.

  Deferred (no behaviour change, follow-up):

  - `IfcStyledItem` → `IfcFillAreaStyleHatching` resolution. The parser
    stubs in a default opaque dark-grey solid fill; the renderer is
    ready to consume a hatch style once the styled-item index lands.

## 1.18.0

### Minor Changes

- [#688](https://github.com/LTplus-AG/ifc-lite/pull/688) [`d0ba541`](https://github.com/LTplus-AG/ifc-lite/commit/d0ba541dda3936b985c2189fbca4300cbb89df91) Thanks [@louistrue](https://github.com/louistrue)! - Add GLB export dialog with colour-source selection and visibility
  filtering (PR [#688](https://github.com/LTplus-AG/ifc-lite/issues/688)).

  The new `GLBExportDialog` in the viewer replaces the inline GLB
  export handler in `MainToolbar` with a dedicated dialog. Features:

  - **Model picker** for federated multi-model scenes.
  - **Colour source** selector: "Rendering" (the apparent display
    colour — `IfcSurfaceStyleRendering.DiffuseColour` if authored,
    falling back to `IfcSurfaceStyleShading.SurfaceColour`) or
    "Shading" (the raw `SurfaceColour`, only available when the file
    authored a distinct `DiffuseColour`).
  - **Visible-only filter** that respects the viewer's hidden /
    isolated entity sets. Mesh-vs-set comparison runs in global ID
    space so federated models with non-zero `idOffset` filter
    correctly.
  - **Metadata inclusion** toggle for IFC GlobalId / type / name
    side-tables.

  Pipeline changes underneath:

  - `MeshData` / `MeshDataJs` carry an optional `shadingColor`
    alongside `color`. The Rust styling module now extracts both
    `IfcSurfaceStyleRendering.DiffuseColour` (rendering) and
    `IfcSurfaceStyleShading.SurfaceColour` (shading) in a single
    pre-pass and returns them as separate maps; `shadingColor` is
    only populated when it actually differs from the rendering
    colour, so memory cost stays sparse on the common case.
  - The streaming geometry path
    (`convertMeshCollectionToBatch`) and the worker collector
    (`IfcLiteMeshCollector`) both copy `shadingColor` end-to-end so
    the dialog's "Shading" source works on every load path, not just
    the batch path.
  - `GLTFExporter` gains `colorSource`, `visibleOnly`,
    `hiddenEntityIds`, and `isolatedEntityIds` options. Visibility
    filtering compares mesh `expressId` (global) against the dialog-
    supplied sets (also global) — no offset arithmetic in the
    exporter.

### Patch Changes

- [#803](https://github.com/LTplus-AG/ifc-lite/pull/803) [`b0b19ad`](https://github.com/LTplus-AG/ifc-lite/commit/b0b19ad2ea205813e599cac02c964ecdb315c6b5) Thanks [@louistrue](https://github.com/louistrue)! - Fix the wedge-shaped Z-fight artifact on the door-glass panel
  of Revit-exported `IfcDoor` fixtures (issue [#674](https://github.com/LTplus-AG/ifc-lite/issues/674) true root cause,
  PR [#802](https://github.com/LTplus-AG/ifc-lite/issues/802)).

  `process_planar_face` in `advanced_face.rs` triangulated each
  `IfcFaceBound` of an `IfcAdvancedFace` as an independent solid
  polygon, ignoring the IFC 4.3 schema's `IfcFaceOuterBound` vs
  inner-bound distinction. For a face with one outer rectangle +
  one inner hole rectangle (the door panel's glass cutout), this
  emitted:

  - outer ring: 2-tri solid quad covering the whole face
  - inner ring: 2-tri solid quad covering the hole, with the
    schema-imposed reversed winding → opposite normal

  Identical plane, opposite normals, overlapping in the cutout's
  footprint. The WebGPU pipeline runs `cullMode: 'none'`, so the
  canceling pair rendered as the visible wedge.

  Fix: identify the outer bound (preferring the typed
  `IfcType::IfcFaceOuterBound`, falling back to the first bound for
  files that emit only `IfcFaceBound`), treat siblings as holes,
  honour the per-bound orientation flag, and call the existing
  `triangulate_polygon_with_holes` helper once — the same pattern
  the FacetedBrep path in `brep.rs` already uses.

  Door panel [#712](https://github.com/LTplus-AG/ifc-lite/issues/712) on the issue-604 fixture now emits 32 triangles
  (matching IfcOpenShell's reference), up from 24 pre-fix. The
  same broken code path was the fallback for every other surface
  type in `advanced_face.rs` (B-spline edge cap, cylindrical /
  conical / spherical / toroidal / surface-of-linear-extrusion
  fallbacks); all of those now also produce correct annular
  triangulations on faces with inner bounds.

- [#803](https://github.com/LTplus-AG/ifc-lite/pull/803) [`b0b19ad`](https://github.com/LTplus-AG/ifc-lite/commit/b0b19ad2ea205813e599cac02c964ecdb315c6b5) Thanks [@louistrue](https://github.com/louistrue)! - Fix the door-handle bend rendering with the lever floating
  detached from the rosette on Revit-exported `IfcDoor` fixtures
  (issue [#674](https://github.com/LTplus-AG/ifc-lite/issues/674) redux, PR [#799](https://github.com/LTplus-AG/ifc-lite/issues/799)).

  `process_surface_of_revolution_face` in `advanced_face.rs` read
  `surface.get(1)` for the axis placement, but per IFC 4.3 the
  `IfcSurfaceOfRevolution` schema is:

  IfcSweptSurface (parent)
  0 SweptCurve
  1 Position (optional IfcAxis2Placement3D)
  IfcSurfaceOfRevolution (child)
  2 AxisPosition (IfcAxis1Placement)

  Revit exports `IFCSURFACEOFREVOLUTION(#sc,$,#ap)` — slot 1 is
  null. Reading slot 1 returned None, the fallback
  `(Point3::origin(), +Z)` kicked in, and the angular-extent
  calculation projected boundary points around (0,0,0) instead of
  the true revolution axis. The bend swept ~13° through the wrong
  region of space and the bulb ended up pointing "down and outward"
  from the rosette.

  Switched to `surface.get(2)`. AABB on the door fixture lands at
  x=[115, 245] y=[67, 122] vs IfcOpenShell's [120, 250] / [70, 120]
  (5 mm offset from tessellation density). The bulb now rotates
  through the correct quadrant and the handle connects.

## 1.17.0

### Minor Changes

- [#655](https://github.com/LTplus-AG/ifc-lite/pull/655) [`a6637a4`](https://github.com/LTplus-AG/ifc-lite/commit/a6637a41d948ec17841a0ac62586f627d0bb21fa) Thanks [@louistrue](https://github.com/louistrue)! - CSG primitive support + BSP CSG quality overhaul (issue [#780](https://github.com/LTplus-AG/ifc-lite/issues/780)):

  - **Renders the buildingSMART IFC 4.3 bath reference (`bath_csg_solid.ifc`)
    and similar `IfcCsgSolid` geometry.** Three new entity processors:

    - `IfcBlock` — axis-aligned box CSG primitive.
    - `IfcCsgSolid` — pass-through that unwraps `TreeRootExpression` to the
      matching `IfcBooleanResult` or `IfcCsgPrimitive3D` processor.
    - `IfcRoundedRectangleProfileDef` — rectangle with fillet-arc corners.
      These appear in IFC 4.3 reference content and in CSG-style authored
      models that previously emitted no geometry.

  - **BSP CSG pipeline overhaul.** Three coupled fixes that drop the bath
    reference from 189 to 59 triangles with zero sliver artifacts on the
    WASM (Manifold-free) build:

    1. **Coplanar pre-merge** in `ClippingProcessor::mesh_to_polygons`
       reassembles each input mesh's per-plane triangle clusters into
       convex N-gon polygons before BSP runs. Stops BSP from splitting
       host face diagonals at every extended cutter wall plane (the
       "spike triangle" defect on the bath).
    2. **Post-BSP coplanar consolidation** (`consolidate_coplanar`)
       re-unions per-plane fragments via the same `i_overlay` 2D union
       the rest of the codebase already uses for `bool2d::union_contours`,
       then earcuts the result with hole support — so annular faces (bath
       rim around the cavity opening) come out clean.
    3. **Collinear-vertex simplification** strips phantom vertices that
       BSP's extended planes insert on host outline edges. Without this,
       earcut emits one sliver triangle per phantom; with it, host faces
       untouched by the cutter collapse back to their original quads.

  - **Solid-solid `IfcBooleanResult.DIFFERENCE` now runs on the WASM
    build.** Previously gated to `manifold-csg` only and silently returned
    the un-cut host on the wasm32 target. The legacy BSP path already had
    its own `OperandTooLarge` guardrail (128-polygon cap with
    `BoolFailure` logging), so the conservative skip was unnecessary —
    small solid-solid cuts (e.g. CSG primitives) now subtract correctly.

  - **Dead code removal in `rust/geometry/src/csg.rs` (~470 lines).**

    - `remove_degenerate_triangles` — was nuking the bath cavity floor
      because its "strictly inside host bounds AND small ⇒ artifact"
      heuristic is structurally wrong for closed cavities. Replaced by
      the new consolidation pipeline that handles the same sliver class
      without the false positives.
    - `extract_opening_profile` — never called anywhere.
    - `clip_mesh_with_box` — deprecated wrapper around `subtract_box`, no
      callers.
    - `remove_triangles_inside_bounds` — never wired up, kept "for future
      rectangular openings" since 2024.

  - **Cross-fixture CSG quality regression** (`csg_quality_regression.rs`).
    Pins zero spike triangles (aspect ratio > 50:1) on AC20-FZK-Haus
    gable walls ([#60012](https://github.com/LTplus-AG/ifc-lite/issues/60012) / [#67828](https://github.com/LTplus-AG/ifc-lite/issues/67828), chained polygonal-bounded half-space
    clips) and on the bath fixture. Three pre-existing spike sources in
    the rectangular-opening path (duplex window [#6426](https://github.com/LTplus-AG/ifc-lite/issues/6426), advanced_model
    walls [#553010](https://github.com/LTplus-AG/ifc-lite/issues/553010) / [#612315](https://github.com/LTplus-AG/ifc-lite/issues/612315)) are pinned `#[ignore]`d with their current
    spike counts so they become tightening gates once that separate path
    is cleaned up.

  - **Stale `bool_failure_test::*_records_operand_too_large` tests
    updated.** They depended on 36 stacked-at-same-position box triangles
    exceeding a 24-polygon cap. The cap was raised to 128 in PR [#648](https://github.com/LTplus-AG/ifc-lite/issues/648) and
    the new coplanar merge collapses stacked-coincident boxes anyway;
    replaced with 30 distinct-position boxes (180 face polygons) so the
    cap-rejection path is genuinely exercised.

### Patch Changes

- [#795](https://github.com/LTplus-AG/ifc-lite/pull/795) [`bb3123a`](https://github.com/LTplus-AG/ifc-lite/commit/bb3123adcd751f4c27b4457156e2d0bae3b40e56) Thanks [@louistrue](https://github.com/louistrue)! - Fix walls sticking through curved roof slabs on AC20-Institute-Var-2
  (issue [#583](https://github.com/LTplus-AG/ifc-lite/issues/583), PR [#789](https://github.com/LTplus-AG/ifc-lite/issues/789)). The chained-polygonal-bounded-half-space code
  path used to mesh-merge every cutter in an `IfcBooleanClippingResult`
  chain into one combined cutter before running a single BSP CSG
  subtract. When the chain contained overlapping or duplicate prisms
  (Wand-010 has four chained cutters including an exact duplicate at
  `x = [17, 25]`), the merge of two closed solids occupying the same
  volume was non-manifold by construction and BSP produced sliver
  artefacts that left ~0.4-2.7 m of wall sticking through the roof.

  The fix follows the web-ifc model: drop the batching, let chains fall
  through the standard recursive single-cutter path. Each per-step
  cutter is a single closed manifold prism, structurally eliminating
  the non-manifold-cutter root cause. Two long-standing
  `IfcPolygonalBoundedHalfSpace` issues that the batched path was
  masking were also fixed: the prism now extrudes along the cutter
  Position's `+Z` axis (per the IFC 4.3 spec, not the plane's material-
  side direction), and the polygon winding is reversed against
  `Position.Z` to match the cap reversal in `build_tilted_prism_mesh`.

- [#795](https://github.com/LTplus-AG/ifc-lite/pull/795) [`bb3123a`](https://github.com/LTplus-AG/ifc-lite/commit/bb3123adcd751f4c27b4457156e2d0bae3b40e56) Thanks [@louistrue](https://github.com/louistrue)! - Fix the broken door-handle silhouette on Revit-exported `IfcDoor`
  fixtures (issue [#674](https://github.com/LTplus-AG/ifc-lite/issues/674), PR [#793](https://github.com/LTplus-AG/ifc-lite/issues/793)). `process_surface_of_revolution_face`
  collapsed each profile point's radial vector to
  `radius = sqrt(rx² + ry²)`, discarding the sign of the projection
  onto `axis_x`. Profiles that sat entirely on the `-axis_x` half of
  the axis frame — for example the Revit door-handle bulb, an
  `IfcCircle` arc whose centre is offset 15 mm from the revolution
  axis on the bar side — got mirrored to the `+axis_x` ray and rendered
  180° away from where they should sit, leaving a visible gap between
  the lever bar and the rosette.

  The sweep now rotates the profile's actual `(rx, ry)` 2D radial
  vector through the sweep angle, so profiles offset to either side of
  the axis stay on their side. Triangle counts are unchanged
  (repositioning, not re-sampling).

- [#655](https://github.com/LTplus-AG/ifc-lite/pull/655) [`a6637a4`](https://github.com/LTplus-AG/ifc-lite/commit/a6637a41d948ec17841a0ac62586f627d0bb21fa) Thanks [@louistrue](https://github.com/louistrue)! - Geometry correctness fixes from the calibration-report sweep (PR [#655](https://github.com/LTplus-AG/ifc-lite/issues/655)):

  - **W410x60 / wide-flange profile area is now correct to within arc-sampling
    noise.** Revit authors I-beams as `IfcArbitraryClosedProfileDef` whose
    composite curve mixes long polyline edges with short fillet-arc edges;
    the over-tessellated-curve detector was misclassifying the mix as a smooth
    curve and RDP was slicing across the polyline corners, adding ~4.3 % to
    the swept volume. Now gated on a longest-edge/diagonal ratio so mixed-
    geometry profiles bypass simplification entirely.

  - **Walls authored with `IfcExtrudedAreaSolid` profiles whose aspect ratio
    exceeds 100:1 no longer emit as hollow tubes.** The cap-skip threshold
    caught normal residential interior walls (115 mm × 12 m = ratio 103),
    dropping their top/bottom faces. Raised to 10000:1 — only genuinely
    pathological profiles trigger the skip now.

  - **Opening extension no longer wipes the wall when the opening's
    extrusion axis maps to the wall's long axis.** Two new gates skip the
    extension heuristic when (a) the opening already spans the wall in the
    extrusion direction (advanced_model [#553010](https://github.com/LTplus-AG/ifc-lite/issues/553010), a 300 mm horizontal slot),
    and (b) the wall extends further along the extrusion direction than the
    opening's longest dimension (advanced_model [#612315](https://github.com/LTplus-AG/ifc-lite/issues/612315), a 115 mm column
    whose Position transform rotates +Z onto the wall's 11.8 m long axis).
    Six previously-failing calibration walls now produce correct cuts.

  - **New `Mesh::welded()` and `Mesh::welded_by_position()` APIs** on the
    Rust mesh type for opt-in vertex deduplication. Default emission stays
    unwelded triangle soup so GPU consumers keep per-face flat normals;
    call sites that need a manifold mesh (volume queries, CSG, watertight
    checks) can opt in. Welding the duplex M_Fixed window drops vertex
    count from 180 → 48 (3.75×) and pushes manifold-edge fraction from
    32 % to 95 %. JS-side exposure is a separate follow-up.

## 1.16.10

### Patch Changes

- [#605](https://github.com/louistrue/ifc-lite/pull/605) [`1d6e99b`](https://github.com/louistrue/ifc-lite/commit/1d6e99bb23f67e20a192f362ba65ee73a8180f69) Thanks [@louistrue](https://github.com/louistrue)! - Fix the three Revit-door geometry defects called out in #604: opening-cut
  slivers when the opening's depth equals the host wall's depth, missing door
  handle hardware (`IfcAdvancedBrep` over `IfcSurfaceOfRevolution` and
  `IfcCylindricalSurface`), and broken door glazing. The opening extension now
  overshoots the wall by a unit-independent pad whose floor is strictly above
  the rectangular clipper's epsilon, surfaces of revolution are tessellated
  from their generator profile and recovered angular extent, and circular edge
  boundaries are sampled along the arc instead of collapsing to two-point
  loops.

- [#648](https://github.com/louistrue/ifc-lite/pull/648) [`b6e83d3`](https://github.com/louistrue/ifc-lite/commit/b6e83d3ac4f04fe7c439bf282a25963c6db0b909) Thanks [@louistrue](https://github.com/louistrue)! - Fix `IfcBooleanClippingResult` on walls clipped by `IfcPolygonalBoundedHalfSpace` (issue #635).

  Three related fixes that together restore correct geometry on walls whose body is a chained `IfcBooleanClippingResult`:

  1. **Round-window voids reach the post-clip mesh.** The `IfcOpeningElement` cut path now runs against the boolean-clipped wall mesh rather than the un-clipped extrusion, so windows and doors are subtracted from the actual visible wall body.
  2. **Polygonal-bounded half-space orientation.** The cutter prism is built by extruding the polygon along Position's Z-axis (per the IFC spec) instead of along the slope plane normal — gable walls #60012 and #67828 in AC20-FZK-Haus now narrow to a peak and span the full wall length at the bottom (was: inverted, point-down).
  3. **Chained polygonal half-space clips compose correctly.** When two `IfcPolygonalBoundedHalfSpace` cuts are stacked (one per gable side), the cutter prisms are now MERGED into a single mesh and applied in ONE BSP CSG op. Previously the first cut's output exceeded `MAX_CSG_POLYGONS_PER_MESH`, causing the second cut to silently drop and leaving a flat horizontal cap at the gable apex.

  Round-window opening profiles are also simplified before triangulation so AC20-style 36-segment circles fit under the CSG polygon budget instead of falling back to a square hole. CSG kernel diagnostics (`take_failures`) now surface every silent skip — including the `PolygonalBoundedHalfSpaceFallback` path — so callers can warn on geometry loss.

- [#644](https://github.com/louistrue/ifc-lite/pull/644) [`6f052c3`](https://github.com/louistrue/ifc-lite/commit/6f052c309a99edd1d9a6925d44bbc2aed6cd10a5) Thanks [@louistrue](https://github.com/louistrue)! - Add "Merge Multilayer Walls" load-time toggle (issue #540).

  When enabled, every `IfcBuildingElementPart` whose `IfcRelAggregates`
  parent wall (a) has its own `Representation` and (b) is sliceable in
  `MaterialLayerIndex` is suppressed during geometry emission. The parent
  wall's single swept solid keeps the per-layer sub-mesh colouring via the
  existing slicer, so the visual result on multilayer walls is the same as
  the layered render — but with one mesh per wall instead of N per-layer
  parts. Designed for large Revit-exported models where the per-layer
  extrusions inflate vertex counts beyond what the viewer can handle.

  New JS surface on `IfcAPI`:

  ```ts
  setMergeLayers(enabled: boolean): void
  ```

  Defaults to `false`. Honoured by `parseMeshes`, `parseMeshesSubset`,
  `parseMeshesAsync`, `parseMeshesInstanced`, `parseMeshesInstancedAsync`,
  `processGeometryBatch`, and `processGeometryBatchParallel`. The batch
  paths cache the parts-to-skip set on `IfcAPI` so workers build it once
  per content and reuse across every batch; the cache is cleared by
  `clearPrePassCache` and by `setMergeLayers`.

  Voids stay correct: `propagate_voids_to_parts` already copies the
  parent wall's `IfcRelVoidsElement` references onto its layer parts in
  the same pass that builds the part → parent map, so windows and doors
  still cut through the merged solid.

- [#575](https://github.com/louistrue/ifc-lite/pull/575) [`b8a8206`](https://github.com/louistrue/ifc-lite/commit/b8a82062c4392d05224561dda8a2767a8b7b1857) Thanks [@louistrue](https://github.com/louistrue)! - Add regression tests for non-box `IfcOpeningElement` classification (#547). PR #640 already routes low-tessellation non-rectangular openings (trapezoids, chamfered rectangles, beveled windows, coarse arcs) through CSG via `is_rectangular_box_mesh` + `infer_opening_frame`. This change adds end-to-end coverage that loads inline IFC fixtures and asserts the cut respects the actual opening profile (trapezoid narrow-edge boundary vertices appear in the voided wall, and many tessellated-box openings on a single wall are all cut without the CSG-budget cap silently dropping any).

## 1.16.9

### Patch Changes

- [#640](https://github.com/louistrue/ifc-lite/pull/640) [`8408c88`](https://github.com/louistrue/ifc-lite/commit/8408c88c4c0a1e848fade6c60474952eca1a4149) Thanks [@louistrue](https://github.com/louistrue)! - Fix diagonal and roof-window opening cuts. Oblique multilayer wall parts keep
  their opening soffits within the actual wall geometry, BRep roof openings
  preserve their full sloped opening frame instead of falling back to world axes,
  and roof windows on shallow-slope roofs are no longer routed through unstable
  full CSG by a too-aggressive "vertical extrusion ⇒ floor opening" heuristic —
  classification is now per-item based on whether the opening mesh is actually a
  clean rectangular box.

- [#641](https://github.com/louistrue/ifc-lite/pull/641) [`ba7553a`](https://github.com/louistrue/ifc-lite/commit/ba7553af693939896a840074999b5f6806a94815) Thanks [@louistrue](https://github.com/louistrue)! - Fix `IfcReinforcingBar` stirrup rendering (issue #631, sample
  `IfcReinforcingBar.ifc`).

  `IfcSweptDiskSolid` directrixes that use `IfcIndexedPolyCurve` over
  `IfcCartesianPointList3D` (typical for stirrups and other bent rebar that
  lives outside the XY plane) used to fall back to a 2D parser that read x/y
  from indices 0–1 and silently dropped the Z coordinate. The stirrup
  collapsed onto z=0 and the resulting tube was a flat near-degenerate line.

  The 3D curve dispatcher now has a native arm for `IfcIndexedPolyCurve` that
  reads `IfcCartesianPointList2D` (z=0) or `IfcCartesianPointList3D` verbatim
  and fits `IfcArcIndex` segments using a circumcircle in the plane of their
  three control points. Straight schema conformance — no spec deviation.

  The second sample on the issue (`Rebar2.ifc`) was already rendering its
  directrix correctly under the existing segment-index trim path; no change
  needed there.

## 1.16.8

### Patch Changes

- [#610](https://github.com/louistrue/ifc-lite/pull/610) [`f3d8b1d`](https://github.com/louistrue/ifc-lite/commit/f3d8b1d3d7c15488ebd0bdd2b44c0ed4cb25254a) Thanks [@louistrue](https://github.com/louistrue)! - Two follow-ups to the `IfcSweptDiskSolid` trim-param fix from #606, plus the rebuilt WASM artifact that actually lands the trim-param logic at runtime (CI does not rebuild the WASM binary; consumers were still on the pre-#606 binary).

  - **Junction-point dedup is now coordinate-aware.** When concatenating trimmed composite-curve segments, the previous implementation unconditionally dropped the first point of each subsequent segment — fine when adjacent segments share a coordinate-identical junction vertex, but it silently distorted directrices whose adjacent segments meet at non-coincident endpoints (model drift, mismatched cartesian points). The first point is now dropped only when it coincides with the last point already collected (`< 1e-6`), preserving the gap otherwise.

  - **Cross-section frame no longer flips at sharp bends.** `SweptDiskSolidProcessor` was re-picking the perpendicular `up` vector at every cross-section based on `tangent.x.abs() < 0.9`; consecutive tangents that straddled the threshold flipped the sign of `perp1`, so the same vertex index pointed to opposite angular positions on consecutive rings — visible as a twisted / flat-ribbon tube at L-bends and rebar hooks. Replaced with a Rotation-Minimising Frame: `up` is chosen once for the first sample, and each subsequent frame is propagated by the minimum rotation that aligns the previous tangent onto the current tangent (Rodrigues). Adds three unit tests covering straight-line invariance, 90° L-bend non-flip, and degenerate-input handling.

- [#606](https://github.com/louistrue/ifc-lite/pull/606) [`7d3a40b`](https://github.com/louistrue/ifc-lite/commit/7d3a40b5268491325b8496fc56181818b2141e6e) Thanks [@joepaddock-uk](https://github.com/joepaddock-uk)! - Honor `IfcSweptDiskSolid.StartParam` / `EndParam` for `IfcCompositeCurve` and `IfcPolyline` directrices. Previously these were silently ignored, so a swept disk solid like `IFCSWEPTDISKSOLID(#dir, 0.0095, $, 0., 1.)` with a 3-segment composite-curve directrix swept the entire curve instead of just segment `[0,1]` — most visible in rebar models authored by Revit/Tekla, where bars rendered 3-5× their real length with end hooks unfolded into the bar geometry.

  The dispatch now honors trim parameters for the two directrix types whose IFC parameterisation is unambiguous from the entity:

  - `IfcCompositeCurve` (and subtypes via `is_subtype_of`): segment-index based, each segment contributes 1.0 to the parameter.
  - `IfcPolyline`: point-index based, each segment between consecutive points contributes 1.0.

  Boundary segments are truncated by linear interpolation along the sampled polyline (exact for piecewise-linear input). Out-of-range params clamp; inverted ranges (`StartParam ≥ EndParam`) produce empty geometry. Other directrix types (`IfcLine`, `IfcCircle`, `IfcTrimmedCurve`, `IfcBSplineCurve`) still ignore trim — their parameterisations are length / angle / knot-based and need separate handling — flagged as a known limitation.

  Adds 11 unit tests in `profiles::tests` covering: full-range identity, exact-half boundaries, strict-interior comparisons, two-point partial trim, fractional multi-segment trim with dedup, out-of-range clamping, inverted ranges, `SameSense=F` reverse-then-trim semantics, and direct-polyline-directrix paths.

## 1.16.7

### Patch Changes

- [#596](https://github.com/louistrue/ifc-lite/pull/596) [`945bb30`](https://github.com/louistrue/ifc-lite/commit/945bb30061ca044f4a51001f7299c17350ce99cf) Thanks [@louistrue](https://github.com/louistrue)! - Render `IfcSolarDevice` (and any future `IfcEnergyConversionDevice` / `IfcDistributionElement` subtype) without code changes.

  The geometry pipeline previously gated entities through a hand-maintained leaf-level whitelist (`has_geometry_by_name`) and a hand-maintained leaf-level "secondary priority" blacklist (`is_simple_geometry_type`). New IFC4X3 subtypes silently fell through both — `IfcSolarDevice`, which inherits from `IfcEnergyConversionDevice`, was the latest casualty (PR #585).

  Both functions now derive their answer from the EXPRESS inheritance graph via `IfcType::is_subtype_of`, so any subtype of an already-supported parent is picked up automatically. The legacy IFC2x3 / removed-in-IFC4x3 names not in the modern enum are resolved through the existing `legacy_entities` registry, which already carries a `has_geometry` flag per entry.

  `has_geometry_by_name` also moved out of `rust/core/src/generated/schema.rs` (which is marked "DO NOT EDIT — auto-generated") into a new sibling module `schema_helpers.rs`, so a future re-run of `@ifc-lite/codegen` won't wipe it.

  Co-authored with @geronimi73 (PR #585).

- [#572](https://github.com/louistrue/ifc-lite/pull/572) [`18c6a37`](https://github.com/louistrue/ifc-lite/commit/18c6a37f1cc1426daa32ee60457dd0580a5257f5) Thanks [@louistrue](https://github.com/louistrue)! - Restore inner reveal faces for window and door openings cut from walls, with axis-clamped quads that work for any wall orientation. Rebuilds the WASM bundle with the new reveal generation and defensive guards (full cross-axis overlap check + orthogonal-axis clamp) so multi-layer wall sub-meshes never receive floating reveal quads and skipped openings from the triangle-cap safety path don't leave phantom interior faces.

## 1.16.6

### Patch Changes

- [#563](https://github.com/louistrue/ifc-lite/pull/563) [`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966) Thanks [@louistrue](https://github.com/louistrue)! - Slice single-solid walls by `IfcMaterialLayerSetUsage` so each layer renders in its own material colour. Sub-millimetre layers fold into their thicker neighbour so the clipper never sees degenerate interfaces, and slicing bails cleanly when the representation isn't a single item with an identity Position (multi-item reps, MappedItems, or translated extrusions fall through to the unsliced path).

- [#563](https://github.com/louistrue/ifc-lite/pull/563) [`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966) Thanks [@louistrue](https://github.com/louistrue)! - Subtract voids per sub-mesh so multi-layer walls keep their layer colours after opening cuts (#541). Previously merging the void subtraction onto the combined mesh collapsed all per-item style information, so doors and windows in material-segmented walls came out uniformly coloured.

## 1.16.5

### Patch Changes

- [#565](https://github.com/louistrue/ifc-lite/pull/565) [`7000011`](https://github.com/louistrue/ifc-lite/commit/7000011d6eb372c2dadf7c82f6e76a0583c6abc1) Thanks [@louistrue](https://github.com/louistrue)! - Rebuild WASM bindings for model-level RTC and georeferenced federation alignment fixes.

## 1.16.4

### Patch Changes

- [#519](https://github.com/louistrue/ifc-lite/pull/519) [`643b30f`](https://github.com/louistrue/ifc-lite/commit/643b30ff031d389fe0cb1caf7de6989d79629e4b) Thanks [@louistrue](https://github.com/louistrue)! - Fix geometry processing hang on models with 500K+ geometry elements

  Cache entity index from buildPrePassOnce and reuse it across processGeometryBatch calls, eliminating redundant full-file scans. Cap batch count at 30 to prevent excessive per-batch overhead for models with very high geometry element counts.

## 1.16.3

### Patch Changes

- [#526](https://github.com/louistrue/ifc-lite/pull/526) [`cb59771`](https://github.com/louistrue/ifc-lite/commit/cb59771997e3837a511f584842bce98cd710864e) Thanks [@louistrue](https://github.com/louistrue)! - Restore toNativeBuffer in native-bridge and add Tauri stub aliases to desktop vite config.

## 1.16.2

### Patch Changes

- [#502](https://github.com/louistrue/ifc-lite/pull/502) [`05fd49f`](https://github.com/louistrue/ifc-lite/commit/05fd49f3fded214c5c5f59c61b0b55fcb7457f7b) Thanks [@louistrue](https://github.com/louistrue)! - Fix large direct `GeometryProcessor.processStreaming()` and `processInstancedStreaming()` calls by switching oversized IFC inputs to the existing byte-based WASM pre-pass and batch pipeline instead of decoding the entire file into a single JavaScript string first, and expose the supporting byte-based instanced batch API from `@ifc-lite/wasm`.

## 1.16.1

### Patch Changes

- [#474](https://github.com/louistrue/ifc-lite/pull/474) [`7a1aeb7`](https://github.com/louistrue/ifc-lite/commit/7a1aeb7fabdb4b9692d02186fe4254fc561bece4) Thanks [@louistrue](https://github.com/louistrue)! - Fix advanced face tessellation: add rational B-spline (NURBS) weight support, SameSense winding correction, and knot vector validation

## 1.16.0

### Minor Changes

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Add LOD geometry generation, profile projection for 2D drawings, and streaming server integration

### Patch Changes

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Fix I-beam profile shading with corrected circular profile detection threshold, two-sided lighting, and winding reversal for mirrored profiles

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Fix IFC4X3 RTC offset detection by using both simple and complex geometry jobs for sampling

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Fix multilayer wall parts not getting window/door cutouts by propagating void relationships from parent walls to child IfcBuildingElementPart entities

## 1.15.0

### Minor Changes

- [#439](https://github.com/louistrue/ifc-lite/pull/439) [`a672eec`](https://github.com/louistrue/ifc-lite/commit/a672eec196ec77b0229b0953f9a1b59991f814a6) Thanks [@louistrue](https://github.com/louistrue)! - Remove wasm-bindgen-rayon thread infrastructure and rebuild WASM binary without atomics/shared-memory. Pin wasm-bindgen to 0.2.106. Add `parseMeshesSubset`, `buildPrePassOnce`, and `processGeometryBatch` APIs for parallel Web Worker geometry processing. Enable WASM SIMD128 for faster geometry math. Fix exponential triangle growth in rectangular opening clipping by merging adjacent openings. Add NaN guards and bounds checks in clipping code. Reduce boolean recursion depth limit to prevent stack overflow.

## 1.14.6

### Patch Changes

- [#432](https://github.com/louistrue/ifc-lite/pull/432) [`113bafc`](https://github.com/louistrue/ifc-lite/commit/113bafc07436c809a8cb24d8682cf63ae5ed99e9) Thanks [@louistrue](https://github.com/louistrue)! - Regenerate the WASM bindings with support for `IfcDerivedProfileDef` and `IfcMirroredProfileDef` profile transforms so derived swept profiles render correctly.

- [#432](https://github.com/louistrue/ifc-lite/pull/432) [`113bafc`](https://github.com/louistrue/ifc-lite/commit/113bafc07436c809a8cb24d8682cf63ae5ed99e9) Thanks [@louistrue](https://github.com/louistrue)! - Include the generated `pkg/snippets` worker helper files in the published `@ifc-lite/wasm` package so bundlers can resolve the wasm-bindgen rayon import at runtime.

## 1.14.5

### Patch Changes

- [#411](https://github.com/louistrue/ifc-lite/pull/411) [`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515) Thanks [@louistrue](https://github.com/louistrue)! - Fix large model loading with streaming columnar parser, inline scan worker, and improved geometry bridge. Refactor relationship graph for better memory efficiency and add spatial index builder utilities.

- [#412](https://github.com/louistrue/ifc-lite/pull/412) [`f0da00c`](https://github.com/louistrue/ifc-lite/commit/f0da00c162f2713ed9144691d52c75a21faa18dd) Thanks [@louistrue](https://github.com/louistrue)! - Refactor void clipping helpers, material styling, and submesh color resolution for improved readability and maintainability.

## 1.14.4

### Patch Changes

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Fix arc angle wrapping for profiles crossing the 0°/360° boundary

## 1.14.3

### Patch Changes

- [#330](https://github.com/louistrue/ifc-lite/pull/330) [`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45) Thanks [@louistrue](https://github.com/louistrue)! - Remove the unused `@ifc-lite/parser` runtime dependency from `@ifc-lite/mutations`, switch `@ifc-lite/server-bin` postinstall to a safe ESM dynamic import, and refresh the published `@ifc-lite/wasm` bindings and binary so the npm package stays in sync with the current Rust sources.

## 1.14.2

## 1.14.1

### Patch Changes

- [#283](https://github.com/louistrue/ifc-lite/pull/283) [`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607) Thanks [@louistrue](https://github.com/louistrue)! - fix: support large IFC files (700MB+) in geometry streaming

  - Add error handling to `collectInstancedGeometryStreaming()` to prevent infinite hang when WASM fails
  - Add adaptive batch sizing for large files in `processInstancedStreaming()`
  - Add 0-result detection warnings when WASM returns no geometry
  - Replace `content.clone()` with `Option::take()` in all async WASM methods to halve peak memory usage

## 1.14.0

## 1.13.0

## 1.12.0

## 1.11.3

## 1.11.1

## 1.11.0

### Patch Changes

- [#232](https://github.com/louistrue/ifc-lite/pull/232) [`ca7fd20`](https://github.com/louistrue/ifc-lite/commit/ca7fd2015923e5a1a330ccbc4e95d259f9ce9c6f) Thanks [@louistrue](https://github.com/louistrue)! - Fix window rendering and interaction regressions for multi-part tessellated elements. The WASM geometry pipeline now correctly triangulates `IfcIndexedPolygonalFaceWithVoids` (including inner loops) and respects optional `PnIndex` remapping, restoring correct window cutouts and subelement colors. Renderer picking, CPU raycasting, and selected-mesh lazy creation now handle all submesh pieces per element/model instead of collapsing to a single piece, and selected highlights are rendered after transparent passes so glass receives the same selection highlight as frames.

## 1.10.0

### Minor Changes

- [#203](https://github.com/louistrue/ifc-lite/pull/203) [`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8) Thanks [@louistrue](https://github.com/louistrue)! - Add visual enhancement post-processing (contact shading, separation lines, edge contrast) and fix geometry parsing / entity type resolution

  **Renderer — visual enhancements:**

  - Add fullscreen post-processing pass (`PostProcessor`) with depth-based contact shading and object-ID-based separation lines for improved visual clarity between adjacent elements
  - Add configurable edge contrast enhancement via shader uniforms with adjustable intensity
  - New `VisualEnhancementOptions` API with independent quality presets (`off` / `low` / `high`), intensity, and radius for contact shading, separation lines, and edge contrast
  - Automatically disable expensive effects on mobile devices

  **Renderer — render pipeline changes:**

  - Add second render target (`rgba8unorm` object ID texture) to all render pipelines (opaque, transparent, overlay, instanced) for per-entity boundary detection
  - Expand vertex format from 6 to 7 floats (position + normal + entityId) across all pipelines and the picker
  - Encode entity IDs into the object ID texture via 24-bit RGB encoding in fragment shaders
  - Depth texture now created with `TEXTURE_BINDING` usage for post-processor sampling
  - Edge contrast rendering made conditional via uniform flags (`flags.z` / `flags.w`) instead of always-on

  **Renderer — geometry & scene:**

  - `GeometryManager` interleaves entity ID into the 7th float of each vertex buffer
  - `Scene` batching writes entity IDs per-vertex into merged buffers for instanced rendering

  **Data — entity type system expansion:**

  - Add ~30 new `IfcTypeEnum` entries: chimney, shading device, building element part, element assembly, reinforcing bar/mesh/tendon, discrete accessory, mechanical fastener, flow controller/moving device/storage device/treatment device/energy conversion device, duct/pipe/cable segments, furniture, proxy, annotation, transport element, civil element, geographic element
  - Add ~11 new type definition enums: pile type, member type, plate type, footing type, covering type, railing type, stair type, ramp type, roof type, curtain wall type, building element proxy type
  - Map `*StandardCase` variants (e.g. `IFCSLABSTANDARDCASE`, `IFCCOLUMNSTANDARDCASE`) to their base enum values for correct grouping
  - Expand `TYPE_STRING_TO_ENUM` and `TYPE_ENUM_TO_STRING` maps with all new types
  - Add new `ifc-entity-names.ts` with 888-line UPPERCASE → PascalCase lookup table (all IFC4X3 entity names) for correct display of any IFC entity type
  - Add `rawTypeName` field to `EntityTableBuilder` storing normalized type name as string index
  - `getTypeName()` now falls back to `rawTypeName` for types not in the enum, eliminating "Unknown" display for valid IFC types

  **Parser:**

  - Add diagnostic `console.debug` logging for spatial entity extraction and `console.warn` on extraction failures

  **WASM / Rust geometry engine:**

  - Replace overly broad geometry entity filter (`starts_with("IFC") && !ends_with("TYPE") && ...`) with explicit whitelist of ~120 IfcProduct subtypes in `has_geometry_by_name`, preventing non-product entities (e.g. `IfcDimensionalExponents`, `IfcSurfaceStyleRendering`) from being sent to geometry processing
  - Add `SolidModel` to the accepted representation types in the geometry router (6 match arms)
  - Use smooth per-vertex normals for extruded circular profiles (cylinder side walls) with `is_approximately_circular_profile` heuristic that detects circular vs polygonal profiles by coefficient of variation of radii from centroid
  - Increase circle tessellation from 24 to 36 segments for profiles (circle, circle hollow, trimmed curve, ellipse)
  - Increase swept disk solid tube segments from 12 to 24 for smoother pipes
  - Fix `PolygonalFaceSet` processing: generate flat-shaded meshes with per-face normals via `build_flat_shaded_mesh` and fix closed-shell winding orientation via `orient_closed_shell_outward`
  - Improve geometry extraction statistics: separate "no representation" (expected) from actual processing failures in diagnostic logging
  - Add `console.debug` logging for entities skipped due to missing representation

  **Viewer app:**

  - Add visual enhancement state to Zustand UI slice with 10 configurable properties (enabled, edge contrast enabled/intensity, contact shading quality/intensity/radius, separation lines enabled/quality/intensity/radius)
  - Wire `VisualEnhancementOptions` through `Viewport`, `useAnimationLoop`, and `useRenderUpdates` via memoized ref pattern
  - Show IFC type name instead of "Unknown" for spatial entities with generic names in the tree hierarchy
  - Expand `useThemeState` hook with all visual enhancement selectors

## 1.9.0

## 1.8.0

## 1.7.0

## 1.5.0

### Minor Changes

- [#162](https://github.com/louistrue/ifc-lite/pull/162) [`463e7c9`](https://github.com/louistrue/ifc-lite/commit/463e7c934abc2fccd0a35a8eab04fbae47185259) Thanks [@louistrue](https://github.com/louistrue)! - Add symbolic representation support for 2D drawings

  - **New Feature**: Added `parseSymbolicRepresentations` WASM API to extract 2D Plan, Annotation, and FootPrint representations from IFC files
  - **New Feature**: Section2DPanel now supports toggling between section cuts and symbolic representations (architectural floor plans)
  - **New Feature**: Added hybrid mode that combines section cuts with symbolic representations
  - **New Feature**: Building rotation detection from IfcSite placement for proper floor plan orientation
  - **Enhancement**: RTC offset streaming events for better coordinate handling in large models
  - **Enhancement**: Geometry processor now reports building rotation in coordinate info
  - **Types**: Added `SymbolicRepresentationCollection`, `SymbolicPolyline`, `SymbolicCircle` types

## 1.3.0

### Minor Changes

- [#139](https://github.com/louistrue/ifc-lite/pull/139) [`0c1a262`](https://github.com/louistrue/ifc-lite/commit/0c1a262d971af4a1bc2c97d41258aa6745fef857) Thanks [@louistrue](https://github.com/louistrue)! - Add PolygonalFaceSetProcessor and surface model processors for improved geometry support

  ### New Geometry Processors

  - **PolygonalFaceSetProcessor**: Handle IfcPolygonalFaceSet with triangulation of arbitrary polygons
  - **FaceBasedSurfaceModelProcessor**: Process IfcFaceBasedSurfaceModel geometry
  - **SurfaceOfLinearExtrusionProcessor**: Handle IfcSurfaceOfLinearExtrusion surfaces
  - **ShellBasedSurfaceModelProcessor**: Process IfcShellBasedSurfaceModel geometry

  ### Performance Optimizations

  - Add fast-path decoder functions with point caching for BREP-heavy files (~2x faster)
  - Add `get_first_entity_ref_fast`, `get_polyloop_coords_fast`, `get_polyloop_coords_cached`
  - Add `has_non_null_attribute()` for fast attribute filtering
  - Optimize FacetedBrep with fast-path using `get_face_bound_fast`
  - Add WASM-specific sequential iteration to avoid threading overhead

### Patch Changes

- [#119](https://github.com/louistrue/ifc-lite/pull/119) [`fe4f7ac`](https://github.com/louistrue/ifc-lite/commit/fe4f7aca0e7927d12905d5d86ded7e06f41cb3b3) Thanks [@louistrue](https://github.com/louistrue)! - Fix WASM safety, improve DX, and add test infrastructure

  - Replace 60+ unsafe unwrap() calls with safe JS interop helpers in WASM bindings
  - Clean console output with single summary line per file load
  - Pure client-side by default (no CORS errors in production)
  - Add unit tests for StringTable, GLTFExporter, store slices
  - Add WASM contract tests and integration pipeline tests
  - Fix TypeScript any types and data corruption bugs

- [#117](https://github.com/louistrue/ifc-lite/pull/117) [`4bf4931`](https://github.com/louistrue/ifc-lite/commit/4bf4931181d1c9867a5f0f4803972fa5a3178490) Thanks [@louistrue](https://github.com/louistrue)! - Fix multi-material rendering and enhance CSG operations

  ### Multi-Material Rendering

  - Windows now correctly render with transparent glass panels and opaque frames
  - Doors now render all submeshes including inner framing with correct colors
  - Fixed mesh deduplication in Viewport that was filtering out submeshes sharing the same expressId
  - Added SubMesh and SubMeshCollection types to track per-geometry-item meshes for style lookup

  ### CSG Operations

  - Added union and intersection mesh operations for full boolean CSG support
  - Improved CSG clipping with degenerate triangle removal to eliminate artifacts
  - Enhanced bounds overlap detection for better performance
  - Added cleanup of triangles inside opening bounds to remove CSG artifacts

- [#135](https://github.com/louistrue/ifc-lite/pull/135) [`07558fc`](https://github.com/louistrue/ifc-lite/commit/07558fc4aa91245ef0f9c31681ec84444ec5d80e) Thanks [@louistrue](https://github.com/louistrue)! - Fix RTC (Relative To Center) coordinate handling consistency

  **BREAKING**: Rename `isGeoReferenced` to `hasLargeCoordinates` in CoordinateInfo interface.
  Large coordinates do NOT mean a model is georeferenced. Proper georeferencing uses IfcMapConversion.

  - Rename isGeoReferenced → hasLargeCoordinates across all packages (geometry, cache, export, viewer)
  - Fix transform_mesh to apply RTC uniformly per-mesh (not per-vertex) preventing mixed coordinates
  - Fix coordinate-handler.ts threshold consistency between bounds calculation and vertex cleanup
  - Fix streaming path originalBounds reconstruction by undoing server-applied shift
  - Surface RTC offset in GpuGeometry struct with JS-accessible getters (rtcOffsetX/Y/Z, hasRtcOffset)
  - Add RTC detection and offset handling to parseToGpuGeometryAsync
  - Include RTC offset in GPU async completion stats
  - Add comprehensive coordinate handling documentation

## 1.2.1

### Patch Changes

- Version sync with @ifc-lite packages

## 1.2.0

### Minor Changes

- f4fbf8c: ### New Features

  - **2D Profile-Level Boolean Operations**: Implemented efficient 2D polygon boolean operations for void subtraction at the profile level before extrusion. This provides 10-25x performance improvement over 3D CSG operations for most openings and produces cleaner geometry with fewer degenerate triangles.

  - **Void Analysis and Classification**: Added intelligent void classification system that distinguishes between coplanar voids (can be handled efficiently in 2D) and non-planar voids (require 3D CSG). This enables optimal processing strategy selection.

  - **Enhanced Void Handling**: Improved void subtraction in extrusions with support for both full-depth and partial-depth voids, including segmented extrusion for complex void configurations.

  ### Improvements

  - **WASM Compatibility**: Replaced `clipper2` (C++ dependency) with `i_overlay` (pure Rust) for WASM builds, eliminating C++ compilation issues and ensuring reliable WASM builds.

  - **Performance**: Profile-level void subtraction is significantly faster than 3D CSG operations, especially for floors/slabs with many penetrations.

- ed8f77b: ### New Features

  - **IFC5 (IFCX) Format Support**: Added full support for IFC5/IFCX file format parsing, enabling compatibility with the latest IFC standard
  - **IFCX Property/Quantity Display**: Enhanced viewer to properly display IFCX properties and quantities
  - **IFCX Coordinate System Handling**: Fixed coordinate system transformations for IFCX files

  ### Bug Fixes

  - **Fixed STEP Escaping**: Corrected STEP file escaping issues that affected IFCX parsing
  - **Fixed IFC Type Names**: Improved IFC type name handling for better compatibility

- f4fbf8c: ### New Features

  - **Type visibility controls**: Toggle visibility of spatial elements (IfcSpace, IfcOpeningElement, IfcSite) in the viewer toolbar
  - **Enhanced CSG operations**: Improved boolean geometry operations using the `csgrs` library for better performance and accuracy
  - **Full IFC4X3 schema support**: Migrated to generated schema with all 876 IFC4X3 types

  ### Bug Fixes

  - **Fixed unit conversion**: Files using millimeters (.MILLI. prefix) now render at correct scale instead of 1000x too large
  - **Fixed IFCPROJECT detection**: Now scans entire file to find IFCPROJECT instead of only first 100 entities, fixing issues with large IFC files

- ed8f77b: ### Performance Improvements

  - **Lite Parsing Mode**: Added optimized parsing mode for large files (>100MB) with 5-10x faster parsing performance
  - **On-Demand Property Extraction**: Implemented on-demand property extraction for instant property access, eliminating upfront table building overhead
  - **Fast Semicolon Scanner**: Added high-performance semicolon-based scanner for faster large file processing
  - **Single-Pass Data Extraction**: Optimized to single-pass data extraction for improved parsing speed
  - **Async Yields**: Added async yields during data parsing to prevent UI blocking
  - **Bulk Array Extraction**: Optimized data model decoding with bulk array extraction for better performance
  - **Dynamic Batch Sizing**: Implemented dynamic batch sizing for improved performance in IFC processing with adaptive batch sizes based on file size

  ### New Features

  - **On-Demand Parsing Mode**: Consolidated to single on-demand parsing mode for better memory efficiency
  - **Targeted Spatial Parsing**: Added targeted spatial parsing in lite mode for efficient hierarchy building

  ### Bug Fixes

  - **Fixed Relationship Graph**: Added DefinesByProperties to relationship graph in lite mode
  - **Fixed On-Demand Maps**: Improved forward relationship lookup for rebuilding on-demand maps
  - **Fixed Property Extraction**: Restored on-demand property extraction when loading from cache

- f7133a3: ### Performance Improvements

  - **Zero-copy WASM memory to WebGPU upload**: Implemented direct memory access from WASM linear memory to WebGPU buffers, eliminating intermediate JavaScript copies. This provides 60-70% reduction in peak RAM usage and 40-50% faster geometry-to-GPU pipeline.

  - **Optimized cache and spatial hierarchy**: Eliminated O(n²) lookups in cache and spatial hierarchy builder, implemented instant cache lookup with larger batches, and optimized batch streaming for better performance.

  - **Parallelized data model parsing**: Added parallel processing for data model parsing and streaming of cached geometry with deferred hash computation and yielding before heavy decode operations.

  ### New Features

  - **Zero-copy benchmark suite**: Added comprehensive benchmark suite to measure zero-copy performance improvements and identify bottlenecks.

  - **GPU geometry API**: Added new GPU-ready geometry API with pre-interleaved vertex data, pre-converted coordinates, and pointer-based direct WASM memory access.

  ### Bug Fixes

  - **Fixed O(n²) batch recreation**: Eliminated inefficient batch recreation in zero-copy streaming pipeline.

  - **Updated WASM and TypeScript definitions**: Updated WASM bindings and TypeScript definitions for geometry classes to support zero-copy operations.

### Patch Changes

- ed8f77b: ### Bug Fixes

  - **Fixed Color Parsing**: Fixed TypedValue wrapper handling in color parsing
  - **Fixed Storey Visibility**: Fixed storey visibility toggle functionality
  - **Fixed Background Property Parsing**: Added background property parsing support
  - **Fixed Geometry Support**: Added IfcSpace/Opening/Site geometry support
  - **Fixed TypeScript Generation**: Fixed TypeScript generation from EXPRESS schema types
  - **Fixed Renderer Safeguards**: Added renderer safeguards for proper IFC type names

- ### Bug Fixes

  - **Fixed IFC elevation units**: IFC files store elevation values in the file's native units (e.g., mm), but they were being displayed as meters without conversion. Now properly extracts and applies length unit scale from IFCPROJECT -> IFCUNITASSIGNMENT -> IFCSIUNIT/IFCCONVERSIONBASEDUNIT, supporting SI prefixes (MILLI, CENTI, etc.) and imperial units (FOOT, INCH).
  - **Fixed IFCMEASUREWITHUNIT scale**: When extracting conversion factors from IFCMEASUREWITHUNIT, the ValueComponent is now correctly multiplied by the UnitComponent's scale factor (e.g., INCH defined as 25.4mm = 0.0254m).
  - **Fixed missing IFCUNITASSIGNMENT handling**: Added guards against missing IFCUNITASSIGNMENT attributes to prevent parsing errors.

- ### Improvements

  - **Optimized WASM build configuration**: Removed unnecessary compilation flags and streamlined WASM build process for better performance and smaller binary size (~10% reduction).
  - **Improved WASM memory management**: Enhanced WASM JavaScript bindings for better memory management and performance.
  - **Removed unused threading dependencies**: Removed unused rayon threading imports and configurations, simplifying the WASM package.
  - **Simplified Vite configuration**: Refactored Vite configuration for WASM handling, removing unnecessary file copying and exclusion logic.

## 1.2.0

### Minor Changes

- [#39](https://github.com/louistrue/ifc-lite/pull/39) [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **2D Profile-Level Boolean Operations**: Implemented efficient 2D polygon boolean operations for void subtraction at the profile level before extrusion. This provides 10-25x performance improvement over 3D CSG operations for most openings and produces cleaner geometry with fewer degenerate triangles.

  - **Void Analysis and Classification**: Added intelligent void classification system that distinguishes between coplanar voids (can be handled efficiently in 2D) and non-planar voids (require 3D CSG). This enables optimal processing strategy selection.

  - **Enhanced Void Handling**: Improved void subtraction in extrusions with support for both full-depth and partial-depth voids, including segmented extrusion for complex void configurations.

  ### Improvements

  - **WASM Compatibility**: Replaced `clipper2` (C++ dependency) with `i_overlay` (pure Rust) for WASM builds, eliminating C++ compilation issues and ensuring reliable WASM builds.

  - **Performance**: Profile-level void subtraction is significantly faster than 3D CSG operations, especially for floors/slabs with many penetrations.

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **IFC5 (IFCX) Format Support**: Added full support for IFC5/IFCX file format parsing, enabling compatibility with the latest IFC standard
  - **IFCX Property/Quantity Display**: Enhanced viewer to properly display IFCX properties and quantities
  - **IFCX Coordinate System Handling**: Fixed coordinate system transformations for IFCX files

  ### Bug Fixes

  - **Fixed STEP Escaping**: Corrected STEP file escaping issues that affected IFCX parsing
  - **Fixed IFC Type Names**: Improved IFC type name handling for better compatibility

- [#39](https://github.com/louistrue/ifc-lite/pull/39) [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **Type visibility controls**: Toggle visibility of spatial elements (IfcSpace, IfcOpeningElement, IfcSite) in the viewer toolbar
  - **Enhanced CSG operations**: Improved boolean geometry operations using the `csgrs` library for better performance and accuracy
  - **Full IFC4X3 schema support**: Migrated to generated schema with all 876 IFC4X3 types

  ### Bug Fixes

  - **Fixed unit conversion**: Files using millimeters (.MILLI. prefix) now render at correct scale instead of 1000x too large
  - **Fixed IFCPROJECT detection**: Now scans entire file to find IFCPROJECT instead of only first 100 entities, fixing issues with large IFC files

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### Performance Improvements

  - **Lite Parsing Mode**: Added optimized parsing mode for large files (>100MB) with 5-10x faster parsing performance
  - **On-Demand Property Extraction**: Implemented on-demand property extraction for instant property access, eliminating upfront table building overhead
  - **Fast Semicolon Scanner**: Added high-performance semicolon-based scanner for faster large file processing
  - **Single-Pass Data Extraction**: Optimized to single-pass data extraction for improved parsing speed
  - **Async Yields**: Added async yields during data parsing to prevent UI blocking
  - **Bulk Array Extraction**: Optimized data model decoding with bulk array extraction for better performance
  - **Dynamic Batch Sizing**: Implemented dynamic batch sizing for improved performance in IFC processing with adaptive batch sizes based on file size

  ### New Features

  - **On-Demand Parsing Mode**: Consolidated to single on-demand parsing mode for better memory efficiency
  - **Targeted Spatial Parsing**: Added targeted spatial parsing in lite mode for efficient hierarchy building

  ### Bug Fixes

  - **Fixed Relationship Graph**: Added DefinesByProperties to relationship graph in lite mode
  - **Fixed On-Demand Maps**: Improved forward relationship lookup for rebuilding on-demand maps
  - **Fixed Property Extraction**: Restored on-demand property extraction when loading from cache

- [#52](https://github.com/louistrue/ifc-lite/pull/52) [`f7133a3`](https://github.com/louistrue/ifc-lite/commit/f7133a31320fdb8e8744313f46fbfe1718f179ff) Thanks [@louistrue](https://github.com/louistrue)! - ### Performance Improvements

  - **Zero-copy WASM memory to WebGPU upload**: Implemented direct memory access from WASM linear memory to WebGPU buffers, eliminating intermediate JavaScript copies. This provides 60-70% reduction in peak RAM usage and 40-50% faster geometry-to-GPU pipeline.

  - **Optimized cache and spatial hierarchy**: Eliminated O(n²) lookups in cache and spatial hierarchy builder, implemented instant cache lookup with larger batches, and optimized batch streaming for better performance.

  - **Parallelized data model parsing**: Added parallel processing for data model parsing and streaming of cached geometry with deferred hash computation and yielding before heavy decode operations.

  ### New Features

  - **Zero-copy benchmark suite**: Added comprehensive benchmark suite to measure zero-copy performance improvements and identify bottlenecks.

  - **GPU geometry API**: Added new GPU-ready geometry API with pre-interleaved vertex data, pre-converted coordinates, and pointer-based direct WASM memory access.

  ### Bug Fixes

  - **Fixed O(n²) batch recreation**: Eliminated inefficient batch recreation in zero-copy streaming pipeline.

  - **Updated WASM and TypeScript definitions**: Updated WASM bindings and TypeScript definitions for geometry classes to support zero-copy operations.

### Patch Changes

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### Bug Fixes

  - **Fixed Color Parsing**: Fixed TypedValue wrapper handling in color parsing
  - **Fixed Storey Visibility**: Fixed storey visibility toggle functionality
  - **Fixed Background Property Parsing**: Added background property parsing support
  - **Fixed Geometry Support**: Added IfcSpace/Opening/Site geometry support
  - **Fixed TypeScript Generation**: Fixed TypeScript generation from EXPRESS schema types
  - **Fixed Renderer Safeguards**: Added renderer safeguards for proper IFC type names
