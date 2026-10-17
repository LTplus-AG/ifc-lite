# Rust review — full finding index

Generated from the per-area files. 622 findings (some cross-reported by two reviewers; see REPORT.md for the deduplicated themes). Columns: severity, ID, category, confidence, effort, title, file with full detail.

## High (82)

| ID | Category | Conf. | Effort | Title | File |
|---|---|---|---|---|---|
| ROUTER-1 | DRY | CONFIRMED | M | Representation-chain walk re-implemented 10× (and drifted) | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-2 | DRY | CONFIRMED | M | The mapped-source item walk exists four times ("the four walks") and three of them bypass the item pipeline | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-21 | Perf | CONFIRMED | M | Every opening is meshed 3–5× per host during classification | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-3 | DRY | CONFIRMED | S | Axis2Placement3D / CartesianPoint / Direction parsers forked 4× with behavioural drift | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-33 | Maintainability | CONFIRMED | L | God functions and a 3,116-line file | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-4 | DRY | CONFIRMED | S | "Unwrap mapped/boolean chain to IfcExtrudedAreaSolid" walk ×4 | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-5 | DRY | CONFIRMED | M | Nine "edge-pairing closed-surface" walks | [01-geometry-router.md](01-geometry-router.md) |
| PROC-1 | DRY | CONFIRMED | M | `IfcAxis2Placement3D` / `IfcCartesianPoint` / `IfcDirection` decoding is implemented ~14 times and the copies have drifted | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-2 | Bug | CONFIRMED | M | `profile_extractor.rs` is a parallel element→placement→mapped-item→extrusion pipeline that has already drifted from the mesh path (misplaces linear/grid-placed elements) | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-3 | Bug | CONFIRMED | S | `IfcTriangulatedFaceSet` ignores `PnIndex` while `IfcPolygonalFaceSet` honours it | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-4 | Bug | CONFIRMED | M | `RevolvedAreaSolidProcessor` revolves only `profile.outer`; holes are dropped and winding ignores profile orientation | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-S1 | DRY | CONFIRMED | L | Three independent IFC curve samplers that have drifted (plus a polyline-only PBHS boundary parser) | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S2 | Bug | CONFIRMED | S | Spurious `(0,0,0)` point appended to every clamped B-spline sampled by `sample_curve_polyline` | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S3 | DRY | CONFIRMED | M | Face-bound classification and loop extraction exist 3 times with different outer-ring rules | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S4 | DRY | CONFIRMED | M | Planar-face triangulation exists 3 times; the faceted copy's fast paths drifted from `triangulate_polygon` | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| KERNEL-1 | DRY | CONFIRMED | L | The exact-predicate tiers (interval / fixed / BigRational / cached-lambda) are three to four hand-written copies of the same formulas | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-2 | DRY | CONFIRMED | M | Open-edge / closure counting has about 30 copies with incompatible definitions | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-3 | DRY | CONFIRMED | S | Constants derived from `SNAP_GRID` are re-declared independently in four kernel files | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| GEOM-1 | DRY | CONFIRMED | M | Inline IfcCartesianPoint / IfcDirection coordinate decoding duplicated ~48 times across crates | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-2 | DRY | CONFIRMED | M | Nine IfcAxis2Placement3D attribute readers, already drifted (Location `$`, error swallowing, fast-path fallback) | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-3 | Bug | CONFIRMED | S | `calculate_polygon_normal` returns a reversed normal for concave quads; faceted fast path fans concave quads across the outside diagonal | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-4 | DRY | CONFIRMED | M | `read_fixture` re-implemented 28 times (27 distinct bodies); `IFC_LITE_REQUIRE_FIXTURES` honoured only by ~37 files | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-5 | DRY | CONFIRMED | M | Test mesh oracles (volume, open edges, watertight, bbox) duplicated 80+ times with different keying/tolerances | [04-geometry-misc.md](04-geometry-misc.md) |
| PROCESSING-1 | DRY | CONFIRMED | M | STEP-keyword scan dispatch implemented six times across native and wasm | [05-processing.md](05-processing.md) |
| PROCESSING-2 | DRY | CONFIRMED | M | The #957/#1623 type-geometry plan (referenced RepresentationMaps, instantiated type ids, mapped-instance plan, type candidates) is computed three different ways | [05-processing.md](05-processing.md) |
| PROCESSING-3 | DRY | CONFIRMED | S | wasm `styling/color.rs` is a verbatim copy of `element/element_color.rs`'s walks, despite processing exposing the closure-form API for exactly that caller | [05-processing.md](05-processing.md) |
| PROCESSING-4 | Bug | LIKELY | S | Element-level material fallback colour drifts between native ("first opaque") and wasm ("first colour") | [05-processing.md](05-processing.md) |
| PROCESSING-5 | Bug | CONFIRMED | S | `apps/server` has its own `detect_schema_version` that disagrees with processing's | [05-processing.md](05-processing.md) |
| PROCESSING-6 | DRY | CONFIRMED | M | The representation graph is walked by seven independent hand-written traversals with three different cycle-guard strategies | [05-processing.md](05-processing.md) |
| PROCESSING-7 | Maintainability | CONFIRMED | M | Twelve public `process_geometry*` entry points plus two side-channel structs, because `StreamingOptions` has public fields | [05-processing.md](05-processing.md) |
| PROCESSING-8 | Maintainability | CONFIRMED | L | `processor/mod.rs` is a 1,656-line file around one 1,180-line function; `process_entity_job` takes 26 parameters | [05-processing.md](05-processing.md) |
| PROCESSING-APP-1 | DRY | CONFIRMED | S | Four `AttributeValue -> wire JSON` converters, one of which has drifted into a panic | [05-processing.md](05-processing.md) |
| PROCESSING-APP-2 | Bug | LIKELY | S | `evaluated::wire` panics (`unreachable!`) on a file-supplied `*` attribute | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-1 | DRY | CONFIRMED | M | `IfcCartesianTransformationOperator` parsed a second time in symbolic, drifted from geometry's declared single home | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-2 | DRY | CONFIRMED | M | `IfcAxis2Placement2D/3D` and the `IfcLocalPlacement` chain re-implemented; depth cap and docs have drifted | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-3 | DRY | CONFIRMED | L | Curve evaluation (`IfcTrimmedCurve`, `IfcCircle`, `IfcEllipse`, `IfcIndexedPolyCurve`, `IfcCompositeCurve`) re-implemented in symbolic and drifted from geometry | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-4 | Bug | CONFIRMED | M | f32 pipeline quantises georeferenced coordinates BEFORE the RTC/site rebase — overlay misaligned by up to 0.5 m at 5,000 km | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-5 | DRY | CONFIRMED | M | Eight hand-rolled DrawOPS cursor walkers and two arity tables in pdf_vector | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-6 | DRY | CONFIRMED | M | `IfcCartesianPoint` / `IfcDirection` reads inlined 25 times with three different malformed-data policies | [05-processing.md](05-processing.md) |
| CORE-1 | DRY | CONFIRMED | M | Raw-byte attribute walkers in the decoder and fast_parse are hand-rolled 12 times, ignore comments and strings, and have three different policies for bad refs | [06-core.md](06-core.md) |
| CORE-2 | DRY | CONFIRMED | M | Length and plane-angle units are resolved in seven or more places with drifted policies | [06-core.md](06-core.md) |
| CORE-3 | DRY | CONFIRMED | S | "Find IfcProject, then get the unit scale" is hand-rolled about 15 times although `EntityDecoder::length_unit_scale()` already exists | [06-core.md](06-core.md) |
| CORE-4 | DRY | CONFIRMED | M ( | Typed values are flattened into an ambiguous `List([String(TYPE), value])` shape, and 12 downstream sites unwrap it differently | [06-core.md](06-core.md) |
| CORE-5 | Bug | CONFIRMED | S | A nom parse failure builds an error string 5-10× the size of the record | [06-core.md](06-core.md) |
| CORE-6 | DRY | CONFIRMED | S | There are four STEP numeric grammars, and the tokenizer rejects literals the fast readers accept | [06-core.md](06-core.md) |
| EXPORT-GEOM-1 | Bug | CONFIRMED | M | OBJ and USD exporters drop the RTC shift and the IfcSite rotation, so georeferenced/site-placed models land in the wrong place | [07-export.md](07-export.md) |
| EXPORT-GEOM-2 | DRY | CONFIRMED | L | three near-complete copies of the glTF assembler (in-memory, multi-buffer streaming, bounded two-pass) | [07-export.md](07-export.md) |
| EXPORT-STEP-1 | DRY | CONFIRMED | M | Record-frame parsers (`#id=TYPE(args);`) implemented ~11 times; drift silently drops log edits | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-2 | DRY | CONFIRMED | M | Five top-level argument splitters and two slot-grammar validators; every slot is validated twice | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-3 | Bug | CONFIRMED | S | Log writer skips schema conversion and IFC2X3 slot-fill for generated, rewritten and georef records | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-MERGE-1 | Bug | CONFIRMED | M | The Rust schema converter does not trim attributes the target schema lacks, except for 30 hand-listed types | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-2 | DRY | CONFIRMED | M | Per-schema attribute data exists 5+ times, and the reason given for the `schema_pad` tables is out of date | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-DATA-1 | DRY + Bug | CONFIRMED | S | `RelatingPropertyDefinition` parsed three ways; the main export drops `IfcPropertySetDefinitionSet` entirely | [07c-export-data-model.md](07c-export-data-model.md) |
| SERVER-1 | DRY | CONFIRMED | M | The parse/cache HTTP scaffold is copy-pasted across every route | [08-server.md](08-server.md) |
| SERVER-10 | Bug | CONFIRMED | S | gzip / `.ifcZIP` decompression runs on the async runtime | [08-server.md](08-server.md) |
| SERVER-11 | Perf | CONFIRMED | S | `extract_data_model` copies the entire upload and allocates a `String` per entity | [08-server.md](08-server.md) |
| SERVER-2 | DRY | CONFIRMED | M | `/parse/parquet` and `/parse/parquet/optimized` share a near-identical parse-and-serialize body | [08-server.md](08-server.md) |
| SERVER-3 | DRY | CONFIRMED | L | The server data model is a fourth Rust implementation of IFC data extraction | [08-server.md](08-server.md) |
| SERVER-5 | Bug | CONFIRMED | S | Unbounded recursion in `resolve_material` – a crafted file aborts the whole server | [08-server.md](08-server.md) |
| SERVER-6 | Bug | CONFIRMED | M | Cache-read routes and probe gates read whole blobs into memory with no admission | [08-server.md](08-server.md) |
| SERVER-7 | Bug | CONFIRMED | M | Cached replay drops its admission slot but keeps the whole model resident for the drain | [08-server.md](08-server.md) |
| SERVER-8 | Bug | CONFIRMED | M | parquet-stream data-model fill takes a second admission slot while the stream holds the first | [08-server.md](08-server.md) |
| SERVER-9 | DRY | CONFIRMED | M | `benches/serialization.rs` is a stale fork of the production serializers | [08-server.md](08-server.md) |
| EDGE-FFI-1 | Bug | CONFIRMED | S | Python's (and the server's) "large stack" does not reach the rayon workers that run the CSG | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| EDGE-CLASH-1 | Bug | LIKELY | S | Clash BVH sorts with a comparator that breaks on NaN, which can panic and abort the shared wasm module | [09a-clash-zerocopy.md](09a-clash-zerocopy.md) |
| EDGE-LXMATH-1 | DRY | LIKELY | M | Circular-arc validation exists twice in the crate, and the parcel copy's tolerances refuse realistic curved parcels | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXPARSE-1 | DRY | CONFIRMED | L | Four hand-rolled XML front-ends (pull loop, consume_event, start/end/text prologue), the root cause of most drift | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-2 | Bug | CONFIRMED | S | Entity and character references in element text are silently dropped (quick-xml 0.42 `Event::GeneralRef` is never handled) | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-3 | Bug | LIKELY | S | The streaming session desynchronises when one text token produces more than one event | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-4 | Bug | CONFIRMED | S | Extension-root `path` strings amplify memory roughly 2000x | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-WASM-1 | DRY | CONFIRMED | S | The browser keeps its own copy of the element-colour / IfcMappedItem colour chase from `processing` | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-2 | DRY | CONFIRMED | M | Per-batch orchestration (router arming + per-job loop) lives in the binding and has drifted from native | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-3 | DRY | CONFIRMED | L | Geometry-job discovery is written six times and they disagree | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-4 | DRY | CONFIRMED | M | Type-geometry sets (referenced RepresentationMaps, instantiated type ids, mapped-instance plan, type candidates) have three implementations, and they treat bare refs differently | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-5 | Bug | LIKELY | S | The browser's don't-bake path does not arm the #858 indexed-colour split guard | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| XCUT-1 | DRY | CONFIRMED | M | `IfcAxis2Placement3D` is read nine different ways | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-2 | DRY | CONFIRMED | M | `IfcCartesianPoint` / `IfcDirection` coordinate reading has 12 named copies and 60 inline copies | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-3 | DRY | CONFIRMED | M | Vector math over `[f64;3]` is implemented 14 times in 5 crates (plus nalgebra, plus Plato-generated) | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-4 | DRY | CONFIRMED | M | Row-major 4×4 matrix helpers (multiply, affine inverse, compose, identity, row/col flatteners) duplicated across geometry, processing, export, wasm, server | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-5 | DRY | CONFIRMED | M | The IFC Z-up → WebGL Y-up frame swap has six "single homes" | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-6 | DRY | CONFIRMED | M | Length-unit resolution and `IFCPROJECT` location are implemented 4× and 12× respectively, with 3 SI-prefix tables | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-7 | DRY | CONFIRMED | L | Four parallel IFC data-model pipelines (property sets, quantities, spatial tree, materials, type relations) and two schema code generators | [10-cross-cutting.md](10-cross-cutting.md) |

## Medium (271)

| ID | Category | Conf. | Effort | Title | File |
|---|---|---|---|---|---|
| ROUTER-10 | DRY | CONFIRMED | S | Cutter admission guards and the engulf test pasted in-line | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-11 | DRY | CONFIRMED | S | Five AABB representations and six "bounds with origin folded" implementations | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-12 | DRY | CONFIRMED | S | `Mesh { … }` struct literal spelled out 5× while `Mesh::rebuilt_like` exists | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-13 | DRY | CONFIRMED | S | MappingTarget bake + `InstanceMeta` construction ×5 | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-15 | DRY | CONFIRMED | S | Placement application duplicated (single-mesh vs sub-mesh, lax vs strict) | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-16 | DRY | CONFIRMED | S | Optional-reference ladders and the parent-placement walk | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-17 | DRY | CONFIRMED | S | Env flags and test overrides via four different mechanisms | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-18 | DRY | CONFIRMED | S | Per-host diagnostic snapshot/restore implemented twice; counters half request-local, half process-global | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-20 | Perf | CONFIRMED | S | `extend_opening_mesh_through_host` recomputed up to 5× per cutter | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-22 | Perf | CONFIRMED | S | `geometry_hash_cache` is dead weight | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-23 | Perf | LIKELY | S | Layered slicing attempted twice for voided sliceable walls (stale comment) | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-24 | Perf | CONFIRMED | S | `IfcSchema::new()` / `.clone()` built per placement, per grid axis, per opening solid | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-26 | Bug | LIKELY | S | Curve-capped flag (#4901) not drained on two of the four source walks | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-27 | Bug | LIKELY | S | Raw-coordinate items inside mapped sources never get the f64 RTC rebase | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-32 | DRY | CONFIRMED | M | `OpeningType` tuple variants projected ad hoc 7× | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-34 | Maintainability | CONFIRMED | S | The built-in processor table is written three (really four) times | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-35 | Maintainability | CONFIRMED | M | Per-IFC-type special cases that should be data-driven (`IfcSchema::geometry_types` exists and is unused by the router) | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-37 | Quirk | CONFIRMED | S | Silent loss paths with no diagnostic record | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-6 | DRY | CONFIRMED | S | Signed volume ×5, surface area ×2 | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-7 | DRY | CONFIRMED | S | 2D point-in-polygon ×4, segment intersection ×5, polygon area/CCW ×4 | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-8 | DRY | CONFIRMED | S | Möller–Trumbore and the parity ray direction duplicated | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-9 | DRY | CONFIRMED | S | Face-normal clustering ×4 | [01-geometry-router.md](01-geometry-router.md) |
| PROC-10 | DRY | CONFIRMED | S | "optional `Position` → matrix", ExtrudedDirection parsing and the extrusion shear are copy-pasted across solid processors | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-11 | DRY | CONFIRMED | L | Two independent IFC curve → polyline samplers (profiles vs advanced faces) with different guards and coverage | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-12 | DRY | CONFIRMED | S | STEP BOOLEAN/LOGICAL enum decoding hand-rolled at ~20 sites with drifting spellings and defaults | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-13 | Bug | CONFIRMED | S | 3D conic placement reader produces NaN or skewed frames; full circles and trimmed circles use different frames | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-14 | Bug | CONFIRMED | S | CoordIndex fast path and slow path disagree on malformed input; validator explicitly allows `-` | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-15 | Bug | CONFIRMED | M | `IfcCompositeProfileDef` turns every sub-profile after the first into a hole | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-16 | Perf | LIKELY | S | `rect_fast::build_cellular` work is bounded only by opening count (128), allowing ~10^10 operations | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-5 | DRY | CONFIRMED | M | Composite-curve traversal exists 4× with 4 different junction-dedup rules and different segment-type coverage | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-6 | DRY | CONFIRMED | M | `IfcTrimmedCurve` interpretation (trim selects, sense, seam wrap) is implemented in four places; non-conic/non-line trims are silently ignored | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-7 | DRY | CONFIRMED | M | Circle/ellipse/arc point generation is written ~15 times; segment-count policies and handedness differ | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-8 | DRY | CONFIRMED | S | `IfcIndexedPolyCurve` is parsed twice (2D and 3D) and the copies disagree on malformed input | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-9 | DRY | LIKELY | M | Sweep-along-frames / tube / revolve mesh assembly duplicated without the shared outward-winding rule | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-S10 | Bug | CONFIRMED | S | Concave quads are fanned across the wrong diagonal in faceted Breps and surface models | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S11 | DRY | CONFIRMED | S | STEP boolean/logical parsing is hand-rolled at 11 sites in this sub-area, with different semantics | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S12 | DRY | CONFIRMED | M | Mesh assembly and processor scaffolding copy-pasted per processor | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S13 | DRY | CONFIRMED | S | Duplicated tessellation snippets: grid indices, largest-gap angular extent, circle vs ellipse samplers, ribbons | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S14 | DRY | CONFIRMED | M | Boolean module: AABB/diagonal helpers repeated, and tolerances are absolute file-unit floors whose comments assume metres | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S15 | DRY | CONFIRMED | M | Recursion/walk guards reimplemented with different limits and failure semantics | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S16 | Bug | LIKELY | S | `SameSense=.F.` flips loop-derived planar triangulations, where the loops already give the face normal | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S17 | Bug | CONFIRMED | S | A malformed half-space returns `Err` through `?`, which deletes the boolean host | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S18 | Bug | LIKELY | S | The PBHS boundary accepts only `IfcPolyline`, so other boundaries fall back to an unbounded over-cut | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S19 | Quirk | LIKELY | S | `IfcBoxedHalfSpace` is treated as an unsupported solid operand | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S20 | Quirk | CONFIRMED | L ( | B-spline advanced faces ignore the face's bounds, so trimmed NURBS faces render as untrimmed patches | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S21 | Bug | CONFIRMED | S | Unresolvable points are silently skipped rather than refusing the curve | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S22 | Perf | CONFIRMED | S | Advanced-face dispatch is stringly typed and allocates `to_uppercase()` on already-uppercase strings | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S5 | Bug | CONFIRMED | S | FacetedBrep fills authored holes when hole triangulation fails | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S6 | Bug | CONFIRMED | S | `IfcFacetedBrepWithVoids` has no processor, and `SurfaceOfLinearExtrusionProcessor` is never registered | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S7 | DRY | CONFIRMED | M | Four forks of IfcAxis2Placement/IfcAxis1Placement parsing; the conics fork bypasses `build_axis2_matrix` and misreads 2D placements | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S8 | DRY | CONFIRMED | S | Copy-pasted vector/2D-polygon primitives: Newell normal, perpendicular basis, signed area, point-in-ring | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S9 | DRY | CONFIRMED | S | The `(x,y,z)`-from-coordinate-list read is repeated at 14 sites, and vertex resolution is strict in one place and lenient in another | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-AL-1 | DRY | CONFIRMED | M | IfcRelVoidsElement / IfcRelAggregates / IfcRelAssociatesMaterial decoding duplicated between geometry scanners and the processing span pre-pass (drifted) | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-2 | DRY | CONFIRMED | S | Alignment station sampling with a cap is implemented three times; two copies are verbatim | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-3 | DRY | CONFIRMED | M | Three numerical spiral/clothoid integrators with different quadrature and accuracy | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-4 | DRY | CONFIRMED | S | Vertical circular arc evaluated two ways; the IFC4x1 copy is a parabola with a false accuracy claim | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-5 | Bug | CONFIRMED | M | IfcSectionedSolidHorizontal drops profile holes (hollow sections render solid) | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-6 | Perf | LIKELY | S | ArcLengthMap does full horizontal evaluation per step; O(V) vertical scan makes it quadratic on sampled curves; unit-naive step | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-7 | DRY | CONFIRMED | S | Duplicated bounded curve-walk budget (MAX_CURVE_NODES ×2 plus a literal) | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-8 | DRY | CONFIRMED | M | Strict alignment validation re-walks placements and curve segments the canonical resolvers walk again | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| KERNEL-10 | DRY | CONFIRMED | M | `Mesh` has no f64 vertex/triangle accessor, so about 20 ad-hoc readers exist and only some check bounds | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-11 | DRY | CONFIRMED | S | `Mesh` is built with full struct literals at 12+ sites outside `mesh.rs` | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-12 | DRY | CONFIRMED | M | Degenerate-triangle criteria are scattered, with different thresholds and passes | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-13 | DRY | CONFIRMED | M | Test fixtures are copy-pasted: `boxed()` ×7 verbatim, about 25 box builders, `mesh_of` twice in one file | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-14 | DRY | CONFIRMED | S | CDT emit / PSLG setup and BVH traversal are copy-pasted (jscpd-confirmed) | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-15 | DRY | CONFIRMED | S | The retriangulation f64 prefilter (box plus margin) is hand-copied four times | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-16 | DRY | CONFIRMED | S | 2D proper-crossing and point-in-triangle predicates exist in 5+ variants | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-17 | Bug | LIKELY | S | Bug: public `mesh_bridge::subtract` / `subtract_many` do not reset or check the #1109 budget | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-18 | Quirk | SUSPECT | S | The classifier's "infinitesimal" probe step scales with absolute coordinate magnitude, not operand size | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-19 | Quirk | SUSPECT | M | Consolidation's absolute tolerances are metre constants applied in caller (file) units | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-20 | Quirk | LIKELY | S | `Mesh::merge` / `Mesh::clear` do not uphold the metadata-invalidation contract the field docs require | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-21 | Perf | CONFIRMED | M | N-ary `union_all` lacks the BVH and f64 cache the binary classifier got, and the A-side probes are linear | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-22 | Maintainability | CONFIRMED | M | Public kernel surface is wide (semver-checked crate) and carries dead or test-only pub items | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-23 | Maintainability | CONFIRMED | L | God functions, and modules split by line-count budget rather than by concept | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-24 | Perf | CONFIRMED | S | Retriangulation recomputes I1024 lambdas the interner already caches, uses a BTreeMap per-Vid cache, and clones constraints per triangle | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-4 | DRY | CONFIRMED | S | The predicate cascade is composed by hand in six places; the tri-tri copy skips the #1109 budget | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-5 | DRY | CONFIRMED | M | f64 vec3 / triangle-normal helpers are re-declared across the kernel (twice in one file) | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-6 | DRY | CONFIRMED | M | The arrangement classifier duplicates its own internals, and the N-ary path drifted from the binary one | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-7 | DRY | CONFIRMED | M | Three point-in-closed-mesh parity algorithms with different robustness rules | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-8 | DRY | CONFIRMED | S | Signed volume is implemented six-plus times, with drifted reference points and snapping | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-9 | DRY | CONFIRMED | M | Vertex welding / position dedup is implemented 8+ times | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| GEOM-11 | DRY | CONFIRMED | S | Inverse-transpose normal transform implemented 3x with different degenerate handling | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-12 | Bug | LIKELY | S | SpacePlate (space_dcel) public/wasm edit API accepts NaN; non-total sort comparators can panic | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-13 | DRY | CONFIRMED | S | Point-in-polygon (ray cast) implemented 8 times | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-14 | DRY | CONFIRMED | S | Signed shoelace area / centroid / ring bbox / 2D distance re-implemented beside `geom2d` | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-15 | DRY | CONFIRMED | S | `[f64;3]` vector helpers (dot/cross/normalize/face_normal/canonical) copied across geometry, clash, export, processing | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-17 | DRY | CONFIRMED | M | Production open-edge / closedness checks: 7 variants with different vertex keys | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-18 | DRY | CONFIRMED | S | "Scan to IFCPROJECT and read length/angle unit" implemented 6+ times; geometry has two verbatim copies | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-19 | DRY | CONFIRMED | M | Three strict placement-chain validators across crates, drifted | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-20 | Quirk | CONFIRMED | S | 13 env-var kill switches with inconsistent truthiness semantics and no single home | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-21 | Maintainability | CONFIRMED | M | ~10 independent global/thread-local telemetry mechanisms; 5 `take_*` drains exported from crate root | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-6 | DRY | CONFIRMED | S | Box/cube mesh builders duplicated 35+ times; `boxed(min,size,rot)` copied verbatim 7x | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-7 | DRY | CONFIRMED | M | `build_void_index` (23 copies) and router-setup boilerplate duplicated across fixture integration tests | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-8 | Maintainability | CONFIRMED | L | 128 integration-test binaries; probes/census/spikes compiled as tests | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-9 | Best-practice | CONFIRMED | S | lib.rs root re-exports: 60 items have no user outside the crate, ~20 more only geometry's own tests | [04-geometry-misc.md](04-geometry-misc.md) |
| PROCESSING-10 | DRY | CONFIRMED | S | "Apply the transpose of a column-major 4x4's rotation block" is spelled four times | [05-processing.md](05-processing.md) |
| PROCESSING-11 | DRY | CONFIRMED | S | Row-major mat4 multiply / transform / invert / Y-up conjugation exist in processing, wasm-bindings and export, with the geometry crate owning nalgebra | [05-processing.md](05-processing.md) |
| PROCESSING-12 | DRY | CONFIRMED | S | Seven private `dot/cross/sub/add/unit` vector mini-libraries inside processing | [05-processing.md](05-processing.md) |
| PROCESSING-13 | DRY | CONFIRMED | M | Three vertex-weld/quantise implementations and nine fingerprint hashers | [05-processing.md](05-processing.md) |
| PROCESSING-14 | DRY | CONFIRMED | S | Per-job metadata population duplicated between the wasm32 and native cfg forks | [05-processing.md](05-processing.md) |
| PROCESSING-15 | DRY | CONFIRMED | S | Hand-rolled STEP tokenisers and `$`/empty-string normalisers next to the core decoder | [05-processing.md](05-processing.md) |
| PROCESSING-16 | Perf | CONFIRMED | S | Server streaming/JSON routes resolve every styled item twice per request (`ModelFinishes::from_content` + the pipeline's own `resolve_prepass`) | [05-processing.md](05-processing.md) |
| PROCESSING-18 | Quirk | SUSPECT | S | Quick-metadata storey elevation is emitted in file units, not metres | [05-processing.md](05-processing.md) |
| PROCESSING-19 | DRY | CONFIRMED | M | Native vs wasm entity-index construction strategies differ (compact-page builder vs columnar-from-hashmap) with different thresholds | [05-processing.md](05-processing.md) |
| PROCESSING-20 | DRY | CONFIRMED | S | Test fixture loaders and `MeshProductionContext` fixture blocks are copy-pasted across integration tests | [05-processing.md](05-processing.md) |
| PROCESSING-9 | DRY | CONFIRMED | M | wasm `combined_pre_pass` is a fourth full-file scan path with its own job classification, followed by a fifth scan for type jobs | [05-processing.md](05-processing.md) |
| PROCESSING-APP-10 | DRY | CONFIRMED | M | Test scaffolding copy-paste (beyond the jscpd hits) | [05-processing.md](05-processing.md) |
| PROCESSING-APP-12 | Perf | CONFIRMED | M | Page/transfer pipeline repeats preflight, texture index and canonical meshing (5 mesh productions per product) | [05-processing.md](05-processing.md) |
| PROCESSING-APP-19 | Best-practice | CONFIRMED | M | Stringly-typed errors everywhere | [05-processing.md](05-processing.md) |
| PROCESSING-APP-3 | DRY | CONFIRMED | S | Rigid placement inversion implemented twice, with drift | [05-processing.md](05-processing.md) |
| PROCESSING-APP-4 | DRY | CONFIRMED | S ( | `dot` / `cross` / `sub` / `length` / `unit` re-declared six ways inside appearance (and more across the workspace) | [05-processing.md](05-processing.md) |
| PROCESSING-APP-5 | DRY | CONFIRMED | S | Budget/cap literals spread across three "budget" modules and nine other files, with one drifted value | [05-processing.md](05-processing.md) |
| PROCESSING-APP-6 | DRY | CONFIRMED | S | Canonical `MeshData` validity predicate copied four times; one consumer skips it and indexes raw | [05-processing.md](05-processing.md) |
| PROCESSING-APP-7 | DRY | CONFIRMED | S | Reserved-wire-token guard re-implemented with different semantics | [05-processing.md](05-processing.md) |
| PROCESSING-APP-8 | DRY | CONFIRMED | M | Authoring helpers and the textured-style entity chain exist twice | [05-processing.md](05-processing.md) |
| PROCESSING-APP-9 | DRY | CONFIRMED | S | Scope/schema/watermark/capacity gates re-spelled per entry point | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-10 | DRY | CONFIRMED | M | Four 2D affine representations in `processing`; `[f64;6]` apply/multiply duplicated inside pdf_vector | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-11 | DRY | CONFIRMED | S | AABB fold written three ways in pdf_vector | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-12 | DRY | CONFIRMED | S | Dash phase normalisation, odd-pattern doubling, closed-ring stripping and signed area each duplicated | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-13 | DRY | CONFIRMED | S | Work-budget charging has two helpers and three ad-hoc `checked_mul` chains | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-14 | DRY | CONFIRMED | M | The `IfcMappedItem → IfcRepresentationMap → Items` walk is the fifth copy in `processing`, each with its own guard and depth constant | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-15 | Bug | LIKELY | M ( | `IfcIndexedPolyCurve.Segments` ignored — arcs drawn as chords, index lists ignored | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-16 | Bug | LIKELY | S | Placement-chain cap of 50 vs shared `MAX_PLACEMENT_DEPTH = 100` silently relocates deep products to the origin | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-17 | Bug | LIKELY | S | Unresolvable trims fabricate an arc; trimmed `IfcLine` silently dropped | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-18 | Perf | CONFIRMED | S | Style index performs two extra full-file scans per extraction | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-20 | Maintainability | CONFIRMED | M | Twelve-parameter signatures threaded through seven functions under `#[allow(clippy::too_many_arguments)]` | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-21 | Maintainability | CONFIRMED | S | Magic tolerances and segment counts with no named home | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-24 | DRY | CONFIRMED | M | Symbolic integration tests embed the same STEP prologue in 18 files; `issue_2356` has six verbatim copies of its own fixture | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-7 | DRY | CONFIRMED | S | Polyline / indexed-polycurve point emission written five times inside symbolic | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-8 | DRY | CONFIRMED | S | Conic tessellation duplicated inside symbolic with two different closure and segment conventions | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-9 | DRY | CONFIRMED | S | Largest singular value of the affine computed twice, drifted | [05-processing.md](05-processing.md) |
| CORE-10 | DRY | CONFIRMED | S | Entity type names are extracted four ways and normalised two ways | [06-core.md](06-core.md) |
| CORE-11 | Bug | LIKELY | S | `get_face_bound_fast` tests "OUTER" case-sensitively, so CamelCase files lose outer-bound detection | [06-core.md](06-core.md) |
| CORE-12 | Bug | CONFIRMED | S | IfcTriangulatedFaceSet `CoordIndex` is parsed by two core grammars with different index rules, after already being decoded | [06-core.md](06-core.md) |
| CORE-13 | Bug | CONFIRMED | S | `model_bounds` has its own point, ref and number readers; the placement filter uses an unscaled `1000.0`; and it scans the file up to three times | [06-core.md](06-core.md) |
| CORE-14 | Bug | CONFIRMED | S | The ePSet_MapConversion fallback accepts non-finite Eastings, Northings and Height; the IfcMapConversion path refuses them | [06-core.md](06-core.md) |
| CORE-15 | Bug | LIKELY | S | `extract_length_unit_scale` accepts infinite conversion factors and invents 1.0 for unreadable ones | [06-core.md](06-core.md) |
| CORE-16 | DRY | CONFIRMED | S | Raw STEP literal decoding is implemented four times, and downstream code double-decodes already-decoded strings | [06-core.md](06-core.md) |
| CORE-17 | Perf | LIKELY | M | The decoder does up to six independent full-file scans for singletons, and the styled-item index is rebuilt per decoder for Hash and Dense indexes | [06-core.md](06-core.md) |
| CORE-18 | Perf | CONFIRMED | M | Every decode builds a `Token` tree and then an `AttributeValue` tree | [06-core.md](06-core.md) |
| CORE-19 | Maintainability | CONFIRMED | L ( | There is no typed attribute layer: about 1,400 magic positional reads downstream, and two `attribute_index` APIs with different semantics | [06-core.md](06-core.md) |
| CORE-20 | Maintainability | CONFIRMED | M ( | `IfcSchema` is threaded through 43 signatures, but only `profile_category` is ever read | [06-core.md](06-core.md) |
| CORE-21 | Maintainability | CONFIRMED | S | Dead public surface and dependencies: streaming, fast_parse TFS path, scanner helpers, smallvec | [06-core.md](06-core.md) |
| CORE-7 | Maintainability | CONFIRMED | M ( | The generated code duplicates the type universe five times; the registries need only tables | [06-core.md](06-core.md) |
| CORE-8 | DRY | CONFIRMED | S | The STEP string-literal end rule is implemented five times in core, and the copies disagree on unterminated literals | [06-core.md](06-core.md) |
| CORE-9 | Bug | CONFIRMED | S | The scanner's DATA-section skip and the header reader disagree on where `DATA;` is | [06-core.md](06-core.md) |
| EXPORT-GEOM-10 | Maintainability | CONFIRMED | S ( | gltf.rs is a 3,090-line god file and its ratchet budget has 938 lines of slack | [07-export.md](07-export.md) |
| EXPORT-GEOM-18 | DRY | CONFIRMED | S | glTF test/inspection helpers copy-pasted across seven files | [07-export.md](07-export.md) |
| EXPORT-GEOM-3 | DRY | CONFIRMED | M | Z-up/Y-up basis change and 4x4 helpers are reimplemented across export and in two other crates, with drifted tolerances | [07-export.md](07-export.md) |
| EXPORT-GEOM-4 | DRY | CONFIRMED | M | "is this mesh renderable/finite" is decided by seven predicates with three different non-finite policies | [07-export.md](07-export.md) |
| EXPORT-GEOM-5 | DRY | CONFIRMED | S | material colour key implemented three times in export, already drifted | [07-export.md](07-export.md) |
| EXPORT-GEOM-6 | DRY | CONFIRMED | M | number-to-text formatting has one implementation per exporter, with different -0, non-finite and precision rules | [07-export.md](07-export.md) |
| EXPORT-GEOM-8 | DRY | CONFIRMED | M | from-meshes flat-array slicing, validation and defaulting written twice with drifted contracts | [07-export.md](07-export.md) |
| EXPORT-GEOM-9 | Bug | CONFIRMED | S | `export_gltf_streaming` returns a schema-invalid empty glTF instead of failing closed | [07-export.md](07-export.md) |
| EXPORT-STEP-10 | Bug | CONFIRMED | S | Plain writer silently drops property mutations it cannot place | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-11 | DRY | CONFIRMED | M | Record index built twice; duplicate express ids silently collapse | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-12 | DRY | CONFIRMED | M | Four schema-family classifiers and three FILE_SCHEMA-token rules have drifted | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-13 | Perf | CONFIRMED | S | Log stream loop does work proportional to records × created entities, plus allocations per record | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-14 | Perf | CONFIRMED | S | Plain full export builds an every-id HashSet and copies every record | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-15 | Perf | CONFIRMED | M | Argument splitting allocates a `Vec<char>` per record and per slot, and runs on every `IFCREL*` line | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-16 | Maintainability | CONFIRMED | S | A refusal counter is derived by substring-matching warning text; warning text is duplicated and has drifted | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-4 | DRY | CONFIRMED | S | Two STEP REAL formatters with different bytes and non-finite policy | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-5 | Bug | CONFIRMED | S | Integer and number serialisers emit non-STEP tokens (`NaN`, `Infinity`, `1e+21`); REAL non-finite policy inconsistent | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-6 | DRY | CONFIRMED | S | Seven comment/trivia skippers and three whitespace definitions; core's lexer is unused | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-7 | DRY | CONFIRMED | S | Numeric-literal grammar duplicated despite core's documented single home (#5266) | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-8 | Bug | CONFIRMED | S | Positional index from the log can force a huge allocation or index-out-of-bounds panic | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-9 | Bug | CONFIRMED | S | Log writer's id allocator saturates at `u32::MAX`, unlike the plain writer | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-MERGE-10 | Perf | CONFIRMED | S | `unify_spatial` copies every line of each later model to a String before checking its type | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-11 | Perf | CONFIRMED | M | The merge repeats whole-model passes and stores one heap String per entity | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-3 | DRY | CONFIRMED | S | Two copies of the leading-GlobalId reader and validator, and the doc names the unused one as the only production path | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-4 | DRY | CONFIRMED | M | Schema-family detection exists 9 times with different rules | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-5 | DRY | CONFIRMED | M | Five STEP argument splitters; only one skips `/* comments */` | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-6 | DRY | CONFIRMED | M | The record-parsing prologue is copied 5 times, and each IFC2X3 line is split 5-6 times | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-7 | DRY | CONFIRMED | M | step_map has three pairs of near-identical graph walkers and duplicated map edits | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-8 | Bug | CONFIRMED | S | Downgrading IfcAlignment/IfcReferent to IFCPROXY keeps the source attributes, producing a short, invalid IfcProxy | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-9 | Bug | CONFIRMED | S | Two wrong counts in the hand-written IFC2X3 attribute table | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-DATA-10 | DRY | CONFIRMED | S | Duplicate-space dedupe cloned between HBJSON and DFJSON with literal thresholds | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-11 | DRY | CONFIRMED | S | Profile-to-ring, extrusion and vector helpers re-implemented across the energy exporters | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-12 | Perf | CONFIRMED | S | Single-pass scans use the caching decoder (unbounded cache plus a clone per entity) | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-13 | Perf | CONFIRMED | S | Flattened entity CSV is O(entities x columns x properties) | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-15 | Maintainability | CONFIRMED | M | `stream_export_model_with_options` is a 326-line function | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-2 | DRY | CONFIRMED | M | Property-value decoding exists twice and has drifted (kinds supported, enum and ref rendering) | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-3 | DRY | CONFIRMED | M | `IfcRelDefinesByType` is resolved four times with three different conflict policies | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-4 | Bug | CONFIRMED | S | DFJSON story order mixes unscaled absolute `Elevation` with rebased metric floor heights | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-5 | Bug | LIKELY | S | An `IfcSpace` with more than one extruded item gives duplicate HBJSON/DFJSON identifiers | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-6 | Bug | LIKELY | M | HBJSON/DFJSON coordinates already passed through f32; the "rebase keeps survey precision" comment is wrong | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-7 | DRY + Bug | LIKELY | S | Two Honeybee identifier sanitizers, drifted from each other and from honeybee-schema | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-8 | Bug | CONFIRMED | S | The JSON number allowlist misses most IFC measure types, so numbers become strings | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-9 | DRY | CONFIRMED | M | Unit scales come from three different resolvers, with mixed units in single outputs | [07c-export-data-model.md](07c-export-data-model.md) |
| SERVER-12 | DRY / Bug | CONFIRMED | S | Five different policies for an unusable cache entry; three of them return 500 forever | [08-server.md](08-server.md) |
| SERVER-13 | DRY | CONFIRMED | S | Four Parquet writer helpers with drifted writer properties | [08-server.md](08-server.md) |
| SERVER-14 | DRY / Bug | CONFIRMED | S | Length-prefixed section framing written 4×, read 3×+; the data-model framer is unguarded | [08-server.md](08-server.md) |
| SERVER-15 | DRY | CONFIRMED | M | Z-up→Y-up conversion and its vertex loop are implemented 3× in the server and 4× more elsewhere | [08-server.md](08-server.md) |
| SERVER-16 | DRY | CONFIRMED | S | The six-field response/header shape is defined five times; `DataModelStats` is built twice | [08-server.md](08-server.md) |
| SERVER-17 | DRY | CONFIRMED | S | The trailing per-mesh columns share a schema but are assembled twice | [08-server.md](08-server.md) |
| SERVER-18 | DRY / Bug | CONFIRMED | S | Schema detection is duplicated, and `/parse/metadata` disagrees with `/parse` | [08-server.md](08-server.md) |
| SERVER-19 | DRY | CONFIRMED | S | Hand-built `Response::builder` boilerplate (nine sites) | [08-server.md](08-server.md) |
| SERVER-20 | DRY | CONFIRMED | S | The two `?sha256=` probe handlers are near-identical | [08-server.md](08-server.md) |
| SERVER-21 | Quirk | CONFIRMED | S | `GET /parse/symbolic/{key}` answers 202 forever for keys nothing will write | [08-server.md](08-server.md) |
| SERVER-22 | Quirk / Perf | CONFIRMED | S | `/parse/stream` advertises a `cache_key` that names nothing; parquet-stream hashes the upload twice | [08-server.md](08-server.md) |
| SERVER-23 | Perf | CONFIRMED | S ( | The streaming producer clones every batch's geometry | [08-server.md](08-server.md) |
| SERVER-24 | Perf / Quirk | CONFIRMED | M | Every admission reservation is `max_file_size`, even when the actual size is known | [08-server.md](08-server.md) |
| SERVER-25 | Perf | CONFIRMED | M | JSON cache hits fully decode and re-encode the whole model to set one flag | [08-server.md](08-server.md) |
| SERVER-26 | Bug | LIKELY | M | Material association rows multiply elements × layers with no cap | [08-server.md](08-server.md) |
| SERVER-27 | DRY | CONFIRMED | S | Spatial-structure type list is hand-typed while processing derives it from the schema | [08-server.md](08-server.md) |
| SERVER-28 | DRY | LIKELY | M | IFC4-only generated attribute table instead of core's per-schema registry | [08-server.md](08-server.md) |
| SERVER-29 | Bug | LIKELY | S | Slow uploads hold admission permits; no body read-progress timeout | [08-server.md](08-server.md) |
| EDGE-FFI-2 | Bug | CONFIRMED | S | FFI rejects IFC files that are not valid UTF-8 (merges EDGE-WASM-14) | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| EDGE-FFI-3 | DRY | CONFIRMED | S | Python's "spawn a large-stack thread, join, map panic to a string" block copied 8 times | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| EDGE-FFI-4 | DRY | CONFIRMED | S | Python results are serialised to JSON, parsed by Python's `json.loads`, and string keys re-keyed to int, six times | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| EDGE-FFI-5 | Bug | LIKELY | S | Non-finite floats silently become JSON `null` on every Python JSON entry point except `rebar_schedule` | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| EDGE-FFI-6 | DRY | CONFIRMED | S | `ProcessingResult` → `ParseResponse` mapping duplicated in FFI and the server, and the FFI output has drifted | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| EDGE-FFI-7 | DRY | CONFIRMED | S | The "site rotation only in SiteLocal" decision is re-derived at every consumer | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| EDGE-FFI-8 | Best-practice | CONFIRMED | S | FFI panic safety depends on the build profile, with no compile-time guard | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| EDGE-FFI-9 | Perf | CONFIRMED | S | cloud-import clones the ancestor `HashSet<String>` for every child (O(occurrences x depth) memory) | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| EDGE-CLASH-2 | DRY | CONFIRMED | M | Z-up/Y-up basis matrix and row-major 4x4 multiply copied across three crates | [09a-clash-zerocopy.md](09a-clash-zerocopy.md) |
| EDGE-CLASH-3 | DRY | CONFIRMED | M | Symbolic primitives exist twice and are copied field by field | [09a-clash-zerocopy.md](09a-clash-zerocopy.md) |
| EDGE-CLASH-4 | DRY | CONFIRMED | M | Box-face normal code duplicated between clash and geometry, and the two have drifted | [09a-clash-zerocopy.md](09a-clash-zerocopy.md) |
| EDGE-CLASH-5 | Perf | CONFIRMED | S | Clash session keeps up to three copies of each element's geometry | [09a-clash-zerocopy.md](09a-clash-zerocopy.md) |
| EDGE-LXMATH-10 | Quirk | LIKELY | S | The circular vertical-curve length check allows only 32 ULP, far stricter than every other length check | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-11 | Quirk | CONFIRMED | S | The comment on assumed units contradicts the declared-unit behaviour, and the two paths scale elevations differently | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-2 | DRY | CONFIRMED | M | Clothoid / spiral integration is implemented three ways with different accuracy and domain rules | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-20 | Perf | CONFIRMED | M | Every probe re-validates the whole alignment and searches segments linearly | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-22 | Maintainability | CONFIRMED | M | `adapt_faceless_tin` is a 376-line function with the same error-mapping match repeated eight times | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-3 | DRY | CONFIRMED | S | The plan point-resolver adapter is copied into the WASM binding, and the copies use different work budgets | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-4 | DRY | CONFIRMED | S | Alignment display sampling is duplicated, the copies truncate differently, and the stream summary computes it twice | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-5 | DRY | CONFIRMED | S | The 2D predicates in LandXML terrain and parcel code are copies of geometry's `geom2d`, and the parcel copy is inexact | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-6 | DRY | CONFIRMED | M | Terrain constraints are scanned twice, once in LandXML and again in geometry's CDT | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-7 | DRY | CONFIRMED | M | Vertical circular and parabolic curves are evaluated five ways; IFC4x1 circular arcs use a parabolic approximation | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-8 | DRY | CONFIRMED | S | Profile evaluation resolves each curve's PVIs twice and finds them by float equality | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-9 | Bug | CONFIRMED | S | `IrregularLine` probes fail at the segment end when the declared length exceeds the polyline length | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXPARSE-10 | DRY | CONFIRMED | S | Whitespace-separated finite-f64 coordinate parsing is reimplemented about 10 times | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-11 | DRY | CONFIRMED | S | Encoding normalization is duplicated between pull and stream | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-12 | DRY | CONFIRMED | M | The lexical tokenizer is duplicated (preflight vs stream), and both share a `<!-->` overlap bug | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-13 | DRY | CONFIRMED | S | Progress-error mapping in terrain.rs is copy-pasted 8 times inside a 375-line function | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-14 | Perf | CONFIRMED | S | Every element clones the namespace map and the whole frame, in all four parsers (so four times per element in stream) | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-15 | Perf | CONFIRMED | S | The pipe parser builds a BTreeMap of all attributes for every LandXML element | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-16 | Perf | CONFIRMED | M | Stream transport copies every byte about 5 times, byte by byte, plus a debug copy per token and a JSON serialization per event just to measure it | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-17 | Bug | LIKELY | S | TIN `child_ordinals` keeps one entry per distinct child name (memory amplification) | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-28 | Maintainability | CONFIRMED | L | God functions and structs, stringly-typed paths, sentinel roles | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-5 | DRY | CONFIRMED | M | The budget/limit counter pattern is duplicated 17 times, with drift | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-6 | DRY | CONFIRMED | S | The linear-unit scale table and Units parsing are duplicated; `elevationUnit=""` behaves differently | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-7 | Bug | CONFIRMED | S | `assumed_linear_unit` is honoured only by TIN; pipe, plan and alignment ignore it | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-8 | Perf | CONFIRMED | M | The pull "canonical document" re-parses the input 3–4 times; the WASM options path drops pipes; an error is matched by string | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-9 | DRY | CONFIRMED | M | Alignments are parsed twice into two public types; plan point, location and properties types are also duplicated | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-WASM-10 | DRY | CONFIRMED | S | Prepass wire encoders live in `processing`, but the browser decodes some of them itself | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-11 | DRY | CONFIRMED | M | Cache lifecycle is hand-copied: eight lazy getters and three diverging reset paths | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-12 | DRY | CONFIRMED | M | 16-argument batch signatures copied at five entry points (plus 12-argument finalize ×2) | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-13 | Bug | CONFIRMED | S | `exportMerged` uses `throw_str` inside a `&self` method | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-14 | Bug | CONFIRMED | S | FFI rejects IFC files that are not valid UTF-8 | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-15 | Perf | LIKELY | S | The streaming pre-pass copies the whole partial FxHashMap index to emit the meta event | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-16 | Perf | CONFIRMED | M | Overlay parsers re-transcode and re-index the whole file on every call | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-17 | Maintainability | CONFIRMED | L | God functions, a 22-field `IfcAPI` and boolean-flag soup | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-6 | DRY | CONFIRMED | S | The CSG console logger re-aggregates diagnostics with different rules from the typed aggregate it returns | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-7 | DRY | CONFIRMED | S | The IfcIndexedColourMap full-palette collection loop is duplicated | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-8 | DRY | CONFIRMED | S | Unit-scale resolution has four implementations | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-9 | DRY | CONFIRMED | M | The Z-up → Y-up basis, 4×4 multiply and render-frame point transform are copied, and two copies differ on -0.0 | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| XCUT-10 | DRY | CONFIRMED | S | IFC GlobalId alphabet and validator duplicated with a drifted rule | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-11 | DRY | CONFIRMED | S | Colour keys and 8-bit quantisation re-implemented outside the sanctioned `Rgba` home | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-12 | DRY / Maintainability | CONFIRMED | M | Tolerances: 111 named constants and ~1,000 inline epsilon literals with the same concept at different values | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-14 | DRY / Maintainability | CONFIRMED | M | Four cancellation/progress mechanisms | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-15 | Best-practice / Maintainabilit | CONFIRMED | L | Seven error-handling policies across the workspace | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-16 | Best-practice | CONFIRMED | S | No external dependency uses workspace inheritance; `sha2` is already split across majors | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-19 | DRY / Maintainability | CONFIRMED | M | Crate layering: copies made to avoid dependencies, and a landxml concern living in geometry | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-20 | Maintainability | CONFIRMED | M | Feature-flag and env-var configuration sprawl without a catalogue | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-21 | Maintainability | CONFIRMED | L | God files and god functions, frozen by a 461-row size allowlist | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-22 | DRY / Maintainability | CONFIRMED | M | Test sprawl: 240 integration-test binaries and the same helpers copied dozens of times | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-26 | Bug | CONFIRMED | S | `read_conic_placement_3d` normalises a possibly-zero axis without a guard (NaN frame) | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-27 | DRY | CONFIRMED | M | Placement-chain walk implemented nine times with two different depth limits | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-8 | DRY | CONFIRMED | M | AABB / bounds: 5 types and ~40 hand-rolled min/max folds with different sentinels and NaN behaviour | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-9 | DRY | CONFIRMED | S–M | Hashing: five FNV-1a implementations, five generated CRC32s, three content-hash algorithms, two `sha2` majors, and `DefaultHasher` in a persisted key | [10-cross-cutting.md](10-cross-cutting.md) |

## Low (269)

| ID | Category | Conf. | Effort | Title | File |
|---|---|---|---|---|---|
| ROUTER-14 | DRY | CONFIRMED | S | Matrix4 → `[f64;16]` flatten spelled 5 ways | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-19 | DRY | CONFIRMED | S | "skipping unsupported item" drop block ×9 | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-25 | Perf | CONFIRMED | S | Small hot-path waste in the void loops | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-28 | Bug | LIKELY | S | Opening probes mesh a `MappedRepresentation` even when direct body geometry exists | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-29 | Bug | CONFIRMED | S | Processor-failure sweep order depends on `std::HashMap` iteration | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-30 | Bug | SUSPECT | S | `partial_cmp().unwrap()` on half-extents | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-31 | Quirk | CONFIRMED | S | Two vertex-access conventions in one module (checked `mesh_point` vs unchecked indexing) | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-36 | DRY | CONFIRMED | S | Three navigations of shell → face → bound → loop → point | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-38 | Best-practice | CONFIRMED | S | `#[cfg(feature = "opening-perf-trace")] crate::opening_perf_trace::record(\|c\| …)` ×21 | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-39 | Best-practice | CONFIRMED | S | Tautological / copy-pasted compile-time guards | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-40 | Best-practice | LIKELY | M | Public surface wider than the two real callers need | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-41 | DRY | CONFIRMED | S | Three mesh-identity hashing schemes | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-42 | DRY | CONFIRMED | S | "Is this placement the identity" with three tolerances | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-43 | DRY | CONFIRMED | S | `enclosing_f32` re-implemented 170 lines below its own import | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-44 | DRY | CONFIRMED | S | Two 24-vertex box builders | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-45 | DRY | CONFIRMED | S | Union-find implemented three times beside `crate::union_find` | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-46 | DRY | CONFIRMED | S | Sutherland–Hodgman plane clip ×4 | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-47 | Maintainability | CONFIRMED | S | Magic tolerances without a named home | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-48 | DRY | CONFIRMED | S | Geometry-job entity scan triplicated across crates | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-49 | DRY | CONFIRMED | S | Diagnostic enums/structs mirrored | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-50 | Best-practice | CONFIRMED | M | Test fixtures copy-pasted across the crate | [01-geometry-router.md](01-geometry-router.md) |
| ROUTER-51 | Quirk | CONFIRMED | S | Two-tier mapped-item cache with divergent guards | [01-geometry-router.md](01-geometry-router.md) |
| PROC-17 | DRY | CONFIRMED | S | Flat-shaded mesh builders, triangle-normal math and shell orientation duplicated in tessellated/ | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-18 | DRY | CONFIRMED | S | `PolygonalFaceSet` polygon triangulation re-implements Newell + dominant-axis projection, and fans concave quads | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-19 | DRY | CONFIRMED | S | `simplify.rs` / `placement.rs` / `profile.rs` re-implement shared 2D polygon helpers | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-20 | DRY | CONFIRMED | S | Test helpers and decoding boilerplate copy-pasted across test files | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-21 | Bug | CONFIRMED | S | rect_fast telemetry: parametric-path defers are never recorded; a dead counter; one counter still process-global | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-22 | Quirk | CONFIRMED | S | Tapered loft resamples the coarser loop by arc length and cuts its corners; resampling is O(n·m) | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-23 | Quirk | CONFIRMED | S | Parametric profile builders validate and model attributes inconsistently; stale docs | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-24 | Maintainability | CONFIRMED | S | Full `Mesh { .. }` struct literals in processors | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-25 | Maintainability | CONFIRMED | S | `profile::create_circle` / `calculate_circle_segments` / `ProfileType` are public but production-unused and use a different policy | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-26 | Maintainability | CONFIRMED | S | `create_cap_mesh` infers winding from `z == 0.0` rather than from its `normal` argument | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-27 | Maintainability | CONFIRMED | S | Point-coincidence / seam tolerances are scattered literals with no named home | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-28 | Maintainability | CONFIRMED | M | Long functions in profiles/swept/tessellated/extractor (line counts approximate, include trailing docs) | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| PROC-S23 | Bug | CONFIRMED | S | SurfaceOfLinearExtrusion produces NaN on a zero direction and has no RTC hook | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S24 | Bug | LIKELY | S | Surface of revolution ignores `IfcSweptSurface.Position` | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S25 | Bug | CONFIRMED | S | AdvancedBrep aborts the whole solid when one face fails to decode | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S26 | Perf | CONFIRMED | S | Hot-path inefficiencies in the face and curve paths | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S27 | Maintainability | CONFIRMED | S | Stale or self-contradicting documentation | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S28 | Maintainability | CONFIRMED | M | God functions and module size | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S29 | Maintainability | CONFIRMED | S | Dead code, an overly wide public API, and redundant guards | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S30 | Bug | SUSPECT | S | `partial_cmp().unwrap_or(Equal)` in `sort_by` on file-derived angles | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S31 | DRY | CONFIRMED | S | Copy-pasted test fixtures and checks with conflicting semantics | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-S32 | Best-practice | CONFIRMED | S | Magic point-coincidence and parameter tolerances scattered through curve sampling | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| PROC-AL-10 | DRY | CONFIRMED | S | IfcDirection / IfcCartesianPoint parsing re-implemented across the sub-area | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-11 | DRY | CONFIRMED | S | Placement matrix applied to alignment samples by hand twice | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-12 | DRY | CONFIRMED | S | "Find the first IFCPROJECT id" scan duplicated | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-13 | Maintainability | CONFIRMED | S | `ifc_type_fn!` OnceLock + `from_str` cache is unnecessary; the variants exist | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-14 | DRY | CONFIRMED | S | STEP binary decoding and `hex_val` live in the texture module instead of core | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-15 | Bug | LIKELY | S | Typed `IFCPARAMETERVALUE` detection duplicated; the circle parameter ignores angle units | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-16 | Bug | LIKELY | S | Horizontal arc accepts an infinite radius; non-strict path emits NaN vertices | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-17 | Bug | SUSPECT | S | Sectioned sort uses `partial_cmp().unwrap_or(Equal)` | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-18 | Bug | LIKELY | S | Vertical segments assumed sorted but never sorted (IFC4x1) | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-19 | Perf | CONFIRMED | S | `compute_parts_to_skip` rebuilds MaterialLayerIndex with an extra full-file scan | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-20 | Maintainability | CONFIRMED | S | Unit-blind "file unit ≈ metre" constants; the stated justification is stale | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-21 | Maintainability | CONFIRMED | S | Stale or contradictory docs in alignment.rs | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-22 | Maintainability | CONFIRMED | S | Other stale docs in the sub-area | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-23 | Quirk | CONFIRMED | S | Alignment processing errors are silently swallowed | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-24 | Perf | CONFIRMED | M | IFC4x3 directrix sampling hard-codes `TessellationQuality::Medium` and rebuilds `IfcSchema` per parse; no per-directrix cache | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-25 | Bug | SUSPECT | S | `MaterialLayerIndex::from_flat` cursor arithmetic can wrap on wasm32 | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-26 | Quirk/Perf | CONFIRMED | S | Texture index casts `i64 as u32` and decodes per-pixel `Vec`s | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-27 | Maintainability | CONFIRMED | M | God functions and file sizes | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-28 | DRY | CONFIRMED | S | Copy-pasted test fixtures | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-29 | DRY | CONFIRMED | M | Two different composite-curve sampling paths feed the alignment | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-30 | Perf | CONFIRMED | S | `AlignmentAxis::from_content` builds a full entity index per handle | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| PROC-AL-9 | DRY | CONFIRMED | S | Boolean attribute reading re-implemented 7× | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| KERNEL-25 | DRY | CONFIRMED | S | `DropAxis` / `Sign` helpers re-implemented at every use | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-26 | DRY | CONFIRMED | S | FNV-1a hashing and test LCGs duplicated | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-27 | Quirk | CONFIRMED | S | `predicates::orient2d` / `orient3d` are `pub` but call `unimplemented!` on legal argument orders; lambda helpers differ in totality | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-28 | Bug | SUSPECT | S | Latent out-of-range index panics in consolidation and AABB clipping (sibling code bounds-checks) | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-29 | Quirk | SUSPECT | S | Exact ray parity silently miscounts grazing hits; no detection or retry | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-30 | Bug | SUSPECT | S | `tritri::line_direction` passes a non-finite direction to the exact tier, which then panics | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-31 | Quirk | CONFIRMED | S | `retriangulate_cleanup`'s "1 mm" tolerance is in caller units, and the 2^-22 literal is duplicated | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-32 | DRY | CONFIRMED | M | Duplicated clipper body and three plane-epsilon formulations (documented, still DRY) | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-33 | Perf | CONFIRMED | M | `plane_weld` promotion is O(cutter_vertices × host_faces) on every subtract and union, outside the budget | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-34 | Best-practice | CONFIRMED | S | The determinism invariant "no FMA / `mul_add`" is enforced only by comments | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-35 | Maintainability | CONFIRMED | S | The generic CDT core depends on the terrain module's error type | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| KERNEL-36 | Maintainability | CONFIRMED | S | Stale comments referencing deleted code and renamed files | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| GEOM-10 | Maintainability | CONFIRMED | S | Crate-level rustdoc and example are stale (non-existent APIs, wrong claims) | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-16 | DRY | CONFIRMED | S | Inline union-find implementations beside `union_find::UnionFind` | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-22 | DRY | CONFIRMED | S | f32-ULP noise scale spelled 9 ways (2^-20 … 2^-23, inline literals) | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-23 | DRY | CONFIRMED | S | zone_split re-implements `kernel::broadphase::tris_aabb` twice | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-24 | Maintainability | CONFIRMED | S | Dead code kept "just in case": PENDING_MAPPED_BOOL_FAILURES, Error::EmptyMesh, create_circle/calculate_circle_segments | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-25 | Maintainability | CONFIRMED | S | `safe_earcut`'s contract doc is attached to `ear_clip`; `safe_earcut` undocumented | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-26 | Quirk | SUSPECT | S | `geom_hash` / weld / tjunction / clash bit-keyed vertex maps treat -0.0 and +0.0 as distinct | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-27 | DRY | CONFIRMED | S | `bool2d` and `contour_bool2d` / `contour_composition` are parallel i_overlay wrappers with drifted sanitisation | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-28 | DRY | CONFIRMED | S | `transform.rs` internal duplication: `parse_cartesian_point_from_id` re-implements `parse_decoded_cartesian_point` | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-29 | DRY | CONFIRMED | S | `curve_source::trim_point` and `trim_angle` duplicate the trim-select parse loop | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-30 | DRY | CONFIRMED | S | IFNS header parsing duplicated between `decode_instanced` and `decode_instance_finishes` | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-31 | Best-practice | CONFIRMED | S | Geometry `[lints.clippy]` blanket allows broader than needed; redundant local allows | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-32 | Quirk | CONFIRMED | S | `diag_warn!` call sites gate the legacy fallback on `debug_assertions`, contradicting diag.rs policy | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-33 | Maintainability | CONFIRMED | S | `world_frame_fixture` shares a source file with `rust/clash` via `#[path = "../../clash/src/..."]` | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-34 | DRY | CONFIRMED | S | Test RNGs duplicated (5x), one mislabelled | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-35 | DRY | CONFIRMED | S | Fuzz-target byte decoders duplicated in `tests/fuzz_regressions.rs` "keep in sync" | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-36 | Best-practice | CONFIRMED | L | Error type is stringly: one catch-all variant used 453 times, plus `Result<_, String>` in analytic/contour/scan_outline | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-37 | Maintainability | CONFIRMED | M | Module-size ratchet produces flat sibling files, `#[path]` attachments and re-export chains instead of directories | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-38 | Quirk | LIKELY | S | `calculate_polygon_normal` / `project_to_2d` / `is_convex` use absolute (scale-dependent) epsilons | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-39 | Quirk | SUSPECT | S | `projection_outline::mesh_outline_2d` passes non-finite projected triangles to i_overlay; area constant off by 2x | [04-geometry-misc.md](04-geometry-misc.md) |
| GEOM-40 | Maintainability | CONFIRMED | S | `opening-perf-trace` feature: 73 cfg sites, undocumented in rust/AGENTS.md feature list | [04-geometry-misc.md](04-geometry-misc.md) |
| PROCESSING-17 | Perf | CONFIRMED | S | Opening filter decodes every window/door (and its whole representation chain) a second time before the metadata phase decodes it again | [05-processing.md](05-processing.md) |
| PROCESSING-21 | DRY | CONFIRMED | S | Three identical `EntityJob` literals, two identical placement closures, two identical fallback-summary literals, and `if x { Vec::new() } else { Vec::new() }` ×3 | [05-processing.md](05-processing.md) |
| PROCESSING-22 | Best-practice | CONFIRMED | S | `scan_shard` family exposes five tuple-returning functions that differ only by how many diagnostics they return | [05-processing.md](05-processing.md) |
| PROCESSING-23 | Quirk | CONFIRMED | S | `/metadata`'s `geometry_count` disagrees with `ModelMetadata.geometry_entity_count` | [05-processing.md](05-processing.md) |
| PROCESSING-24 | Perf | CONFIRMED | S | `georeferencing::extract_georeferencing_with_index` still performs a full `EntityScanner` walk despite holding an index | [05-processing.md](05-processing.md) |
| PROCESSING-25 | Quirk | CONFIRMED | S | Non-deterministic tie order in the CSG summary breakdown (log only) | [05-processing.md](05-processing.md) |
| PROCESSING-26 | DRY | LIKELY | M | `scan_segmentation` / `scan_proposals` options and report types are hand-mirrored into the wasm API; vector types differ per module | [05-processing.md](05-processing.md) |
| PROCESSING-27 | Best-practice | CONFIRMED | S ( | Server `MeshData` wrapper and `symbolic_response.rs` are the only consumer-side type mirrors; FFI/python are clean | [05-processing.md](05-processing.md) |
| PROCESSING-28 | Maintainability | CONFIRMED | S | `_tests.rs` siblings declared from `lib.rs` to stay under a frozen ratchet budget | [05-processing.md](05-processing.md) |
| PROCESSING-APP-11 | DRY | CONFIRMED | S | `valid_guid` duplicates the export crate's GlobalId check | [05-processing.md](05-processing.md) |
| PROCESSING-APP-13 | Perf | CONFIRMED | S | Five full-file scans per plan and two SHA-256 passes over the source | [05-processing.md](05-processing.md) |
| PROCESSING-APP-14 | Perf/DRY | CONFIRMED | S | `mapping::map_item` decodes the ExistingUv map/list entities twice | [05-processing.md](05-processing.md) |
| PROCESSING-APP-15 | DRY | CONFIRMED | S | World-corner reconstruction `f64::from(p) + origin + rtc` hand-rolled in 6 production and 7 test sites | [05-processing.md](05-processing.md) |
| PROCESSING-APP-16 | DRY | CONFIRMED | S | Length-unit-scale validity check repeated (and cross-crate) | [05-processing.md](05-processing.md) |
| PROCESSING-APP-17 | Maintainability | CONFIRMED | M | Shared request metadata hand-copied into `authored::Metadata`; `captured` fakes a frame to reuse the planner | [05-processing.md](05-processing.md) |
| PROCESSING-APP-18 | Maintainability | CONFIRMED | S | `Source::context` is `Option` only for two-phase init; six `ok_or` sites with four different messages | [05-processing.md](05-processing.md) |
| PROCESSING-APP-20 | Maintainability | CONFIRMED | M | Over-fragmented module layout | [05-processing.md](05-processing.md) |
| PROCESSING-APP-21 | Bug | SUSPECT | S | `boundaries[0]` on a `FillShape` with zero rings | [05-processing.md](05-processing.md) |
| PROCESSING-APP-22 | Quirk | CONFIRMED | S | Textured sliver source triangles make `source_density` refuse the whole plan with a misleading message | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-19 | Perf | CONFIRMED | S | Allocation per placement resolution and per point list | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-22 | Maintainability | CONFIRMED | S | Ratchet-dodge file splits with stale justifications | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-23 | Maintainability | CONFIRMED | M | Stringly-typed omission kinds, a dead kind label, and `Result<_, String>` throughout pdf_vector | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-25 | DRY | CONFIRMED | S | `PdfVectorPage` fixture built three times; report test helpers duplicated | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-26 | Quirk | SUSPECT | S | Verdict serialization failure silently hashed as empty bytes | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-27 | Quirk | CONFIRMED | S | Inconsistent error context between fill and stroke composition | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-28 | Quirk | CONFIRMED | S | Symbolic placement doc contradicts itself and hand-rolls an identity test that drops sub-millimetre context offsets | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-29 | DRY | CONFIRMED | S | `IfcColourRgb` read duplicated between symbolic text colour and the style crate's fill leaf | [05-processing.md](05-processing.md) |
| PROCESSING-SYM-30 | Perf | CONFIRMED | S | Per-extraction `GeometryRouter` and overlay-frame detection re-run work the caller already did | [05-processing.md](05-processing.md) |
| CORE-22 | Best-practice | CONFIRMED | S | Error type is mostly dead variants, and every error is `ParseError { position: 0 }` | [06-core.md](06-core.md) |
| CORE-23 | Bug | SUSPECT | S | `decode_by_id` never checks that the parsed id matches the requested id | [06-core.md](06-core.md) |
| CORE-24 | Bug | SUSPECT | S | `ColumnarEntityIndex::from_scan` and `from_hashmap` truncate offsets to u32 with only a `debug_assert` | [06-core.md](06-core.md) |
| CORE-25 | DRY | CONFIRMED | S | Three `EntityDecoder` constructors each spell out all 12 fields | [06-core.md](06-core.md) |
| CORE-26 | DRY | CONFIRMED | S | Unit label tables are duplicated: SI prefix ×3, conversion symbols ×2, US survey foot ×2 | [06-core.md](06-core.md) |
| CORE-27 | Maintainability | CONFIRMED | S | A georef MapUnit comment claims the name table holds the US survey foot; it does not | [06-core.md](06-core.md) |
| CORE-28 | Perf | CONFIRMED | S | `decode_ifc_string` is quadratic on many unterminated `\X2\` or `\X4\` escapes | [06-core.md](06-core.md) |
| CORE-29 | Maintainability | CONFIRMED | S | Limits and tolerances are scattered as magic numbers, not kept in `limits.rs` | [06-core.md](06-core.md) |
| CORE-30 | Best-practice | CONFIRMED | S | Fuzzing covers only `parse_entity`, with four seeds | [06-core.md](06-core.md) |
| CORE-31 | Best-practice | CONFIRMED | M | Scan diagnostics go to a global `OnceLock` sink or `eprintln!` as side effects | [06-core.md](06-core.md) |
| CORE-32 | Quirk | CONFIRMED | S | The tokenizer reads STEP binary literals (`"…"`) as text strings | [06-core.md](06-core.md) |
| CORE-33 | Quirk | CONFIRMED | S | `AttributeValue` accessors are asymmetric | [06-core.md](06-core.md) |
| CORE-34 | Perf | CONFIRMED | S | `IfcType::is_subtype_of` clones, and registry misses allocate | [06-core.md](06-core.md) |
| CORE-35 | DRY | CONFIRMED | S | The header scanner has two near-identical keyword finders and a third argument splitter | [06-core.md](06-core.md) |
| CORE-36 | Maintainability | CONFIRMED | S | Test fixtures are copy-pasted | [06-core.md](06-core.md) |
| CORE-37 | Quirk | CONFIRMED | S | The AttributeValue-based coordinate helpers default missing values to 0, contrary to #5266, and their geometry fallback is effectively unreachable | [06-core.md](06-core.md) |
| CORE-38 | DRY | CONFIRMED | S | `from_hashmap` and `from_hashmap_consuming` take two different sort paths for one conversion | [06-core.md](06-core.md) |
| CORE-39 | Best-practice | CONFIRMED | S | The public surface is wider than it needs to be | [06-core.md](06-core.md) |
| EXPORT-GEOM-11 | Maintainability | CONFIRMED | L | three different instancing implementations feed three writers | [07-export.md](07-export.md) |
| EXPORT-GEOM-12 | Perf | CONFIRMED | S | per-float `String` allocation in the text writers (USD, COLLADA, STEP escape) | [07-export.md](07-export.md) |
| EXPORT-GEOM-13 | Best-practice | CONFIRMED | S | from-meshes public API is 7-11 positional slices plus a boolean trio | [07-export.md](07-export.md) |
| EXPORT-GEOM-14 | Bug | CONFIRMED | S | infallible `export_glb_from_meshes` is public, wraps on wasm32, and ships truncated output as success | [07-export.md](07-export.md) |
| EXPORT-GEOM-15 | Quirk | CONFIRMED | M | USD/OBJ export never fail closed on an empty model and re-parse the file several times | [07-export.md](07-export.md) |
| EXPORT-GEOM-16 | Bug | CONFIRMED | S | KMZ numeric inputs are not validated | [07-export.md](07-export.md) |
| EXPORT-GEOM-17 | Maintainability | CONFIRMED | S | two hand-rolled ZIP writers (KMZ stored-ZIP + `zip` crate for .bos) and a hand-rolled CRC32 | [07-export.md](07-export.md) |
| EXPORT-GEOM-19 | DRY | CONFIRMED | S | STEP-file wrapper and MeshData literal fixtures duplicated across test files | [07-export.md](07-export.md) |
| EXPORT-GEOM-20 | Best-practice | CONFIRMED | S | header/provenance strings differ per writer | [07-export.md](07-export.md) |
| EXPORT-GEOM-7 | DRY | CONFIRMED | S | identifier/name helpers duplicated across USD, IFC5, HBJSON and LandXML | [07-export.md](07-export.md) |
| EXPORT-STEP-17 | DRY | CONFIRMED | S | The same token predicates (`#N` ref, `.ENUM.`) are written six times | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-18 | DRY | CONFIRMED | S | Four `#ref` scanners with different string and overflow policies | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-19 | DRY | CONFIRMED | S | Literal un-doubling plus decoding is re-implemented outside core | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-20 | DRY | CONFIRMED | S | Unit-symbol table duplicated from core with drift; SI prefix list and foot factors repeated | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-21 | DRY | CONFIRMED | S | Two header writers; magic `'2;1'` and the footer literal repeated | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-22 | DRY | CONFIRMED | M | Convert-or-write and the `StepStats` literal are copy-pasted | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-23 | Maintainability | CONFIRMED | M | Long functions and stale `#[allow]`s | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-24 | Maintainability | CONFIRMED | M | Schema, value types and attribute columns are passed as strings and bare numbers | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-25 | Best-practice | CONFIRMED | M | Inconsistent error and stats types across the writer | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-26 | Bug | CONFIRMED | S | Caller-supplied STEP fragments are written unvalidated (record injection) | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-27 | Perf | CONFIRMED | S | Repeated parsing of the header and of unit/relationship records | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-28 | Maintainability | CONFIRMED | S | Keyword case normalisation repeated 37 times, mixing Unicode and ASCII | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-STEP-29 | Maintainability | CONFIRMED | S | Copy-paste test fixtures and helpers | [07a-export-step-writer.md](07a-export-step-writer.md) |
| EXPORT-MERGE-12 | Bug | LIKELY | S | `apply_folds` splits the output on newlines, so a fold into a multi-line source record is lost | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-13 | DRY | CONFIRMED | S | Four copies of the `#N` and `(#a,#b)` parsers, two copies of the `IFCREL` check, three of the "id of a `#N=` line" reader | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-14 | DRY | CONFIRMED | S | The GUID alphabet is defined in three places, with two different minting schemes | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-15 | DRY | CONFIRMED | S | Two STEP REAL formatters; the map writer's exponent branch can never run | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-16 | DRY | CONFIRMED | S | Test oracles use their own `#ref` scanners that have drifted from production | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-17 | Maintainability | CONFIRMED | S | Repeated inline STEP-file wrappers in tests | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-18 | Bug | CONFIRMED | S | `ModelIndex::build` keeps the last span but the first type for duplicate express ids | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-19 | Perf | CONFIRMED | S | Extra full-size copies of the merged output | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-20 | Maintainability | CONFIRMED | M | Two very large functions | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-21 | Maintainability | CONFIRMED | S | Dead parameters and fields, and out-of-date docs | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-MERGE-22 | Best-practice | CONFIRMED | S | Map normalisation uses String errors, reports refusals through two different channels, and mislabels ids | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| EXPORT-DATA-14 | Perf | CONFIRMED | M | Each export rescans the file several times | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-16 | DRY | CONFIRMED | S | Spatial-tree walk and project-node decode duplicated in CSV, IFCX and USD; already drifted | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-17 | DRY | CONFIRMED | S | Quantity kind is a stringly-typed round-trip mapped in four places | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-18 | Maintainability | CONFIRMED | S | Magic attribute indices instead of named schema slots | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-19 | Maintainability | CONFIRMED | M | About 70 inline STEP fixtures and no shared builder | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-20 | Bug / DRY | CONFIRMED | S | Parquet geometry folds the origin in f32 and skips the finiteness gate the other exporters apply | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-21 | Maintainability | CONFIRMED | S | Stringly-typed enums in the energy and analysis models | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-22 | DRY | CONFIRMED | S | HBJSON and DFJSON scaffolding duplicated | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-23 | Maintainability | CONFIRMED | S | Tolerance and threshold literals scattered with no named home | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-24 | DRY | CONFIRMED | S | Bounded-diagnostics collector and rebar limit validation each written several times | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-25 | DRY | CONFIRMED | S | "Is this a product?" logic duplicated; quantity analysis has drifted | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-26 | Quirk | CONFIRMED | S | Rebar schedule falls back to IFC4 layout while the attribute export fails closed | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-27 | Best-practice | CONFIRMED | S | Error handling is inconsistent across sibling exporters | [07c-export-data-model.md](07c-export-data-model.md) |
| EXPORT-DATA-28 | Quirk | CONFIRMED | S | Flattened CSV header names can collide | [07c-export-data-model.md](07c-export-data-model.md) |
| SERVER-30 | DRY | CONFIRMED | S | Admission RSS watermark and `Overloaded` construction duplicated | [08-server.md](08-server.md) |
| SERVER-31 | DRY | CONFIRMED | S | `WriteTimeoutIo` duplicates its poll arms | [08-server.md](08-server.md) |
| SERVER-32 | DRY / Maintainability | CONFIRMED | S | Route table listed in three places; two copies are stale | [08-server.md](08-server.md) |
| SERVER-33 | Maintainability | CONFIRMED | S | Stale and contradictory comments | [08-server.md](08-server.md) |
| SERVER-34 | Maintainability | CONFIRMED | S | Dead dependencies, features, config and variants | [08-server.md](08-server.md) |
| SERVER-35 | Quirk | CONFIRMED | S | Client-caused decompression failures return 500 | [08-server.md](08-server.md) |
| SERVER-36 | DRY / Quirk | CONFIRMED | S | Config parsing has two styles with duplicated defaults, plus an env re-parse | [08-server.md](08-server.md) |
| SERVER-37 | Quirk | SUSPECT | S | Flat mesh table `index_count` disagrees with the written triangles for a ragged index buffer | [08-server.md](08-server.md) |
| SERVER-38 | Perf | CONFIRMED | S | Data-model extractors do repeated full-job scans and per-call uppercasing | [08-server.md](08-server.md) |
| SERVER-39 | DRY | CONFIRMED | S | `resolve_material` repeats the same set-walk three times and the usage arm twice | [08-server.md](08-server.md) |
| SERVER-40 | DRY | CONFIRMED | M | Test scaffolding is heavily copy-pasted | [08-server.md](08-server.md) |
| SERVER-41 | Quirk | SUSPECT | S | `quantize_position` silently saturates | [08-server.md](08-server.md) |
| SERVER-42 | Perf | CONFIRMED | S | Content-hash dedup uses per-element SipHash | [08-server.md](08-server.md) |
| SERVER-43 | Maintainability | CONFIRMED | S | Cache-key namespace definitions are scattered despite the "THE definition" policy | [08-server.md](08-server.md) |
| SERVER-44 | Best-practice | CONFIRMED | S | Error-type sprawl | [08-server.md](08-server.md) |
| SERVER-45 | Quirk | CONFIRMED /  | S | Minor quirks | [08-server.md](08-server.md) |
| EDGE-FFI-10 | DRY | CONFIRMED | S | cloud-import duplicates the IFCX vocabulary owned by export's IFC5 writer | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| EDGE-FFI-11 | DRY | CONFIRMED | S | csg-thread-bench `replay_one` is a copy of processing's bench `replay` | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| EDGE-FFI-12 | Quirk | CONFIRMED | S | Python `alignment_axes` requires UTF-8 and runs on the caller thread, unlike every other entry point | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| EDGE-FFI-13 | Perf | CONFIRMED | S | cloud-import re-parses the GLB for every occurrence, and its doc claims a cache that does not exist | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| EDGE-FFI-14 | Maintainability | CONFIRMED | S | Python crate sits outside every lint lane; panic payloads and cloud-import errors are discarded | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| EDGE-CLASH-10 | Perf | CONFIRMED | S | Two separate AABB BVHs; the clash one allocates per node and tests leaves twice | [09a-clash-zerocopy.md](09a-clash-zerocopy.md) |
| EDGE-CLASH-11 | DRY | CONFIRMED | S | Clash test fixtures copy the same box and packing code many times | [09a-clash-zerocopy.md](09a-clash-zerocopy.md) |
| EDGE-CLASH-12 | DRY | CONFIRMED | M | `[f64;3]` vector helpers are re-written throughout the workspace | [09a-clash-zerocopy.md](09a-clash-zerocopy.md) |
| EDGE-CLASH-13 | Maintainability | CONFIRMED | S | Two doc comments are attached to the wrong function | [09a-clash-zerocopy.md](09a-clash-zerocopy.md) |
| EDGE-CLASH-6 | Maintainability | CONFIRMED | S | The `zero_copy` module name and its docs claim views that don't exist | [09a-clash-zerocopy.md](09a-clash-zerocopy.md) |
| EDGE-CLASH-7 | DRY | CONFIRMED | S | `MeshCollection` lists all 11 fields in four separate places | [09a-clash-zerocopy.md](09a-clash-zerocopy.md) |
| EDGE-CLASH-8 | DRY | CONFIRMED | S | The f32-ULP constant 2^-22 is defined in five places, with stale cross-references | [09a-clash-zerocopy.md](09a-clash-zerocopy.md) |
| EDGE-CLASH-9 | Quirk | CONFIRMED | S | Margin formula computed twice, and differs from TS (comments call it a bit-for-bit port) | [09a-clash-zerocopy.md](09a-clash-zerocopy.md) |
| EDGE-LXMATH-12 | DRY | CONFIRMED | S | The LandXML linear-unit table is duplicated, and the copies handle a blank `elevationUnit` differently | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-13 | DRY | CONFIRMED | S | The WASM probe/inspect endpoints repeat parse-and-find three times and re-implement the superelevation filter | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-14 | DRY | CONFIRMED | S | Station-equation walking and validation are written three times | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-15 | DRY | CONFIRMED | S | Small 2D and validation helpers are copied inside the alignment numeric module and the plan code | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-16 | DRY | CONFIRMED | M ( | Two pairs of model types share a name | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-17 | DRY | CONFIRMED | S | Station-to-segment lookup is reimplemented with different boundary ownership | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-18 | DRY | CONFIRMED | S | Plan source-ID traversal and batch size are duplicated | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-19 | DRY | CONFIRMED | S | Test fixture and terrain error plumbing are duplicated | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-21 | Perf | CONFIRMED | S | Faceless-TIN adaptation clones whole surface collections | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-23 | Maintainability | CONFIRMED | S | `clothoid.rs` is hand-minified onto very long lines | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXMATH-24 | Maintainability | CONFIRMED | M | Error types, codes and tolerance policies are inconsistent across the numeric surfaces | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| EDGE-LXPARSE-18 | DRY | CONFIRMED | S | Text/CDATA-outside-root and nested-element-in-capture rules differ across parsers | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-19 | DRY | CONFIRMED | S | Attribute-to-properties helpers exist three times, with an xmlns difference; Feature/Property parsing exists twice | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-20 | DRY | CONFIRMED | S | Pipe part conversion arms are copy-pasted | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-21 | DRY | CONFIRMED | S | The plan resolver work-budget formula is duplicated across crates | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-22 | Maintainability | CONFIRMED | S | Error codes and error types are inconsistent | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-23 | Bug | CONFIRMED | S | The XML declaration check is skipped when byte 1024 falls inside a UTF-8 character | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-24 | Bug | CONFIRMED | S | Repeated CoordinateSystem warnings are unbounded | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-25 | Perf | CONFIRMED | S | TIN and alignment allocate an unescaped String for every text node | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-26 | Bug | SUSPECT | S | Fragile index arithmetic in plan `start()` | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-27 | Quirk | SUSPECT | S | Degenerate faces are accepted | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-LXPARSE-29 | Maintainability | CONFIRMED | S | Public surface and naming | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| EDGE-WASM-18 | DRY | CONFIRMED | S | The browser don't-bake finalize repeats processing's grouping and template scan | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-19 | DRY | CONFIRMED | S | JSON-request binding helpers are only partly shared, and limits are hard-coded per file | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-20 | DRY | CONFIRMED | S | The ring-set wire format (coords / ringLengths / shapeOffsets) is encoded six times | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-21 | DRY | CONFIRMED | S | Small clones inside batch.rs and grid_lines.rs | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-22 | DRY | CONFIRMED | S | Flat mesh-wire slicing is written three times with different overflow handling | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-23 | DRY | CONFIRMED | S | Test fixtures are copied across crates | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-24 | DRY | CONFIRMED | S | Small duplicates across front-ends | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-25 | Bug | CONFIRMED | S | An `IFCSITE` job is emitted even when the caller disables `IFCSITE` | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-26 | Quirk | SUSPECT | S | Cache keys and decoder seeding that are wrong but currently harmless | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-27 | Best-practice | CONFIRMED | S | Mixed error shapes at the boundary, and silent conversion fallbacks | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-28 | Perf | CONFIRMED | S | Result getters copy whole buffers on every access | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-29 | Maintainability | CONFIRMED | S | Stringly-typed and inconsistent boundary inputs | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-30 | Maintainability | CONFIRMED | S | Dead or duplicated public surface | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-31 | Maintainability | CONFIRMED | S | Stale comments and justifications | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-32 | Quirk | CONFIRMED | S | Inconsistent hostile-input policy for JS mesh operands | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| EDGE-WASM-33 | Quirk | CONFIRMED | S | Two opacity cutoffs | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| XCUT-13 | DRY | CONFIRMED | S | Number/identifier/string formatting helpers duplicated across export and server | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-17 | Maintainability | CONFIRMED | S | Seven declared dependencies are never referenced | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-18 | Maintainability | CONFIRMED | S | 19 crates resolved at multiple versions in Cargo.lock; the python lockfile has drifted from the root one | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-23 | Best-practice | CONFIRMED | S | Hygiene numbers (unsafe, unwrap/expect, allows, TODOs) | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-24 | Maintainability | CONFIRMED | S | Docs-vs-code drift (AGENTS.md / rust/AGENTS.md) | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-25 | Quirk | LIKELY | S | Server mesh-dedup keys use `std` `DefaultHasher`, which has no cross-release stability guarantee | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-28 | DRY | CONFIRMED | S | Polygon normal / area and signed-volume helpers duplicated across crates | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-29 | DRY | CONFIRMED | S | Vertex welding / quantisation grids differ per consumer | [10-cross-cutting.md](10-cross-cutting.md) |
| XCUT-30 | Maintainability | CONFIRMED | S | Mesh container types: four wrappers around one `MeshData` | [10-cross-cutting.md](10-cross-cutting.md) |

