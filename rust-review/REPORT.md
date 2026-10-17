# ifc-lite Rust review: consolidated report

**Date:** 2026-10-15
**Tree:** `main` @ `5bc1dae581`
**Scope:** every Rust crate. That is `rust/{core,geometry,processing,export,landxml,wasm-bindings,clash,ffi,python,cloud-import,csg-thread-bench}` plus `apps/server`: about 440k lines in about 1,500 files, including 54k generated lines.

**Method:**
- Ten area reviewers ran in parallel. Fable handled the router, processing and cross-cutting; Opus handled the rest. Several reviewers delegated sub-areas further.
- Everything was read-only. No cargo build or test was run as part of the review; findings come from reading the code.
- I checked the most severe bug claims against the source myself (marked ✔ below).
- Mechanical inputs: `jscpd`, which found 358 textual clones (1.8% of lines, 215 of them in geometry), and pedantic+nursery clippy (`00-clippy-digest.md`).

**Output:**
- **622 findings** in 18 files: 82 High / 271 Medium / 269 Low.
- By category: DRY 308, Bug 102, Maintainability 89, Perf 62, Quirk 50, Best-practice 27.
- Some findings were reported independently by two reviewers. The themes below deduplicate them, and the count of distinct issues is roughly 560.
- Every finding in the files carries `file:line`, evidence, a fix and an effort estimate. `INDEX.md` lists all 622 in one table.

---

## 1. Headline

1. **The codebase does not lack discipline at the small scale.** unwrap/expect density is 0.4–1.0 per kLOC, there are 5 TODOs in 300 kLOC, HashMap order is kept out of outputs, and overflow arithmetic is mostly checked. **It lacks shared homes at the medium scale.** There is no shared math layer and no single IFC-entity reading layer in core. Each crate and module re-derives placements, points, units, curve sampling, STEP tokenizing, mesh-validity checks and orchestration. Most of the real bugs below are *drift between copies*, not original mistakes.
2. **The same IFC concepts are read 9–14 different ways, with behavioural drift.** Examples are `IfcAxis2Placement3D` (9+ readers), `IfcCartesianPoint`/`IfcDirection` (12 named copies plus ~60 inline triplets), the representation chain (10 walks in the router, 7 in processing), `IFCPROJECT` with its length unit (12–15 scanners) and STEP numeric grammars (4). On null Location, missing 3rd ratio, malformed refs and depth caps, the copies disagree.
3. **"Single home" claims in docs and comments are frequently false.** Examples: `transform.rs:75` says every Axis2 parser shares `build_axis2_matrix`; frame_swap says Z-up→Y-up lives "in one place" (there are six); `rooted_type.rs` says `extract_leading_guid` is "the sole production GlobalId path" (it is test-only); and `schema_pad.rs` justifies its existence by a gap in core that was closed weeks ago. These comments actively mislead the next maintainer.
4. **Native, browser and server run three orchestration paths and have drifted.** Native is `processing`, the browser is `wasm-bindings` with its own batch setup, 6× job discovery and its own colour chase, and the server has its own data model, schema detection and unit resolver. The parity tests check names, not behaviour.
5. **There are four parallel IFC data-model pipelines:** server `data_model`, `export` model/props, `processing` properties, and `python`. They are fed by two schema code generators, one of which is fed from the TypeScript registry. They already render the same property differently.
6. **Several real crash and corruption bugs exist on untrusted input** (§2): one server-killing recursion, panics under `panic=abort`, silent coordinate corruption in LandXML, silent loss of property sets and log edits on export, and wrong geometry in three processors.
7. **God files and functions are concentrated.** `apply_void_context_inner` is 781 lines and 7 levels deep; the processing pipeline function is 1,180 lines with a 26-parameter job fn; `produce_batch` is 579 lines; `prism_cut.rs` is 3,116 lines. There are 54 non-generated functions of ≥200 lines and a 461-row module-size allowlist.

---

## 2. Bugs: fix first

✔ marks bugs I verified in source myself. All others are CONFIRMED or LIKELY by the reviewer who found them; their file has the evidence. The full list of 102 Bug-category findings is in §8.

### 2a. Crash / abort / DoS on untrusted input
| ID | What | |
|---|---|---|
| SERVER-5 | `resolve_material` recurses through `IfcMaterialLayerSetUsage`/`ProfileSetUsage` with no depth limit or visited set. A 3-line self-referencing file overflows the stack, which aborts the whole multi-tenant server even with `panic=unwind`. | ✔ |
| EXPORT-STEP-8 | The positional index in a log mutation (`"@100000000000"`) reaches `attributes.resize(index+1)`, so the log writer hits capacity overflow or OOM. On wasm32, `index+1` wraps and the indexing then panics. | ✔ |
| EDGE-FFI-1 | The 256 MiB "large stack" in Python and the server does not reach the rayon workers that actually run CSG, so deep CSG overflows the stack and kills the interpreter or server. | |
| EDGE-CLASH-1, PROC-S30, PROC-AL-17, GEOM-12 | `sort_by(partial_cmp().unwrap_or(Equal))` on data that can contain NaN. Rust ≥1.81 may panic on a non-total order, which under `panic=abort` traps the wasm instance. Clash meshes contain NaN by design (#5220), and the geometry BVH already fixed this with `total_cmp`. | ✔ (clash) |
| PROCESSING-APP-2 | `evaluated::wire` reaches `unreachable!` on a file-supplied `*` attribute. | |
| SERVER-6/7/8/10/11 | Admission bypasses: cache reads load whole blobs unadmitted; a cached replay drops its slot while the model stays resident; the parquet-stream fill takes a second slot and always times out on a 1-slot host; 500 MB gzip/ifcZIP decompression runs on async workers; the whole upload is copied. | |
| EDGE-LXPARSE-4, -17, -24 | LandXML memory amplification: extension `path` strings grow ~2000×, `child_ordinals` gets one entry per distinct name, and repeated-CoordinateSystem warnings are unbounded. | |
| CORE-5 | A nom parse failure renders the whole unparsed record as a decimal byte list, about 5–10× the record size, on every failed decode. | |

### 2b. Silent wrong output (data loss or corruption)
| ID | What | |
|---|---|---|
| EDGE-LXPARSE-2/3 | No LandXML parser handles quick-xml 0.42's `Event::GeneralRef` (falls through `_ => Ok(())`). `<P>1&#46;5 2 3</P>` becomes northing **15**, and the char-ref cap never applies to text. The streaming parser also desynchronises. | ✔ |
| EXPORT-DATA-1 | The main export reads `RelatingPropertyDefinition` with `as_entity_ref()` only. A list or `IfcPropertySetDefinitionSet` value silently drops all those psets from CSV, JSON, Parquet, IFCX and Python. | ✔ |
| EXPORT-STEP-1 | Records with `) ;` (valid Part 21) silently lose all log edits, because several frame parsers require a literal `");"`. | |
| EXPORT-STEP-3, -9, -10, -11 | The log writer: skips schema conversion for generated lines; its id allocator saturates at `u32::MAX` (producing duplicate ids); drops property mutations it cannot place without counting them; and collapses duplicate express ids silently. | |
| EXPORT-MERGE-1, -8, -9 | An IFC4→IFC2X3 downgrade does not trim attributes for 64 types (e.g. `IFCMATERIAL`, all quantities), so the output is invalid with no warning. IfcAlignment→IFCPROXY keeps the wrong arity. The hand table has two wrong counts. | |
| EXPORT-GEOM-1 | OBJ and USD drop the RTC shift and the IfcSite rotation, so georeferenced models land kilometres off. glTF is correct. | |
| EXPORT-DATA-4/5/6/7 | Energy exporters: DFJSON sorts stories with unscaled absolute and rebased-metric keys mixed together; multi-item spaces produce duplicate Honeybee ids; coordinates pass through f32 before the "precision-preserving" rebase; identifier sanitisers break honeybee-schema. | |
| PROC-S2 | Sampling a clamped B-spline at `t_max` gives an all-zero basis, so a spurious **(0,0,0)** vertex is appended (spikes in surfaces of revolution and composite edges). | ✔ |
| PROC-3 | `IfcTriangulatedFaceSet` ignores `PnIndex`, while `IfcPolygonalFaceSet` honours it. | ✔ |
| PROC-4, PROC-AL-5 | `RevolvedAreaSolid` and `SectionedSolidHorizontal` drop profile holes, so hollow sections render solid. | |
| GEOM-3, PROC-S10, PROC-S5 | The concave-quad normal is reversed and the faceted fast path fans across the wrong diagonal. FacetedBrep fills authored holes when hole triangulation fails, which the advanced-face path explicitly forbids. | |
| PROC-S1, PROC-S7, PROC-13 | Curve samplers have drifted. Parameter-trimmed arcs in advanced faces become full circles. A conic with an `IfcAxis2Placement2D` is sampled in the YZ plane. 3D conic frames can come out NaN or skewed. | |
| PROC-S6 | `IfcFacetedBrepWithVoids` has no processor registered, so IFC2x3 hollow faceted solids render nothing. `SurfaceOfLinearExtrusionProcessor` is never registered either. | |
| PROC-S17/S18/S19 | A malformed half-space deletes the host via `?`. A PBHS boundary that isn't an IfcPolyline makes the unbounded clip over-cut. `IfcBoxedHalfSpace` is treated as unsupported. | |
| PROC-2 | `profile_extractor` is a second pipeline: identity placement for Linear/Grid placements, a default Depth of 1.0, and silent skips. | |
| PROC-5/6 | The 2D composite walker skips `IfcCurveSegment`, so IFC4x3 composite profiles produce empty meshes. | |
| ROUTER-2/26/27, ROUTER-28 | Three of the four mapped-source walks bypass the f64 RTC rebase (#5698) and the curve-cap drain (#4901). Openings with both direct and mapped geometry get their cutter twice. | |
| EDGE-WASM-5, PROCESSING-4 | The browser never arms the #858 indexed-colour split guard, so multi-colour mapped face sets render in one colour. The material fallback colour is "first opaque" natively but "first colour" in wasm. | |
| EDGE-WASM-4 / PROCESSING-2 | A bare-ref `RepresentationMaps` is drawn natively but dropped in the browser and export. | |
| PROCESSING-5 / SERVER-18 | The server's own schema detector is case-sensitive, so `/metadata` and `/parse` report different `schema_version` for the same file. | |
| PROCESSING-SYM-4 | The symbolic 2D pipeline quantises to f32 *before* the RTC rebase, so overlays are off by up to 0.5 m on georeferenced models. | |
| CORE-4, CORE-6, CORE-12 | `IFCLABEL('x')` and the list `('IFCLABEL','x')` are indistinguishable. The tokenizer rejects `.5`/`1E5`, which the fast readers accept, so `get_cartesian_point_fast` succeeds where `decode_by_id` fails. Two CoordIndex grammars disagree on 0. | |
| KERNEL (subtract budget) | The public `mesh_bridge::subtract`/`subtract_many` don't reset or check the #1109 budget, unlike union/intersection, so they can return a partial arrangement as a normal result. | |
| EDGE-LXMATH-1/9/10/11 | LandXML: parcel arcs use an absolute 1e-9 tolerance that refuses real georeferenced parcels; IrregularLine probes fail at the segment end; a 32-ULP length check rejects rounded producer files; assumed units scale elevations opposite to the declared-unit default. | |
| EDGE-WASM-13 | `exportMerged` throws from inside a `&self` method, which leaves the borrow flag held so `free()` fails, and leaks memory. | |
| EDGE-WASM-14 | FFI uses `read_to_string`, so Latin-1 IFC files are rejected. | |

---

## 3. DRY: cross-crate themes (deduplicated)

These are the structural problems behind most of the bugs. Each theme lists the reviewer IDs that cover it and the proposed single home. Within-module DRY items (≈250 more) are in the per-area files.

| # | Concept | Copies today | Findings | Single home |
|---|---|---|---|---|
| A | **IFC placement, point and direction reading** | 9+ Axis2Placement3D readers; 12 named point readers plus ~60 inline `coords.first()…unwrap_or(0.0)`; 2 Axis1 readers; the placement chain walked 9× (depth caps 50 vs 100) | XCUT-1/2, ROUTER-3, PROC-1, PROC-S7/S9, GEOM-1/2, PROCESSING-SYM-2/6, PROC-AL-10 | `ifc_lite_core` (or a new `ifc-lite-model`): `point3/direction3`, `Axis2Placement::{from_2d,from_3d}` → `build_axis2_matrix`, `placement::resolve_chain`. One null/dangling/2-vs-3D policy, refusing rather than defaulting to 0 (#3421). |
| B | **Representation-graph walk** (product → shape → reps → items → mapped → map) | 10 in the router, 7 in processing, plus wasm and profile_extractor | ROUTER-1/2/4/28, PROCESSING-6, PROC-2, EDGE-WASM-1, PROCESSING-3 | One `RepresentationWalk` visitor in processing or geometry with one cycle guard and the `meshed_representations` de-dup. The four "mapped-source walks" collapse into `process_representation_item`. |
| C | **STEP grammar readers** | core alone has ~9 readers (5 string-literal walks, 4 numeric grammars, 4 type-name extractors, 4 ref-list readers); export adds ~11 record-frame parsers, 5 argument splitters, 2 slot validators, 7 trivia skippers, 4 `#ref` scanners | CORE-1/6/8/9/10/13, EXPORT-STEP-1/2/6/7/17/18/19, EXPORT-MERGE-5/6/13 | core `parser::{lexical, numeric_literal, StepListItems}`, extended with `StepRecord::parse` (tolerates trivia before `;`) and one `split_top_level_args` with grammar options. Add a differential fuzz target across all grammars (CORE-30). |
| D | **Units and IFCPROJECT** | 7+ unit resolvers with different policies; 12–15 IFCPROJECT scanners; 3 SI-prefix tables; 2 LandXML unit tables; US-survey-foot constant truncated in core | CORE-2/3, XCUT-6, EDGE-WASM-8, EXPORT-DATA-9, EXPORT-STEP-20, PROC-AL-12, EDGE-LXMATH-12, EDGE-LXPARSE-6, SERVER (data_model) | `ProjectUnits` plus `EntityDecoder::length_unit_scale()` (cached). Ban ad-hoc project scans. `US_SURVEY_FOOT_M = 1200.0/3937.0`. |
| E | **Math layer** (vec3, mat4, AABB, tolerances) | `[f64;3]` vector helpers ×14 in 5 crates; row-major mat4 ×4; AABB folds ~40; Z-up↔Y-up frame swap in 6 "single homes" (export alone ~10 incl. 3 conventions; the server adds 3); normalize ε in {0, 1e-12, 1e-10, 1e-9, 1e-6, 1e-4}; affine-inverse det 1e-18 vs 1e-24 | XCUT-3/4/5/8/12, EDGE-CLASH-2/8/12, EXPORT-GEOM-3, PROCESSING-10..13, SERVER-15, EDGE-WASM-9, PROC-S8 | A zero-dependency `ifc-lite-math` crate (v3/mat4/Aabb3/`tol`/`frame`), which clash can also depend on. The tolerance module must document units, since several "1 mm floors" are absolute file-unit values (PROC-S14, KERNEL tolerances, PROC-AL-20). |
| F | **IFC data model** (psets, quantities, materials, spatial tree, type relations) | 4 pipelines (server, export, processing, python) and 2 schema generators; 4 `RelDefinesByType` resolvers with 3 conflict policies; 2 property-value decoders; 4 AttributeValue→JSON converters | XCUT-7, SERVER-3/4/28, EXPORT-DATA-1/2/3/8/17/18, PROCESSING-APP-1, CORE-4 | Split export's entity-data code into an `ifc-lite-model` crate that the server depends on. Delete the server's `data_model/{properties,quantities,relationships,materials}` and its TS-fed generator. Make typed values a real `AttributeValue::Typed`. |
| G | **Native vs browser orchestration** | STEP-keyword scan dispatch ×6; geometry-job discovery ×6 (#1910 patched 3×); type-geometry sets ×3; router arming duplicated; IndexedColourMap collection ×2; don't-bake finalize ×2 | PROCESSING-1/2/3/4/7, EDGE-WASM-1..7/10/18 | `processing::prepass::Discovery` visitor plus `BatchRouterConfig::build()` plus a public `resolve_element_color`. The wasm layer becomes wire encoding only. |
| H | **Curve sampling and planar face triangulation** | 3 IFC curve samplers in geometry plus a 4th in symbolic; 4 composite-curve walkers; 4 trimmed-curve interpreters; clothoid integrated 3 ways; vertical curves 5 ways (the IFC4x1 arc uses a parabola, ~0.9 m off at R=100); face-bound extraction ×3; planar face triangulation ×3 | PROC-S1/S3/S4/S13, PROC-5/6/11, PROCESSING-SYM-3, PROC-AL-3/4/29, EDGE-LXMATH-2/7/17 | `profiles::get_curve_points` as the single sampler; `triangulate_planar_face`; `ifc_lite_geometry::{clothoid_integral, vertical_curve, locate}`, also used by landxml. |
| I | **Mesh-validity oracles** (open edges, watertight, signed volume, point-in-mesh, PIP, union-find) | open-edge counting ~30 in kernel and 40+ in geometry tests, with incompatible definitions; signed volume ×6 (production) + 20–27 (tests); 9 edge-pairing walks in voids; union-find ×4 beside an unused `crate::union_find` | KERNEL-2, ROUTER-5..10, GEOM-5, PROC-S31 | One `mesh_check` module (`EdgeLedger`, `signed_volume`, `is_closed`) exported to tests via a `test-support` feature. Today "watertight" in one test does not mean the same as in another. |
| J | **Schema metadata** | per-schema attribute data 5+ times; schema-family detection ×9 (case, trim and default differ); a hand table with wrong counts | EXPORT-MERGE-2/4/9, EXPORT-STEP-12/24, PROCESSING-5, SERVER-18, CORE-7 | core `SchemaVersion` registry plus one `SchemaFamily::from_label`. Export's generated tables stay only for what core lacks, with a test that cross-checks arity. |
| K | **LandXML XML front-ends** | 4 parser front-ends (pull loop, consume_event, start/end prologue, frames, budgets ×17); 2 tokenizers; 2 encoding normalisers; coordinate parsing ×10; alignments parsed twice into 2 public types | EDGE-LXPARSE-1/5/9/10/11/12/14, EDGE-LXMATH-15/16 | One `xml::driver` with a `FamilyHandler` trait, a `Budget` type and one `TokenScanner`. Fixing GeneralRef there fixes it in all four parsers. |
| L | **Server HTTP scaffold** | extract→admit→cache→spawn_blocking→write→respond ×6 handlers plus ×4 cache readers; 5 different corrupt-cache policies | SERVER-1/2/12/13/14 | One `parse_route<Req, Out>` combinator and one `CacheEntry` reader. |
| M | **Exporter assembly** | 3 glTF assemblers (~1,300 duplicated lines); 7 "renderable mesh" checks with 3 non-finite policies; 8+ number formatters (2 STEP REAL writers that disagree); 2 header writers; HBJSON/DFJSON room dedupe and Ladybug scaffolding ×2 | EXPORT-GEOM-2/4/6, EXPORT-STEP-4/21/22, EXPORT-DATA-10/11/22 | A shared export-pipeline core (`mesh_input::is_exportable`, `step_real`, `Emitter`, `ladybug` module). |
| N | **GUID, hash, boolean/logical parsing** | GUID alphabet ×3 with 2 minting schemes and 2 validators (one too lax); FNV ×3; STEP boolean/logical parsing ×11+ (`.U.` true in some, false in others) | EXPORT-MERGE-3/14, XCUT-9..13, PROC-S11, PROC-AL-9, EDGE-WASM-24 | `core::guid`, `core::hash`, `AttributeValue::as_logical()`. |
| O | **Test infrastructure** | `read_fixture` ×28 (27 distinct bodies; only ~37 files honour `IFC_LITE_REQUIRE_FIXTURES`, so the rest skip silently in CI); inline STEP fixture headers in the hundreds; 71 `issue_*` geometry test binaries | GEOM-4/5, PROCESSING-20, EXPORT-STEP-29, EXPORT-DATA-19, EXPORT-MERGE-17, EDGE-WASM-23, XCUT-22 | An `ifc-lite-testkit` dev crate: fixture resolution and skipping, `step_file(schema, lines)`, mesh oracles. Fold `issue_*` binaries into topic harnesses. |

---

## 4. Best practice and long-term maintainability

- **Error policy** (XCUT-15). Seven coexisting styles. `Error::geometry(String)` is called 451 times, so the typed enum is a String wrapper in practice. There are 258 `Result<_, String>`, 41 `Box<dyn Error>` in landxml, 85 JS string errors, and some control flow keyed on message text (EXPORT-STEP-16, EDGE-LXPARSE-8/22). Proposal: one thiserror enum per crate with `kind()`, a `#[from]` chain, and a ratchet of `Result<_, String>` in `pub` signatures down to 0.
- **Dependencies** (XCUT-16..18). `[workspace.dependencies]` lists only internal crates; nalgebra/serde/rayon/etc. are declared 2–8 times. `sha2` is split between 0.10 and 0.11, so two digest stacks are compiled. There are 7 unused deps. Internal deps are declared three different ways. `rust/python` and the bench crate skip workspace lints. Fix: `cargo autoinherit` plus `cargo machete` in CI.
- **Hidden runtime config** (XCUT-20, GEOM-20). 13 `IFC_LITE_*` env flags read into `OnceLock`s, using 4 on/off conventions (`IFC_LITE_LOCAL_FRAME=0` turns the feature *on*); 5 global atomics; 13 Cargo features with mixed naming. Proposal: a `GeometryConfig` struct passed down explicitly.
- **Public surface** (GEOM-9/10, CORE-20..22, PROC-S29, EDGE-WASM-30):
  - geometry re-exports 60 unused items at the crate root, and its crate doc example calls APIs that don't exist;
  - core ships dead `streaming.rs` (pulling in futures deps), most of the `fast_parse` TFS path, `IfcSchema.geometry_types` (threaded through 43 signatures, read nowhere) and 4 of 6 unused `Error` variants;
  - in wasm, `scanGeometryEntitiesFast` has no caller and disagrees with the real discovery.
- **Generated code** (CORE-7). Five full `IfcType` enums, each with ~10 parallel 1000-arm matches, under `#![allow(dead_code)]`. They are ~5× larger than needed and account for 14.6k of core's 14.9k pedantic warnings.
- **God functions/files** (ROUTER-33, PROCESSING-8, EDGE-WASM-17, EXPORT-STEP-23, EXPORT-DATA-15, EXPORT-MERGE-20, EDGE-LXMATH-22, XCUT-21). Add a function-length ratchet next to the module-size one. The module-size allowlist has 461 rows and some generous slack (gltf.rs has 938 spare lines).
- **The f32-before-rebase pattern** keeps coming back (PROCESSING-SYM-4, EXPORT-DATA-6, EXPORT-DATA-20, EXPORT-GEOM-1). rust/AGENTS.md documents the RTC rule for the mesher only. Every exporter and overlay that bypasses the orchestrator re-learns it.
- **Panic-safety pattern.** `partial_cmp().unwrap_or(Equal)` inside `sort_by` appears in ≥5 places, and `unreachable!` in error-mapping arms. Under `panic=abort` either aborts the whole wasm instance. A clippy `disallowed_methods`/grep gate for `unwrap_or(Ordering::Equal)` would catch the whole class.
- **Fuzzing** (CORE-30). There is one target with 4 seeds. Nothing fuzzes the scanner, `StepListItems`, `decode_ifc_string`, the header reader or LandXML. Nothing runs the grammars against each other differentially, which would have caught most of theme C.
- **Stale docs.** These are all over the per-area files (XCUT-24, PROC-S27, EDGE-WASM-31, EXPORT-MERGE-21, ...): references to deleted kernels (BSP, Manifold), deleted files (`gpu_meshes.rs`, `zero_copy.rs`), wrong line numbers, and contradictory comments. Some are user-visible, e.g. the diagnostic string "(BSP unsafe)".
- **Clippy blanket allows** in geometry (`too_many_arguments` covers 12 sites, `should_implement_trait` 4) could be local (GEOM-31).

## 5. Inefficiencies worth doing

- ROUTER-21/20: each opening is meshed 3–5× per host, and `extend_opening_mesh_through_host` (two full host scans plus rays) runs up to 5× per cutter. ROUTER-22: `geometry_hash_cache` deep-clones its `Arc` on every return, so the cache costs more than it saves.
- EXPORT-STEP-13/14/15: the log export does O(records × created) linear scans. The plain export builds an every-id HashSet and copies every record. Argument splitting allocates ~40 times per record and runs on every `IFCREL*` line.
- EXPORT-DATA-12/13/14: single-pass scans use the caching decoder (an unbounded cache plus a clone per entity). Flattened CSV is O(entities × columns × props). Each export rescans the file several times.
- EXPORT-MERGE-10/11: a merge copies every line to a String before type-checking it, and builds the model index and unit scale 2–3× each.
- EDGE-WASM-15/16: the streaming pre-pass deep-copies the whole id index to emit one meta event. Overlays re-transcode and re-index the whole file on every toggle.
- EDGE-LXPARSE-8/14/15/16: the pull "canonical document" re-parses the input 3–4×. Namespace maps are cloned per element per parser. Stream transport copies every byte about 5×, one byte at a time.
- EDGE-LXMATH-20, PROC-AL-6: every alignment probe re-validates the whole alignment and searches segments linearly. The arc-length map does a full evaluation per step.
- KERNEL: `union_all` lacks the BVH and f64-cache acceleration that the binary path has. Retriangulation recomputes I1024 lambdas the interner already caches.
- PROC-16: `rect_fast` work is capped by opening count, not cell count, so a single element can cost ~10¹⁰ operations.
- EDGE-CLASH-5: the clash session holds up to three copies of each element's geometry.

---

## 6. Recommended roadmap

This combines the cross-cutting, router and processing "Target shape" sections. Bug fixes in §2a/§2b should land independently and first; most are S effort.

1. **Manifest hygiene** (S): workspace dependency inheritance, align `sha2`, delete unused deps, `cargo machete`, lints on python/bench. This unblocks the crate moves below.
2. **`ifc-lite-math`** (M): v3/mat4/Aabb3/tolerances/frame swap, used by every crate including clash. Themes E and I (partly).
3. **Core owns IFC entity reading** (M): placements, points, directions, placement chain, `ProjectUnits`, the IFCPROJECT locator, `as_logical`, `AttributeValue::Typed`, GUID and hash. Themes A, D, N. This fixes several §2b drift bugs as a side effect.
4. **One STEP grammar** (M): `StepRecord`, one splitter, one numeric grammar, comment/trivia handling, plus a differential fuzz target. Theme C. This fixes EXPORT-STEP-1, CORE-6, EXPORT-MERGE-5.
5. **Router restructure** (L): one `RepresentationWalk`; mapped walks routed through `process_representation_item`; an ordered `CutStrategy` list replacing `apply_void_context_inner`; one `EdgeLedger`; split `GeometryRouter`'s 30 fields into `RouterConfig`, `SharedCaches` and `RouterDiagnostics` (01-geometry-router.md, "Target shape").
6. **One orchestration API** (L): `process(content, &ProcessingRequest, &mut dyn ProcessingSink)` replacing the 12 `process_geometry*` entry points. A `Discovery` visitor and `BatchRouterConfig` shared with wasm, so the wasm layer is wire encoding only (05-processing.md, "Target shape"). Theme G.
7. **`ifc-lite-model`** (L): the data-model crate the server consumes. Delete the server's fourth pipeline and the TS-fed generator; per-schema attribute data comes from core. Themes F, J.
8. **Shared curve sampler and face triangulator** in geometry, also consumed by symbolic and landxml (M). Theme H.
9. **Error policy and `GeometryConfig`/`WorkObserver`** (M–L, crate by crate). §4.
10. **`ifc-lite-testkit`** (M): fixtures, STEP builders, mesh oracles; fold `issue_*` binaries into topic harnesses; make `IFC_LITE_REQUIRE_FIXTURES` universal. Theme O.

LandXML is self-contained: the `xml::driver` refactor (theme K) can run in parallel with all of the above.

---

## 7. Files

All files are in `~/rust-review/`.

| File | High | Med | Low | Total |
|---|---|---|---|---|
| [01-geometry-router.md](01-geometry-router.md) | 7 | 22 | 22 | 51 |
| [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) (+ index of 02a/02b) | 4 | 12 | 12 | 28 |
| [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) | 4 | 18 | 10 | 32 |
| [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) | 0 | 8 | 22 | 30 |
| [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) | 3 | 21 | 12 | 36 |
| [04-geometry-misc.md](04-geometry-misc.md) | 5 | 14 | 21 | 40 |
| [05-processing.md](05-processing.md) (incl. symbolic/pdf_vector + appearance) | 16 | 36 | 28 | 80 |
| [06-core.md](06-core.md) | 6 | 15 | 18 | 39 |
| [07-export.md](07-export.md) (glTF/USD/COLLADA/OBJ/terrain + cross-area themes) | 2 | 8 | 10 | 20 |
| [07a-export-step-writer.md](07a-export-step-writer.md) | 3 | 13 | 13 | 29 |
| [07b-export-merge-schema.md](07b-export-merge-schema.md) | 2 | 9 | 11 | 22 |
| [07c-export-data-model.md](07c-export-data-model.md) | 1 | 13 | 14 | 28 |
| [08-server.md](08-server.md) | 10 | 18 | 16 | 44 |
| [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) (synthesis + FFI/python) | 1 | 8 | 5 | 14 |
| [09a-clash-zerocopy.md](09a-clash-zerocopy.md) | 1 | 4 | 8 | 13 |
| [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) | 1 | 12 | 11 | 24 |
| [09c-landxml-parsing.md](09c-landxml-parsing.md) | 4 | 14 | 11 | 29 |
| [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) | 5 | 12 | 16 | 33 |
| [10-cross-cutting.md](10-cross-cutting.md) | 7 | 14 | 9 | 30 |

Supporting material:
- [INDEX.md](INDEX.md): every finding in one table.
- [00-clippy-digest.md](00-clippy-digest.md): 30k pedantic warnings, mostly generated code.
- `jscpd-clones.txt`: the 358 textual clones, by crate.
- `raw/`: verbatim sub-agent outputs.

**Caveats:**
- Findings were made by reading code. Nothing was executed, and no failing test was written for any finding.
- Treat LIKELY and SUSPECT as hypotheses to reproduce before fixing.
- About 60 findings overlap across reviewers (themes A–G especially). Fix by theme, not by ID.

---

## 8. All Bug-category findings (102)

| Sev | ID | Conf. | Title | File |
|---|---|---|---|---|
| High | PROC-2 | CONFIRMED | `profile_extractor.rs` is a parallel element→placement→mapped-item→extrusion pipeline that has already drifted from the mesh path (misplaces linear/grid-placed elements) | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| High | PROC-3 | CONFIRMED | `IfcTriangulatedFaceSet` ignores `PnIndex` while `IfcPolygonalFaceSet` honours it | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| High | PROC-4 | CONFIRMED | `RevolvedAreaSolidProcessor` revolves only `profile.outer`; holes are dropped and winding ignores profile orientation | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| High | PROC-S2 | CONFIRMED | Spurious `(0,0,0)` point appended to every clamped B-spline sampled by `sample_curve_polyline` | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| High | GEOM-3 | CONFIRMED | `calculate_polygon_normal` returns a reversed normal for concave quads; faceted fast path fans concave quads across the outside diagonal | [04-geometry-misc.md](04-geometry-misc.md) |
| High | PROCESSING-4 | LIKELY | Element-level material fallback colour drifts between native ("first opaque") and wasm ("first colour") | [05-processing.md](05-processing.md) |
| High | PROCESSING-5 | CONFIRMED | `apps/server` has its own `detect_schema_version` that disagrees with processing's | [05-processing.md](05-processing.md) |
| High | PROCESSING-APP-2 | LIKELY | `evaluated::wire` panics (`unreachable!`) on a file-supplied `*` attribute | [05-processing.md](05-processing.md) |
| High | PROCESSING-SYM-4 | CONFIRMED | f32 pipeline quantises georeferenced coordinates BEFORE the RTC/site rebase — overlay misaligned by up to 0.5 m at 5,000 km | [05-processing.md](05-processing.md) |
| High | CORE-5 | CONFIRMED | A nom parse failure builds an error string 5-10× the size of the record | [06-core.md](06-core.md) |
| High | EXPORT-GEOM-1 | CONFIRMED | OBJ and USD exporters drop the RTC shift and the IfcSite rotation, so georeferenced/site-placed models land in the wrong place | [07-export.md](07-export.md) |
| High | EXPORT-STEP-3 | CONFIRMED | Log writer skips schema conversion and IFC2X3 slot-fill for generated, rewritten and georef records | [07a-export-step-writer.md](07a-export-step-writer.md) |
| High | EXPORT-MERGE-1 | CONFIRMED | The Rust schema converter does not trim attributes the target schema lacks, except for 30 hand-listed types | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| High | EXPORT-DATA-1 | CONFIRMED | `RelatingPropertyDefinition` parsed three ways; the main export drops `IfcPropertySetDefinitionSet` entirely | [07c-export-data-model.md](07c-export-data-model.md) |
| High | SERVER-10 | CONFIRMED | gzip / `.ifcZIP` decompression runs on the async runtime | [08-server.md](08-server.md) |
| High | SERVER-5 | CONFIRMED | Unbounded recursion in `resolve_material` – a crafted file aborts the whole server | [08-server.md](08-server.md) |
| High | SERVER-6 | CONFIRMED | Cache-read routes and probe gates read whole blobs into memory with no admission | [08-server.md](08-server.md) |
| High | SERVER-7 | CONFIRMED | Cached replay drops its admission slot but keeps the whole model resident for the drain | [08-server.md](08-server.md) |
| High | SERVER-8 | CONFIRMED | parquet-stream data-model fill takes a second admission slot while the stream holds the first | [08-server.md](08-server.md) |
| High | EDGE-FFI-1 | CONFIRMED | Python's (and the server's) "large stack" does not reach the rayon workers that run the CSG | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| High | EDGE-CLASH-1 | LIKELY | Clash BVH sorts with a comparator that breaks on NaN, which can panic and abort the shared wasm module | [09a-clash-zerocopy.md](09a-clash-zerocopy.md) |
| High | EDGE-LXPARSE-2 | CONFIRMED | Entity and character references in element text are silently dropped (quick-xml 0.42 `Event::GeneralRef` is never handled) | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| High | EDGE-LXPARSE-3 | LIKELY | The streaming session desynchronises when one text token produces more than one event | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| High | EDGE-LXPARSE-4 | CONFIRMED | Extension-root `path` strings amplify memory roughly 2000x | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| High | EDGE-WASM-5 | LIKELY | The browser's don't-bake path does not arm the #858 indexed-colour split guard | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| Medium | ROUTER-26 | LIKELY | Curve-capped flag (#4901) not drained on two of the four source walks | [01-geometry-router.md](01-geometry-router.md) |
| Medium | ROUTER-27 | LIKELY | Raw-coordinate items inside mapped sources never get the f64 RTC rebase | [01-geometry-router.md](01-geometry-router.md) |
| Medium | PROC-13 | CONFIRMED | 3D conic placement reader produces NaN or skewed frames; full circles and trimmed circles use different frames | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| Medium | PROC-14 | CONFIRMED | CoordIndex fast path and slow path disagree on malformed input; validator explicitly allows `-` | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| Medium | PROC-15 | CONFIRMED | `IfcCompositeProfileDef` turns every sub-profile after the first into a hole | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| Medium | PROC-S10 | CONFIRMED | Concave quads are fanned across the wrong diagonal in faceted Breps and surface models | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| Medium | PROC-S16 | LIKELY | `SameSense=.F.` flips loop-derived planar triangulations, where the loops already give the face normal | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| Medium | PROC-S17 | CONFIRMED | A malformed half-space returns `Err` through `?`, which deletes the boolean host | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| Medium | PROC-S18 | LIKELY | The PBHS boundary accepts only `IfcPolyline`, so other boundaries fall back to an unbounded over-cut | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| Medium | PROC-S21 | CONFIRMED | Unresolvable points are silently skipped rather than refusing the curve | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| Medium | PROC-S5 | CONFIRMED | FacetedBrep fills authored holes when hole triangulation fails | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| Medium | PROC-S6 | CONFIRMED | `IfcFacetedBrepWithVoids` has no processor, and `SurfaceOfLinearExtrusionProcessor` is never registered | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| Medium | PROC-AL-5 | CONFIRMED | IfcSectionedSolidHorizontal drops profile holes (hollow sections render solid) | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| Medium | KERNEL-17 | LIKELY | Bug: public `mesh_bridge::subtract` / `subtract_many` do not reset or check the #1109 budget | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| Medium | GEOM-12 | LIKELY | SpacePlate (space_dcel) public/wasm edit API accepts NaN; non-total sort comparators can panic | [04-geometry-misc.md](04-geometry-misc.md) |
| Medium | PROCESSING-SYM-15 | LIKELY | `IfcIndexedPolyCurve.Segments` ignored — arcs drawn as chords, index lists ignored | [05-processing.md](05-processing.md) |
| Medium | PROCESSING-SYM-16 | LIKELY | Placement-chain cap of 50 vs shared `MAX_PLACEMENT_DEPTH = 100` silently relocates deep products to the origin | [05-processing.md](05-processing.md) |
| Medium | PROCESSING-SYM-17 | LIKELY | Unresolvable trims fabricate an arc; trimmed `IfcLine` silently dropped | [05-processing.md](05-processing.md) |
| Medium | CORE-11 | LIKELY | `get_face_bound_fast` tests "OUTER" case-sensitively, so CamelCase files lose outer-bound detection | [06-core.md](06-core.md) |
| Medium | CORE-12 | CONFIRMED | IfcTriangulatedFaceSet `CoordIndex` is parsed by two core grammars with different index rules, after already being decoded | [06-core.md](06-core.md) |
| Medium | CORE-13 | CONFIRMED | `model_bounds` has its own point, ref and number readers; the placement filter uses an unscaled `1000.0`; and it scans the file up to three times | [06-core.md](06-core.md) |
| Medium | CORE-14 | CONFIRMED | The ePSet_MapConversion fallback accepts non-finite Eastings, Northings and Height; the IfcMapConversion path refuses them | [06-core.md](06-core.md) |
| Medium | CORE-15 | LIKELY | `extract_length_unit_scale` accepts infinite conversion factors and invents 1.0 for unreadable ones | [06-core.md](06-core.md) |
| Medium | CORE-9 | CONFIRMED | The scanner's DATA-section skip and the header reader disagree on where `DATA;` is | [06-core.md](06-core.md) |
| Medium | EXPORT-GEOM-9 | CONFIRMED | `export_gltf_streaming` returns a schema-invalid empty glTF instead of failing closed | [07-export.md](07-export.md) |
| Medium | EXPORT-STEP-10 | CONFIRMED | Plain writer silently drops property mutations it cannot place | [07a-export-step-writer.md](07a-export-step-writer.md) |
| Medium | EXPORT-STEP-5 | CONFIRMED | Integer and number serialisers emit non-STEP tokens (`NaN`, `Infinity`, `1e+21`); REAL non-finite policy inconsistent | [07a-export-step-writer.md](07a-export-step-writer.md) |
| Medium | EXPORT-STEP-8 | CONFIRMED | Positional index from the log can force a huge allocation or index-out-of-bounds panic | [07a-export-step-writer.md](07a-export-step-writer.md) |
| Medium | EXPORT-STEP-9 | CONFIRMED | Log writer's id allocator saturates at `u32::MAX`, unlike the plain writer | [07a-export-step-writer.md](07a-export-step-writer.md) |
| Medium | EXPORT-MERGE-8 | CONFIRMED | Downgrading IfcAlignment/IfcReferent to IFCPROXY keeps the source attributes, producing a short, invalid IfcProxy | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| Medium | EXPORT-MERGE-9 | CONFIRMED | Two wrong counts in the hand-written IFC2X3 attribute table | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| Medium | EXPORT-DATA-4 | CONFIRMED | DFJSON story order mixes unscaled absolute `Elevation` with rebased metric floor heights | [07c-export-data-model.md](07c-export-data-model.md) |
| Medium | EXPORT-DATA-5 | LIKELY | An `IfcSpace` with more than one extruded item gives duplicate HBJSON/DFJSON identifiers | [07c-export-data-model.md](07c-export-data-model.md) |
| Medium | EXPORT-DATA-6 | LIKELY | HBJSON/DFJSON coordinates already passed through f32; the "rebase keeps survey precision" comment is wrong | [07c-export-data-model.md](07c-export-data-model.md) |
| Medium | EXPORT-DATA-7 | LIKELY | Two Honeybee identifier sanitizers, drifted from each other and from honeybee-schema | [07c-export-data-model.md](07c-export-data-model.md) |
| Medium | EXPORT-DATA-8 | CONFIRMED | The JSON number allowlist misses most IFC measure types, so numbers become strings | [07c-export-data-model.md](07c-export-data-model.md) |
| Medium | SERVER-12 | CONFIRMED | Five different policies for an unusable cache entry; three of them return 500 forever | [08-server.md](08-server.md) |
| Medium | SERVER-14 | CONFIRMED | Length-prefixed section framing written 4×, read 3×+; the data-model framer is unguarded | [08-server.md](08-server.md) |
| Medium | SERVER-18 | CONFIRMED | Schema detection is duplicated, and `/parse/metadata` disagrees with `/parse` | [08-server.md](08-server.md) |
| Medium | SERVER-26 | LIKELY | Material association rows multiply elements × layers with no cap | [08-server.md](08-server.md) |
| Medium | SERVER-29 | LIKELY | Slow uploads hold admission permits; no body read-progress timeout | [08-server.md](08-server.md) |
| Medium | EDGE-FFI-2 | CONFIRMED | FFI rejects IFC files that are not valid UTF-8 (merges EDGE-WASM-14) | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| Medium | EDGE-FFI-5 | LIKELY | Non-finite floats silently become JSON `null` on every Python JSON entry point except `rebar_schedule` | [09-landxml-bindings-clash.md](09-landxml-bindings-clash.md) |
| Medium | EDGE-LXMATH-9 | CONFIRMED | `IrregularLine` probes fail at the segment end when the declared length exceeds the polyline length | [09b-landxml-alignment-math.md](09b-landxml-alignment-math.md) |
| Medium | EDGE-LXPARSE-17 | LIKELY | TIN `child_ordinals` keeps one entry per distinct child name (memory amplification) | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| Medium | EDGE-LXPARSE-7 | CONFIRMED | `assumed_linear_unit` is honoured only by TIN; pipe, plan and alignment ignore it | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| Medium | EDGE-WASM-13 | CONFIRMED | `exportMerged` uses `throw_str` inside a `&self` method | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| Medium | EDGE-WASM-14 | CONFIRMED | FFI rejects IFC files that are not valid UTF-8 | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |
| Medium | XCUT-26 | CONFIRMED | `read_conic_placement_3d` normalises a possibly-zero axis without a guard (NaN frame) | [10-cross-cutting.md](10-cross-cutting.md) |
| Low | ROUTER-28 | LIKELY | Opening probes mesh a `MappedRepresentation` even when direct body geometry exists | [01-geometry-router.md](01-geometry-router.md) |
| Low | ROUTER-29 | CONFIRMED | Processor-failure sweep order depends on `std::HashMap` iteration | [01-geometry-router.md](01-geometry-router.md) |
| Low | ROUTER-30 | SUSPECT | `partial_cmp().unwrap()` on half-extents | [01-geometry-router.md](01-geometry-router.md) |
| Low | PROC-21 | CONFIRMED | rect_fast telemetry: parametric-path defers are never recorded; a dead counter; one counter still process-global | [02-geometry-processors-profiles.md](02-geometry-processors-profiles.md) |
| Low | PROC-S23 | CONFIRMED | SurfaceOfLinearExtrusion produces NaN on a zero direction and has no RTC hook | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| Low | PROC-S24 | LIKELY | Surface of revolution ignores `IfcSweptSurface.Position` | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| Low | PROC-S25 | CONFIRMED | AdvancedBrep aborts the whole solid when one face fails to decode | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| Low | PROC-S30 | SUSPECT | `partial_cmp().unwrap_or(Equal)` in `sort_by` on file-derived angles | [02a-proc-boolean-brep-surface.md](02a-proc-boolean-brep-surface.md) |
| Low | PROC-AL-15 | LIKELY | Typed `IFCPARAMETERVALUE` detection duplicated; the circle parameter ignores angle units | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| Low | PROC-AL-16 | LIKELY | Horizontal arc accepts an infinite radius; non-strict path emits NaN vertices | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| Low | PROC-AL-17 | SUSPECT | Sectioned sort uses `partial_cmp().unwrap_or(Equal)` | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| Low | PROC-AL-18 | LIKELY | Vertical segments assumed sorted but never sorted (IFC4x1) | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| Low | PROC-AL-25 | SUSPECT | `MaterialLayerIndex::from_flat` cursor arithmetic can wrap on wasm32 | [02b-proc-alignment-sectioned-voids.md](02b-proc-alignment-sectioned-voids.md) |
| Low | KERNEL-28 | SUSPECT | Latent out-of-range index panics in consolidation and AABB clipping (sibling code bounds-checks) | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| Low | KERNEL-30 | SUSPECT | `tritri::line_direction` passes a non-finite direction to the exact tier, which then panics | [03-geometry-kernel-csg.md](03-geometry-kernel-csg.md) |
| Low | PROCESSING-APP-21 | SUSPECT | `boundaries[0]` on a `FillShape` with zero rings | [05-processing.md](05-processing.md) |
| Low | CORE-23 | SUSPECT | `decode_by_id` never checks that the parsed id matches the requested id | [06-core.md](06-core.md) |
| Low | CORE-24 | SUSPECT | `ColumnarEntityIndex::from_scan` and `from_hashmap` truncate offsets to u32 with only a `debug_assert` | [06-core.md](06-core.md) |
| Low | EXPORT-GEOM-14 | CONFIRMED | infallible `export_glb_from_meshes` is public, wraps on wasm32, and ships truncated output as success | [07-export.md](07-export.md) |
| Low | EXPORT-GEOM-16 | CONFIRMED | KMZ numeric inputs are not validated | [07-export.md](07-export.md) |
| Low | EXPORT-STEP-26 | CONFIRMED | Caller-supplied STEP fragments are written unvalidated (record injection) | [07a-export-step-writer.md](07a-export-step-writer.md) |
| Low | EXPORT-MERGE-12 | LIKELY | `apply_folds` splits the output on newlines, so a fold into a multi-line source record is lost | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| Low | EXPORT-MERGE-18 | CONFIRMED | `ModelIndex::build` keeps the last span but the first type for duplicate express ids | [07b-export-merge-schema.md](07b-export-merge-schema.md) |
| Low | EXPORT-DATA-20 | CONFIRMED | Parquet geometry folds the origin in f32 and skips the finiteness gate the other exporters apply | [07c-export-data-model.md](07c-export-data-model.md) |
| Low | EDGE-LXPARSE-23 | CONFIRMED | The XML declaration check is skipped when byte 1024 falls inside a UTF-8 character | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| Low | EDGE-LXPARSE-24 | CONFIRMED | Repeated CoordinateSystem warnings are unbounded | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| Low | EDGE-LXPARSE-26 | SUSPECT | Fragile index arithmetic in plan `start()` | [09c-landxml-parsing.md](09c-landxml-parsing.md) |
| Low | EDGE-WASM-25 | CONFIRMED | An `IFCSITE` job is emitted even when the caller disables `IFCSITE` | [09d-wasm-bindings-api.md](09d-wasm-bindings-api.md) |

