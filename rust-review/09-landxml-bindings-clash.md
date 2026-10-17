# LandXML, bindings (wasm/ffi/python), clash, cloud-import, csg-thread-bench review

Scope: rust/landxml, rust/wasm-bindings, rust/ffi, rust/python, rust/clash, rust/cloud-import, rust/csg-thread-bench.
I ran no cargo. Every finding comes from reading the code. CONFIRMED means confirmed by reading the code paths, not by running anything. Paths are relative to the repo root.

Prefixes:
- EDGE-LXPARSE: LandXML XML/parsing layers.
- EDGE-LXMATH: LandXML geometry and numeric code.
- EDGE-WASM: wasm-bindings api/.
- EDGE-CLASH: clash crate plus wasm zero_copy.
- EDGE-FFI: ffi, python, cloud-import, csg-thread-bench.

This file is a synthesis. The sub-area findings are written up in full in the sub-files 09a-09d, and the index below keeps their numbers (`EDGE-<SUB>-n` = `EDGE-n` in that sub-file). Only the EDGE-FFI findings are written up in full here.

## Summary
- **The browser re-implements the native pipeline's orchestration, and the copies have already drifted.**
  - Colour chase: EDGE-WASM-1.
  - Router arming: EDGE-WASM-2. The browser never arms the #858 indexed-colour split guard (EDGE-WASM-5) or the shared-brep signature cache.
  - Geometry-job discovery is written 6 times (EDGE-WASM-3).
  - Type-geometry sets are built 3 times, and the browser drops bare-ref `RepresentationMaps` (EDGE-WASM-4).
  - Unit-scale resolution is written 4 times (EDGE-WASM-8).
  - The binding layer is not thin: `produce_batch` is 579 lines and `pre_pass_streaming_impl` is 562.
- **LandXML has four hand-rolled XML front-ends (TIN, plan, pipe, alignment), plus a separate stream fan-out and a separate preflight tokenizer.** This is the root of most of the crate's drift (EDGE-LXPARSE-1). It also produced a real data-corruption bug that exists in all four: quick-xml 0.42 `Event::GeneralRef` is never handled, so `1&#46;5` in a `<P>` silently becomes `15` (EDGE-LXPARSE-2). The same gap desynchronises the streaming session (EDGE-LXPARSE-3).
- **Untrusted LandXML can amplify memory heavily within the limits.** Extension-root path strings give about 2000x, so under 1 MB of input becomes about 1.6 GB (EDGE-LXPARSE-4). `child_ordinals` and repeated CoordinateSystem warnings are smaller cases. Several unit and limit contracts are honoured by only one of the four parsers (EDGE-LXPARSE-7, EDGE-LXPARSE-6).
- **Alignment and vertical-curve math is duplicated across crates with different accuracy.**
  - Clothoid: 3 implementations (16-pt Gauss vs trapezoid vs Simpson).
  - Vertical curves: 5 evaluators. The IFC4x1 circular arc uses a parabola, about 0.9 m off at R=100 m (EDGE-LXMATH-7).
  - Arc validation: 2 copies with 1e-7 relative vs 1e-9 absolute tolerance, so real georeferenced curved parcels are refused (EDGE-LXMATH-1).
  - 2D predicates are copied from geometry's `pub(crate)` `geom2d`, and the parcel copy is inexact.
- **The native front-ends disagree on the stack-safety model.** FFI runs the work on a 256 MiB-stack rayon pool. Python spawns one 256 MiB thread, but the per-element CSG runs on the default-stack *global* rayon pool, so that stack never helps. The server's global pool also has default stacks. A stack overflow there kills the Python interpreter or the server process (EDGE-FFI-1). Separately, FFI rejects non-UTF-8 IFC files that every other front-end accepts (EDGE-FFI-2).
- **Clash.** The BVH sort comparator is not a total order on NaN, so it can panic (and with `panic=abort`, trap the shared wasm instance) on meshes the code explicitly expects to contain NaN (EDGE-CLASH-1). Box-face detection is copied from geometry and has drifted back to the non-scale-free threshold that geometry calls "the original bug" (EDGE-CLASH-4).
- **wasm `zero_copy` has no `unsafe` at all.** Every getter copies, so the memory-growth view-invalidation question does not apply today. The module name and docs still promise views (EDGE-CLASH-6), and `#![forbid(unsafe_code)]` should lock this in.
- **The Z-up to Y-up basis and the row-major 4x4 multiply are copied in 4+ crates**, and the grid and alignment overlays already differ on the sign of -0.0 (EDGE-CLASH-2). These belong in one `ifc_lite_geometry::frame` module.

## Cross-sub-area themes
1. **There is no shared "front-end facade".**
   - wasm, ffi, python and server each build their own pre/post-processing around `ifc_lite_processing`: router arming, colour, unit scale, site rotation, `ParseResponse` mapping, stack and thread model, UTF-8 handling.
   - Proposed facade in processing: `BatchRouterConfig::build()`, `resolve_element_color`, `resolve_unit_scales`, `ParseResponse::from_result`, `ProcessingResult::site_rotation_for_export()`, `GEOMETRY_STACK_BYTES`, and a `run_on_large_stack_pool` helper.
   - Sites: EDGE-WASM-1/2/3/4/8, EDGE-FFI-1/3/6/7.
2. **Pull vs stream parity in LandXML.** Every format feature is implemented once per parser and again in the stream session. Behaviour differs between `parseLandXmlSourceBytes`, `parseLandXmlSourceBytesWithOptions` and the stream (EDGE-LXPARSE-3/8, EDGE-LXMATH-3/4).
3. **`pub(crate)` helpers force copies across crates.**
   - geometry's `geom2d` (EDGE-LXMATH-5).
   - processing's `find_geometry_item_style_source_at` (EDGE-WASM-1).
   - The clash canonical-normal helper (EDGE-CLASH-4).
   - Making the canonical helper `pub` is the cheapest fix in each case.
4. **Tolerances with no home.**
   - `EPSILON = 1e-9` is declared 3 times in landxml.
   - The f32-ULP constant 2^-22 is defined 5 times.
   - There are two alpha cutoffs (0.95 / 0.99).
   - Arc radius checks use 1e-7 relative in one place and 1e-9 absolute in another.
   - The circular profile length check allows 32 ULP while every other length check allows 1e-6.
5. **Stale cross-reference comments are widespread.** They point at deleted files (`gpu_meshes.rs`, `zero_copy.rs`, `processor.rs ~905`, `kernel/mesh_bridge.rs`, `narrow-phase.ts`, `csgrs`). This is a sign that refactors don't sweep comments.

## Findings index

The sub-area findings are written up in full in the sub-files. Each ID below is the sub-file's `EDGE-n` with a prefix added: `EDGE-<SUB>-n` is `EDGE-n` in that file.

| Prefix | Sub-file |
|---|---|
| CLASH | `09a-clash-zerocopy.md` (clash crate + wasm `zero_copy`) |
| LXMATH | `09b-landxml-alignment-math.md` |
| LXPARSE | `09c-landxml-parsing.md` |
| WASM | `09d-wasm-bindings-api.md` |
| FFI | this file (ffi, python, cloud-import, csg-thread-bench), written up in full below |

The "dup of" column marks the same issue found from two sides; fix them together.

### High (12)
| ID | Cat | One line | Dup of |
|---|---|---|---|
| EDGE-WASM-1 | DRY | The browser re-implements the element-colour / MappedItem colour chase (`styling/color.rs`) instead of calling processing's `pub(crate)` walk, and the fallback colour has drifted | |
| EDGE-WASM-2 | DRY | `produce_batch` (579 lines) re-implements native router arming; it never arms the shared-brep signature cache or the indexed-colour split guard | |
| EDGE-WASM-3 | DRY | Geometry-job discovery is written 6 times (3 wasm + parsing.rs + shard_classes + native), with #1910, IFCSITE and type rules disagreeing | |
| EDGE-WASM-4 | DRY | Type-geometry sets are built 3 times; browser and export drop bare-ref `RepresentationMaps`, which native draws | |
| EDGE-LXPARSE-1 | DRY | Four hand-rolled LandXML XML front-ends (TIN, plan, pipe, alignment) with drifted work charging, errors and version handling | |
| EDGE-LXMATH-1 | DRY | Arc validation is written twice; the parcel copy's 1e-9 absolute tolerance refuses real georeferenced curved parcels | |
| EDGE-WASM-5 | Bug | Live browser instanced path never arms the #858 indexed-colour split guard, so multi-colour mapped sets render in one colour | |
| EDGE-LXPARSE-2 | Bug | quick-xml 0.42 `Event::GeneralRef` is unhandled, so `1&#46;5` becomes `15` in coordinates and the char-ref cap is bypassed | |
| EDGE-LXPARSE-3 | Bug | The stream session desyncs when one text token yields several events; stream and pull disagree on the same bytes | |
| EDGE-LXPARSE-4 | Bug | Extension-root path strings amplify memory about 2000x (under 1 MB of input becomes about 1.6 GB) | |
| EDGE-CLASH-1 | Bug | The clash BVH `sort_by` comparator is not a total order on NaN, so it can panic and trap wasm on meshes expected to contain NaN (#5220) | |
| EDGE-FFI-1 | Bug | The 256 MiB stack in python (and the server's global pool) never reaches the rayon workers running CSG; a stack overflow kills the process | below |

### Medium (50)
| ID | Cat | One line | Dup of |
|---|---|---|---|
| EDGE-CLASH-2 | DRY | Z-up/Y-up basis and 4x4 matmul copied in wasm, processing and export | WASM-9 |
| EDGE-WASM-9 | DRY | Same as CLASH-2, plus the render-frame transform; grid and alignment overlays differ on -0.0 | CLASH-2 |
| EDGE-CLASH-3 | DRY | Symbolic primitives defined twice (wasm `zero_copy` vs processing), copied field by field with six adjacent f32 arguments | |
| EDGE-CLASH-4 | DRY | Box-face normal code copied from geometry; clash kept the non-scale-free 1e-6 threshold (1 mm faces dropped) | |
| EDGE-LXPARSE-5 | DRY | Budget/limit counter pattern written 17 times; alignment reports limits as `InvalidSemantic` | |
| EDGE-LXPARSE-6 | DRY | Unit scale table and Units parsing duplicated; blank `elevationUnit` is accepted by TIN and refused by pipe | LXMATH-12 |
| EDGE-LXPARSE-9 | DRY | Alignments parsed twice into two public `LandXmlAlignment` types; duplicate point/location types; `max_alignments` ignored | LXMATH-16 |
| EDGE-LXPARSE-10 | DRY | Finite-f64 coordinate-list parsing written about 10 times | |
| EDGE-LXPARSE-11 | DRY | Encoding normalisation (BOM, UTF-16, declaration) duplicated between pull and stream | |
| EDGE-LXPARSE-12 | DRY | Preflight and stream tokenizers duplicated; both mis-handle `<!-->` | |
| EDGE-LXPARSE-13 | DRY | Terrain CDT error mapping copied 8 times inside the 375-line `adapt_faceless_tin` | LXMATH-22 |
| EDGE-LXMATH-2 | DRY | Clothoid integration written 3 ways (Gauss-16 / trapezoid / Simpson) with different accuracy and domain rules | |
| EDGE-LXMATH-3 | DRY | Plan resolver adapter copied into wasm; the stream builds a resolver per record (O(n²), different budget) | LXPARSE-21 |
| EDGE-LXMATH-4 | DRY | Alignment render sampling duplicated with different truncation; the reassembler recomputes it | |
| EDGE-LXMATH-5 | DRY | Terrain and parcel 2D predicates copied from geometry's `pub(crate)` `geom2d`; the parcel copy is inexact | |
| EDGE-LXMATH-6 | DRY | Terrain constraint scans (O(S²), O(S·V)) run in both landxml and geometry's CDT | |
| EDGE-LXMATH-7 | DRY | Vertical curves evaluated 5 ways; IFC4x1 circular arc uses a parabola, about 0.9 m off at R=100 m | |
| EDGE-LXMATH-8 | DRY | Profile evaluator resolves PVIs twice by float equality, O(N·C·P) | |
| EDGE-WASM-6 | DRY | CSG console logger re-aggregates diagnostics with different rules and random tie order | |
| EDGE-WASM-7 | DRY | IfcIndexedColourMap full-palette collection duplicated | |
| EDGE-WASM-8 | DRY | Unit-scale resolution written 4 times; overlays and server fall back to 1.0 silently | |
| EDGE-WASM-10 | DRY | Prepass wire decoders live in wasm while their encoders are in processing | |
| EDGE-WASM-11 | DRY | 8 lazy-cache getters and 3 diverging reset paths; `style_finishes` not cleared on index install | |
| EDGE-WASM-12 | DRY | 16-argument batch signatures copied at 5 entry points | |
| EDGE-FFI-3 | DRY | Python "spawn large-stack thread, join" boilerplate copied 8 times | below (WASM-24 part) |
| EDGE-FFI-4 | DRY | Python JSON → `json.loads` → int re-key round-trip copied 6 times | below |
| EDGE-FFI-6 | DRY | `ProcessingResult` → `ParseResponse` mapping duplicated in FFI and server; FFI lacks finishes and symbolic data | below |
| EDGE-FFI-7 | DRY | The "site rotation only in SiteLocal" decision is re-derived at 4 consumers | below |
| EDGE-LXPARSE-7 | Bug | `assumed_linear_unit` honoured by TIN only; pipe, plan and alignment ignore it | |
| EDGE-LXPARSE-17 | Bug | TIN `child_ordinals` grows with every distinct child name (about 400 MB from 64 MB of input) | |
| EDGE-LXMATH-9 | Bug | `IrregularLine` probes fail at the end when the declared length is slightly over the polyline length | |
| EDGE-WASM-13 | Bug | `exportMerged` throws from a `&self` method; the borrow flag stays held and the `IfcAPI` can no longer be freed | |
| EDGE-WASM-14 | Bug | FFI rejects non-UTF-8 IFC files | FFI-2 |
| EDGE-FFI-2 | Bug | (canonical) FFI `read_to_string` rejects Latin-1 IFC that every other front-end accepts | below |
| EDGE-FFI-5 | Bug | Python JSON entry points turn NaN/inf into `null`; only `rebar_schedule` guards against it | below |
| EDGE-LXMATH-10 | Quirk | Circular vertical-curve length check allows 32 ULP; rounded producer files are always refused | |
| EDGE-LXMATH-11 | Quirk | Assumed-unit doc contradicts the declared-unit default; elevation scaled 0.3048 vs 1.0 | |
| EDGE-FFI-8 | Best-practice | FFI panic safety depends on the `server-release` profile with no compile-time guard | below |
| EDGE-LXPARSE-8 | Perf | Pull "canonical document" parses 3-4 times; wasm options path drops pipes; an error is matched by message string | |
| EDGE-LXPARSE-14 | Perf | Namespace map and frame cloned per element in all four parsers | |
| EDGE-LXPARSE-15 | Perf | Pipe parser builds an attribute BTreeMap for every element | |
| EDGE-LXPARSE-16 | Perf | Stream copies each byte about 5 times, makes a debug string per token, and serialises JSON just to measure length | |
| EDGE-LXMATH-20 | Perf | Every probe re-validates the whole alignment; linear segment search | |
| EDGE-WASM-15 | Perf | Streaming pre-pass deep-copies the partial entity index for the meta event | |
| EDGE-WASM-16 | Perf | Overlay parsers re-transcode and re-index the whole file on each call | |
| EDGE-CLASH-5 | Perf | Clash session holds up to 3 copies of each element's geometry | |
| EDGE-FFI-9 | Perf | cloud-import clones the ancestor `HashSet<String>` per child (about 25M strings within limits) | below |
| EDGE-LXPARSE-28 | Maintainability | landxml god functions (`start()` 250/242/237 lines), 40-field state structs, sentinel role strings | |
| EDGE-LXMATH-22 | Maintainability | `adapt_faceless_tin` is 376 lines; `unreachable!` arms abort wasm | LXPARSE-13 |
| EDGE-WASM-17 | Maintainability | `produce_batch` 579 lines, `pre_pass_streaming_impl` 562, 22-field `IfcAPI`, boolean-flag soup | |

### Low (51)
| ID | Cat | One line | Dup of |
|---|---|---|---|
| EDGE-CLASH-7 | DRY | `MeshCollection` lists 11 fields in 4 places | |
| EDGE-CLASH-8 | DRY | f32-ULP 2^-22 defined 5 times, with stale references | |
| EDGE-CLASH-11 | DRY | Clash test box/session fixtures copied | |
| EDGE-CLASH-12 | DRY | `[f64;3]` cross/dot helpers copied across geometry, processing and export; normalise threshold drifted | |
| EDGE-LXPARSE-18 | DRY | Outside-root and nested-capture rules differ per parser | |
| EDGE-LXPARSE-19 | DRY | Properties helper written 3 times; pipe keeps `xmlns` attributes | |
| EDGE-LXPARSE-20 | DRY | Pipe part conversion arms copy-pasted | |
| EDGE-LXPARSE-21 | DRY | Plan work-budget formula duplicated in landxml and wasm | LXMATH-3 |
| EDGE-LXMATH-12 | DRY | Unit table duplicated; core `US_SURVEY_FOOT_SCALE` truncated | LXPARSE-6 |
| EDGE-LXMATH-13 | DRY | wasm probe endpoints re-parse the whole file per call and re-implement the superelevation filter | |
| EDGE-LXMATH-14 | DRY | Station-equation walk written 3 times | |
| EDGE-LXMATH-15 | DRY | Distance, tolerance and finite helpers copied; `EPSILON` defined 3 times | |
| EDGE-LXMATH-16 | DRY | `LandXmlPlanPoint` and `LandXmlAlignment` duplicate type names | LXPARSE-9 |
| EDGE-LXMATH-17 | DRY | Station→segment lookup written 7 ways with flipping boundary ownership | |
| EDGE-LXMATH-18 | DRY | Plan source-ID traversal and batch size 128 duplicated | |
| EDGE-LXMATH-19 | DRY | Test fixture and terrain error enums duplicated | LXPARSE-13 (part) |
| EDGE-WASM-18 | DRY | Browser don't-bake finalize repeats processing's grouping and template scan | |
| EDGE-WASM-19 | DRY | JSON-request helpers only partly shared; inline size limits | |
| EDGE-WASM-20 | DRY | Ring-set wire format encoded 6 times; overflow hardening uneven | |
| EDGE-WASM-21 | DRY | Small clones in batch.rs and grid_lines.rs | |
| EDGE-WASM-22 | DRY | Flat mesh-wire slicing written 3 times (GLB copy can wrap on wasm32) | |
| EDGE-WASM-23 | DRY | STEP test fixtures copied across crates | |
| EDGE-WASM-24 | DRY | Quality-label error, `tolerance: 0.01`, FNV-1a and the stack constant duplicated | FFI-3 (part) |
| EDGE-FFI-10 | DRY | cloud-import hard-codes the IFCX vocabulary owned by export `ifc5.rs` | below |
| EDGE-FFI-11 | DRY | csg-thread-bench `replay_one` copies processing's bench `replay` | below |
| EDGE-LXPARSE-23 | Bug | Declaration check skipped when byte 1024 splits a UTF-8 character | |
| EDGE-LXPARSE-24 | Bug | Repeated CoordinateSystem warnings are unbounded | |
| EDGE-LXPARSE-26 | Bug | Fragile index arithmetic in plan `start()` (SUSPECT) | |
| EDGE-WASM-25 | Bug | IFCSITE job emitted even when IfcSite is disabled | |
| EDGE-CLASH-9 | Quirk | Clash margin computed twice and differs from TS; a NaN tolerance gives silent no-touch | |
| EDGE-LXPARSE-27 | Quirk | Degenerate faces accepted (SUSPECT) | |
| EDGE-WASM-26 | Quirk | Style cache key ignores colours; pre-pass decoders seeded with unit scale 1.0 | |
| EDGE-WASM-32 | Quirk | JS mesh operand index `* 3` can wrap on wasm32 in zone_split | |
| EDGE-WASM-33 | Quirk | Two alpha cutoffs (0.95 / 0.99) with no shared home | |
| EDGE-FFI-12 | Quirk | Python `alignment_axes` demands UTF-8, unlike every other entry point | below |
| EDGE-CLASH-10 | Perf | Clash BVH: Box per node, leaves tested twice | |
| EDGE-LXPARSE-25 | Perf | Unescaped String allocated per text node in TIN and alignment | |
| EDGE-LXMATH-21 | Perf | Faceless-TIN adaptation clones whole surface vectors | |
| EDGE-WASM-28 | Perf | Result getters clone whole buffers on every access | |
| EDGE-FFI-13 | Perf | cloud-import re-parses the GLB per occurrence; doc claims a cache | below |
| EDGE-WASM-27 | Best-practice | Mixed JsValue/JsError/js_sys::Error; silent `undefined` on serialisation failure | |
| EDGE-CLASH-6 | Maintainability | `zero_copy` has no `unsafe` and no views (audit clean), but docs claim views; add `forbid(unsafe_code)` | |
| EDGE-CLASH-13 | Maintainability | Two doc comments attached to the wrong function | |
| EDGE-LXPARSE-22 | Maintainability | Three error-construction styles; control flow keyed on message text | LXMATH-24 |
| EDGE-LXPARSE-29 | Maintainability | Two public `LandXmlAlignment`/`LandXmlPlanPoint` types; "exact 1.2" docs | |
| EDGE-LXMATH-23 | Maintainability | `clothoid.rs` hand-minified (1011-character line) | |
| EDGE-LXMATH-24 | Maintainability | Numeric error types, codes and tolerance scaling inconsistent | LXPARSE-22 |
| EDGE-WASM-29 | Maintainability | Stringly-typed inputs; RTC passed 3 ways with no finiteness check | |
| EDGE-WASM-30 | Maintainability | Dead or duplicate exports (`scanGeometryEntitiesFast`, `version`, `set_panic_hook`) | |
| EDGE-WASM-31 | Maintainability | Stale comments pointing at deleted files and stale line numbers | |
| EDGE-FFI-14 | Maintainability | Python crate has no lint config; panic payloads and cloud-import errors discarded | below |

Totals: 113 index rows (12 High, 50 Medium, 51 Low). Seven issues appear twice, once from each side (marked in "dup of"), so there are 106 distinct issues. LXMATH-19 and WASM-24 overlap other findings only in part.

## ffi / python / cloud-import / csg-thread-bench findings (full)

### EDGE-FFI-1: Python's (and the server's) "large stack" does not reach the rayon workers that run the CSG
- Category: Bug
- Severity: High
- Confidence: CONFIRMED (mechanism); LIKELY (trigger on deep-boolean models)
- Where:
  - rust/python/src/lib.rs:48-51, 72-105
  - the same spawn pattern at rust/python/src/swept_disk_checks.rs:38-45, quantity_analysis.rs:16-22, 45-51, analytic_definitions.rs:20-26, 40-46, rebar_schedule.rs:122-138, entity_data.rs:29-35
  - server: apps/server/src/main.rs:308-311 (`build_global()` without `stack_size`)
  - the correct model: rust/ffi/src/lib.rs:44-99
  - the per-element work: rust/processing/src/processor/mod.rs:1311, 1391 (`par_iter`)
- What:
  - FFI documents the mechanism itself: "the actual per-element geometry work runs inside `process_geometry` via `par_iter` on rayon workers, so the recursion lives on *their* stacks". It therefore builds a dedicated pool with `.stack_size(256 MiB)` and uses `install`.
  - Python's `GEOMETRY_STACK_BYTES` ("Mirrors rust/ffi") instead spawns one 256 MiB OS thread and calls processing from it. The `par_iter` jobs run on rayon's global pool, which has default stacks (no `ThreadPoolBuilder` anywhere in rust/python).
  - The server's global pool is built without `stack_size` as well.
- Why it matters: a stack overflow is not a panic. It hits the guard page and kills the whole Python interpreter or server process, and `join()` / `catch_unwind` / `server-release` cannot catch it. That is exactly the Rhino crash FFI was fixed for. Python and the server only get the big stack for the serial parts.
- Fix:
  - Move FFI's `parse_pool()` + `run_in_pool` into processing as `run_on_geometry_pool(f)`, with `GEOMETRY_STACK_BYTES` defined once.
  - Use it from python (replacing 8 spawn sites, see EDGE-FFI-3) and from the server (`ThreadPoolBuilder::stack_size` in main.rs).
  - Also update the stale `csgrs` reference in ffi/src/lib.rs:46; that kernel is gone (M9).
- Effort: S

### EDGE-FFI-3: Python's "spawn a large-stack thread, join, map panic to a string" block copied 8 times
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/python/src/lib.rs:79-104
  - rust/python/src/swept_disk_checks.rs:38-45
  - rust/python/src/quantity_analysis.rs:16-22, 45-51
  - rust/python/src/analytic_definitions.rs:20-26, 40-46
  - rust/python/src/rebar_schedule.rs:122-138
  - rust/python/src/entity_data.rs:29-35
  - stack constant copies: rust/python/src/lib.rs:51 ("Mirrors rust/ffi") vs rust/ffi/src/lib.rs:51
- What: each block is `std::thread::Builder::new().stack_size(GEOMETRY_STACK_BYTES).name(..).spawn(move || f()).map_err(..)?.join().map_err(|_| "... worker panicked")`, with only the name and message changing.
- Why it matters: this is the code that has to change to fix EDGE-FFI-1, in eight places. The panic payload message is also thrown away; only a fixed "worker panicked" string reaches Python.
- Fix: `fn run_geometry<T: Send>(py, name, f: impl FnOnce() -> T + Send) -> PyResult<T>` backed by the shared processing pool from EDGE-FFI-1. Downcast the panic payload into the error message.
- Effort: S

### EDGE-FFI-4: Python results are serialised to JSON, parsed by Python's `json.loads`, and string keys re-keyed to int, six times
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/python/src/alignment_axes.rs:30-36
  - rust/python/src/quantity_analysis.rs:23-37, 52-66 (jscpd 23-38 vs 52-67)
  - rust/python/src/analytic_definitions.rs:51-68
  - rust/python/src/swept_disks.rs:18-26, 66-72
  - rust/python/src/rebar_schedule.rs:141-149
- What:
  - Each site does `serde_json::to_string(&view)`, then `py.import("json").loads(..)`, then walks a map and parses `String` keys back into `u32`.
  - `.expect("serialized products"/"serialized instances")` appears at quantity_analysis.rs:27, 56 and analytic_definitions.rs:58.
  - `checks_to_python` builds a `serde_json::Value`, stringifies it and re-parses it.
- Why it matters: every call serialises the whole result twice (Rust → text → Python objects), and the re-keying logic is copied six times with slightly different shapes. That shape mismatch is what makes EDGE-FFI-5 easy to miss.
- Fix: one `to_py_keyed(py, &T, key_field: &str) -> PyResult<PyObject>` helper. Better, use `pythonize` (serde → PyObject directly, no text) with a `#[serde(with)]` for integer map keys.
- Effort: S

### EDGE-FFI-6: `ProcessingResult` → `ParseResponse` mapping duplicated in FFI and the server, and the FFI output has drifted
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/ffi/src/lib.rs:118-130 vs apps/server/src/routes/parse/json.rs:89-122
- What:
  - Both build `ParseResponse { cache_key, meshes, mesh_coordinate_space, site_transform, building_transform, metadata, stats, symbolic_data }` by hand.
  - The server JSON route also attaches IFC-authored finishes (`finish_meshes`, #5984), symbolic data in the mesh frame (#4706), and converts to Y-up (#1841).
  - The FFI response has raw Z-up meshes, no finishes and empty symbolic data.
  - The FFI comment "This fork's `ParseResponse` carries 2D symbol data" is stale wording.
- Why it matters: the C#/Rhino host and the server return different shapes from "the same" parse, with no test pinning which differences are intended. Z-up is plausibly right for Rhino; dropping finishes probably is not.
- Fix: `ParseResponse::from_result(result, cache_key)` in processing, with the server applying its Y-up and finishes on top. Document the FFI frame and fields explicitly in the header.
- Effort: S

### EDGE-FFI-7: The "site rotation only in SiteLocal" decision is re-derived at every consumer
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/python/src/lib.rs:89-97; rust/export/src/gltf.rs:1041-1045; rust/processing/src/processor/site_local.rs:78; rust/processing/src/processor/mod.rs:1380-1385
- What: each consumer writes `if result.mesh_coordinate_space == MeshCoordinateSpace::SiteLocal { result.site_transform } else { None }`. gltf.rs:1047-1049 already notes that #4611 was this same `if` "written a second time in a second vocabulary".
- Why it matters: frame bugs are silent (wrong rotation on export only).
- Fix: `ProcessingResult::site_rotation_for_baked_frame() -> Option<&[f64]>`, plus `build_colored_geometry_data_export_from_result(&ProcessingResult)` for python.
- Effort: S

### EDGE-FFI-2: FFI rejects IFC files that are not valid UTF-8 (merges EDGE-WASM-14)
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/ffi/src/lib.rs:110 (`std::fs::read_to_string(path_str).map_err(|_| 2)?`) vs rust/processing/src/processor/mod.rs:416-424 (`T: AsRef<[u8]>`), rust/python/src/lib.rs:74 (`Vec<u8>`), apps/server/src/routes/parse/json.rs:74 (bytes)
- What: a Latin-1/Windows-1252 byte in a STEP string, which older exporters commonly write, makes FFI return code 2 ("file cannot be read"). The pipeline itself accepts raw bytes.
- Why it matters: the Rhino/C# host fails on files that every other front-end loads, with a misleading error code.
- Fix: `std::fs::read(path)` and pass `&[u8]`.
- Effort: S

### EDGE-FFI-5: Non-finite floats silently become JSON `null` on every Python JSON entry point except `rebar_schedule`
- Category: Bug
- Severity: Medium
- Confidence: LIKELY
- Where:
  - guard exists only at rust/python/src/rebar_schedule.rs:153-216 (`validate_finite`, #5797/#5801)
  - unguarded: rust/python/src/alignment_axes.rs:30, quantity_analysis.rs:23, 52, analytic_definitions.rs:27, 47, swept_disks.rs:18, 34-36, 66, lib.rs:202-204 (`to_json`)
- What: serde_json writes NaN/inf as `null`, so a Python consumer typed `float` gets `None`. The same bug class was fixed for the rebar schedule only, with a hand-written 60-line field walker.
- Why it matters: quantity analysis, extrusion definitions, alignment frames and swept-disk metrics can hand `None` to numpy or typed callers.
- Fix: with the shared helper from EDGE-FFI-4, serialise through a serializer that rejects non-finite values (a custom `Serializer` wrapper or a `serde_json::Value` walk), applied to every entry point. Delete `validate_finite`.
- Effort: S

### EDGE-FFI-8: FFI panic safety depends on the build profile, with no compile-time guard
- Category: Best-practice
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/ffi/src/lib.rs:12-19 (doc), 90-99 (`catch_unwind`); Cargo.toml:35-41 (`release` has panic='abort'); rust/ffi/Cargo.toml (published crate, `crate-type = ["cdylib"]`)
- What: the header says `server-release` is "mandatory". A plain `cargo build --release -p ifc-lite-ffi`, or any downstream build of the published crate, silently produces a DLL whose `catch_unwind` is a no-op, so a parser panic aborts the host CAD process. No CI job builds or tests the DLL in that profile (only release.yml publishes it).
- Why it matters: the documented error code 3 does not exist in the most likely build.
- Fix: `#[cfg(all(panic = "abort", not(test)))] compile_error!("build ifc-lite-ffi with --profile server-release (panic=unwind)");`, or at least a `const` warning. Add a CI lane that builds the DLL in server-release.
- Effort: S

### EDGE-FFI-9: cloud-import clones the ancestor `HashSet<String>` for every child (O(occurrences x depth) memory)
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/cloud-import/src/lib.rs:53, 57-61, 103 (`stack.push((…, ancestors.clone()))`); rust/cloud-import/src/meshes.rs:158-171
- What:
  - Each queued child carries its own clone of the full ancestor set.
  - Within the limits (`MAX_DEPTH` 256, `MAX_OCCURRENCES` 100_000), a 255-deep chain fanning out 100k children holds about 25.5M URN `String`s at once, roughly 1.5 GB or more, before any limit trips.
  - The GLB walk does the same with `HashSet<usize>`.
- Why it matters: the converter advertises bounded resource use (README: "Iterative walks bound depth, cycles, occurrences"), but memory is bounded only by occurrences x depth.
- Fix: keep a parent-index arena (`Vec<(urn_idx, parent)>`) and walk up for the cycle check (O(depth) time, O(1) extra memory per entry), or use an `Rc` persistent list.
- Effort: S

### EDGE-FFI-10: cloud-import duplicates the IFCX vocabulary owned by export's IFC5 writer
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/cloud-import/src/lib.rs:65, 74, 128-133 and rust/cloud-import/src/meshes.rs:207-215 vs rust/export/src/ifc5.rs:17-27
- What:
  - `"ifcx_alpha"`, the `ifc@v5a` / `prop@v5a` import URIs and the buildingSMART class URI pattern are literals in cloud-import.
  - ifc5.rs:17-23 claims `IFCX_VERSION` is "the value every IFCX writer in this repo puts in header.ifcxVersion" and is pinned to TS by test-wasm-contract. cloud-import is not covered by that pin.
  - The magic `256` at meshes.rs:163 duplicates `MAX_DEPTH`.
- Fix: a tiny dependency-free `ifcx_vocab` module (core, or a `pub mod` in export usable with `default-features = false`) for the version, imports and `class_uri(code)`. Use `MAX_DEPTH` in meshes.rs.
- Effort: S

### EDGE-FFI-11: csg-thread-bench `replay_one` is a copy of processing's bench `replay`
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/csg-thread-bench/src/lib.rs:35-46 vs rust/processing/examples/csg_scaling_bench.rs:38-51 (jscpd)
- What: the same `CapturedCsgJob` → `subtract_mesh` / `subtract_mesh_many` → index-count fingerprint.
- Fix: `ifc_lite_geometry::csg_capture::replay(&CapturedCsgJob) -> usize` behind the `csg_capture` feature, used by both.
- Effort: S

### EDGE-FFI-12: Python `alignment_axes` requires UTF-8 and runs on the caller thread, unlike every other entry point
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/python/src/alignment_axes.rs:20-28; root cause rust/geometry/src/alignment_sampling.rs:217 (`content: &str`)
- What: Latin-1 bytes raise `ValueError("IFC STEP must be UTF-8")` here, while `geometry_data_*` accepts the same file.
- Fix: make `sample_alignment_axes` take `&[u8]`, like the processing entry points.
- Effort: S

### EDGE-FFI-13: cloud-import re-parses the GLB for every occurrence, and its doc claims a cache that does not exist
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/cloud-import/src/lib.rs:50-51 ("Immutable URNs cache source data"), 110-115 (`meshes::extract(bytes, …)` per occurrence); rust/cloud-import/src/meshes.rs:150
- What: a URN instanced N times re-runs `Gltf::from_slice` and the accessor reads N times, and bakes N transformed point copies into the IFCX. Bounded by `MAX_POINTS`, but wasteful.
- Fix: memoise the extracted local-space meshes per `(context, blob_id, selection)` and transform per occurrence, or fix the comment.
- Effort: S

### EDGE-FFI-14: Python crate sits outside every lint lane; panic payloads and cloud-import errors are discarded
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/python/Cargo.toml (own `[workspace]`, no `[lints]`); the `join().map_err(|_| "... panicked")` sites in EDGE-FFI-3; rust/cloud-import/src/main.rs:30-35 (any error prints only "Forma snapshot conversion failed")
- What:
  - The wheel crate is excluded from `cargo test --workspace` and `clippy -D` (as documented), and it has no lint config of its own.
  - Panic messages are thrown away before reaching Python.
  - The cloud-import CLI hides even static, payload-free error strings such as "Cycle in Forma element hierarchy", which makes operator debugging guesswork.
- Fix: add a `[lints.clippy]` block mirroring the workspace; include the panic payload `&str` in the error; print the static `convert` error string (it never contains payload or path data).
- Effort: S

## Concept inventory

**Vector and matrix math**
- `vec3` (`sub`, `add`, `scale`, `cross`, `dot`, `dist_sq`, `mid`, `centroid`): rust/clash/src/vec3.rs:31-68
- Plato-generated `Vec3`, `TriTriSat`, `PairNoise`, `Band`, `Box3`: rust/clash/src/generated/plato.rs:157-206
- `normalize`, `canonical`, `normal_angle_error`, `family_axes`: rust/clash/src/obb_detect.rs:16, 27, 68, 281
- `obb_penetration`, `proj_radius`: rust/clash/src/obb.rs:74, 178
- `canonical`, `dot3`, `cross3`, `normalize3`, `face_normal`: rust/geometry/src/clash_contact_axes.rs:37, 52, 56, 81, 123
- Row-major 4x4 matmul:
  - `matmul`: rust/wasm-bindings/src/zero_copy/frame_swap.rs:49
  - `matmul_row_major`: rust/processing/src/simplify_math.rs:45
  - `mat4_mul`: rust/export/src/gltf/matrix.rs:54
- 2D distance:
  - `planar_distance`: rust/landxml/src/alignment/numeric.rs:228
  - `distance_between`: rust/landxml/src/alignment/numeric/geometry.rs:312 and rust/landxml/src/alignment/numeric/geometry/clothoid.rs:42
  - `same_point`, `distance`: rust/landxml/src/plan/numeric/measure.rs:34, 38
- `normalize`, `interpolate`: rust/landxml/src/alignment/numeric/geometry.rs:301, 277
- `cross`: rust/landxml/src/plan/numeric/measure.rs:45
- Orientation:
  - exact `orient`: rust/landxml/src/terrain_topology.rs:143
  - inexact closure: rust/landxml/src/plan/numeric/topology.rs:55
  - geometry's `orientation`: rust/geometry/src/geom2d.rs:85
- Clothoid integration:
  - landxml `integral`: rust/landxml/src/alignment/numeric/geometry/clothoid.rs:39
  - geometry: rust/geometry/src/alignment.rs:968-1019, rust/geometry/src/curve_segment.rs:64-81
- Vertical curves:
  - rust/landxml/src/profile_evaluator.rs:208, 232, 272
  - `circular_geometry`, `circular_rise`, `scaled_ratio`, `ulp`: rust/landxml/src/profile_circular.rs:18, 184, 122, 112
  - geometry: rust/geometry/src/gradient.rs:180, 187, 196; rust/geometry/src/alignment.rs:1041
- Arc sweep:
  - `sweep`: rust/landxml/src/alignment/numeric/geometry.rs:315
  - `arc_delta`: rust/landxml/src/plan/numeric/measure.rs:7

**Transforms and placements**
- `swap_zup_to_yup_aabb`, `swap_zup_to_yup_mat4`: rust/wasm-bindings/src/zero_copy/frame_swap.rs:25, 34
- Inline position/normal/origin swap: rust/wasm-bindings/src/zero_copy/mesh.rs:307-335
- `to_render_frame`: rust/wasm-bindings/src/api/grid_lines.rs:176
- Inline transform and `IDENTITY`: rust/wasm-bindings/src/api/alignment_lines.rs:125, 153-161
- `parse_overlay_frame`: rust/wasm-bindings/src/api/overlay_frame.rs:39
- RTC triples: rust/wasm-bindings/src/api/gpu_meshes/batch.rs:128, 588, 787, 950
- Site-rotation selection:
  - rust/python/src/lib.rs:92
  - rust/export/src/gltf.rs:1041
  - `native_to_baked`: rust/processing/src/processor/site_local.rs:69-78
- `matrix` (validated affine): rust/cloud-import/src/lib.rs:41; glTF Y-up→Z-up at rust/cloud-import/src/meshes.rs:192-194
- `transform_local`: rust/landxml/src/alignment/numeric/geometry/clothoid.rs:40
- Right-offset normal: rust/landxml/src/alignment/numeric/station.rs:129-130

**Tolerances and epsilons**
- landxml `EPSILON = 1e-9`:
  - rust/landxml/src/alignment/numeric.rs:16
  - rust/landxml/src/plan/numeric.rs:18
  - rust/landxml/src/plan/numeric/parcel_measure.rs:11
- `geometry_tolerance` (`len*1e-6` max `1e-6`): rust/landxml/src/alignment/numeric.rs:234; rust/landxml/src/alignment/numeric/geometry.rs:247
- Radius tolerance `radius*1e-7`: rust/landxml/src/alignment/numeric/geometry.rs:155
- Clothoid domain `|κL| > 2`: rust/landxml/src/alignment/numeric/geometry/clothoid.rs:14
- 32 ULP circular-curve length check: rust/landxml/src/profile_circular.rs:83
- `elevations_agree` (8·eps·scale): rust/landxml/src/terrain_validation.rs:29-40
- `elevations_match` (1e-9): rust/landxml/src/pipe_parser/inverts.rs:154
- Render budgets (65 / 250_000 / 1_024): rust/landxml/src/alignment/render_data.rs:9-11 and rust/landxml/src/stream/derived/alignment.rs:10-12
- Parcel budgets (700 edges / 1e6 work): rust/landxml/src/plan/numeric/parcel_probe.rs:15-16
- `CANCELLATION_POLL_BYTES`: rust/landxml/src/xml.rs:20
- `DECLARATION_LIMIT` and `DECLARATION_BYTES` (both 1024): rust/landxml/src/xml.rs:258 and rust/landxml/src/stream/decoder.rs:12
- Clash:
  - `EPS` 1e-12: rust/clash/src/triangle.rs:17
  - `RAY_EPS` 1e-9: rust/clash/src/tri_mesh.rs:24
  - `OBB_EPS` 1e-6, `AXIS_NOISE_ULPS` 8: rust/clash/src/obb.rs:35, 50
  - `MAX_NOISE_ANGLE` 0.1: rust/clash/src/obb_detect.rs:99
  - `F32_ULP_SCALE` (2^-22): rust/clash/src/depth.rs:212
- geometry clash axes: `ORTHO_EPS` 1e-4, `MIN_SIN_THETA` 1e-3: rust/geometry/src/clash_contact_axes.rs:32, 118
- `INSTANCED_ALPHA_CUTOFF` 0.99: rust/wasm-bindings/src/api/gpu_meshes/batch_partition.rs:27 (vs `TRANSPARENCY_ALPHA_THRESHOLD` 0.95 at rust/processing/src/style/mod.rs:59)
- Full-circle tolerance 0.001: rust/wasm-bindings/src/zero_copy/symbolic.rs:161
- `tolerance: 0.01`: rust/wasm-bindings/src/api/export_hbjson.rs:28, 49 and rust/wasm-bindings/src/api/export_dfjson.rs:24
- `PREPASS_INDEX_RESERVE_CAP`, `META_EMIT_JOB_THRESHOLD`: rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:227, 273
- `SAMPLE_STEP_FILE_UNITS`, `MAX_SAMPLES`: rust/wasm-bindings/src/api/alignment_lines.rs:37-38
- Stack size (256 MiB):
  - `PARSE_STACK_SIZE`: rust/ffi/src/lib.rs:51
  - `GEOMETRY_STACK_BYTES`: rust/python/src/lib.rs:51
- cloud-import limits:
  - `MAX_OCCURRENCES`, `MAX_DEPTH`, `MAX_POINTS`: rust/cloud-import/src/lib.rs:11-13
  - literal 256 depth: rust/cloud-import/src/meshes.rs:163
  - 64 MiB / 512 MiB file caps: rust/cloud-import/src/main.rs
- Python swept-disk check defaults (1e-9 / 1e-6 / 1e-6): rust/python/src/swept_disk_checks.rs:16

**Unit conversion**
- `units`, `scale`, `assumed_units`, `resolve_assumed_units`: rust/landxml/src/semantics.rs:55, 70, 91, 106
- `units`, `scale`, `measure`: rust/landxml/src/pipe_parser/convert.rs:12, 386, 337
- `area_scale`: rust/landxml/src/plan/parser/value.rs:7
- Parcel scaling: rust/landxml/src/plan/numeric/parcel_probe.rs:271-301
- Overlay unit scale:
  - rust/wasm-bindings/src/api/alignment_lines.rs:77-88
  - rust/wasm-bindings/src/api/grid_lines.rs:55-56
- `get_or_resolve_plane_angle`: rust/wasm-bindings/src/api/mod.rs:995
- `seed_unit_scales(1.0, …)`:
  - rust/wasm-bindings/src/api/gpu_meshes/batch.rs:171
  - rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:544
  - rust/wasm-bindings/src/api/gpu_meshes/prepass_sharded.rs:287
- Comparisons outside scope: `US_SURVEY_FOOT_SCALE` at rust/core/src/unit_labels.rs:76 (truncated); rust/export/src/landxml_terrain.rs:48-63; server rust path apps/server/src/services/data_model/mod.rs:152-162

**Bbox / AABB**
- `Aabb`, `from_positions`, `signed_gap`, `overlap_bounds`, `bounds_of_points`, `aabb_contains`, `depth_floor`, `estimate_floor`: rust/clash/src/aabb.rs:19, 54, 100, 106, 111, 122, 130, 137
- `js_max`/`js_min`, `ray_intersects_aabb`, `Bvh`, `compute_bounds`: rust/clash/src/bvh.rs:23, 35, 48, 89, 178
- `cube_around`, `tri_bounds`: rust/clash/src/tri_mesh.rs:50, 369
- geometry broadphase (`Aabb` tuple, `Bvh`): rust/geometry/src/kernel/broadphase.rs:36-131, 95
- `Contours2D::bounds`: rust/wasm-bindings/src/api/bool2d.rs:200
- `ElementMeshOutput::geometry_aabb`: rust/wasm-bindings/src/api/gpu_meshes/batch.rs:30
- World AABB: rust/wasm-bindings/src/zero_copy/mesh_fingerprint.rs:37, 87
- landxml: none (bbox tests are inline in its `on_segment` copies)

**Hashing**
- Zero-normalised f64 bits as BTreeMap key (`bits`): rust/landxml/src/terrain_topology.rs:44
- `child_ordinals`: rust/landxml/src/parser/state.rs:174
- `refusal_keys`: rust/landxml/src/pipe_parser/state.rs:43
- FNV-1a 32 `source_fingerprint`: rust/wasm-bindings/src/api/gpu_meshes/source_fingerprint.rs:6
- `fold_u128_to_u32`: rust/wasm-bindings/src/api/gpu_meshes/prepass_affinity.rs:13
- `style_wire_signature`: rust/wasm-bindings/src/api/gpu_meshes/style_finishes.rs:35 (inline copy at batch.rs:275-277)
- `push_geometry_hash`: rust/wasm-bindings/src/zero_copy/mesh_fingerprint.rs:153
- Pair dedup `HashSet<(u32,u32)>` (order-safe): rust/clash/src/session.rs:281
- Ancestor `HashSet`s (cycle checks): rust/cloud-import/src/lib.rs:53, 92 and rust/cloud-import/src/meshes.rs:158

**Triangulation and polygon ops**
- `adapt_faceless_tin`: rust/landxml/src/terrain.rs:25
- rust/landxml/src/terrain_topology.rs: `add_vertex` 52, `line_vertices` 103, `orient` 143, `on_segment` 158, `edges_touch` 166, `validate_simple_ring` 180, `ring_edges` 222, `point_in_ring` 260, `canonical_vertices` 289
- `point_is_in_permitted_region`: rust/landxml/src/terrain_filter.rs:10
- `point_on_segment`, `segment_fraction`, `validate_split_elevations`: rust/landxml/src/terrain_validation.rs:16, 59, 100
- rust/landxml/src/plan/numeric/topology.rs: `segments_intersect` 7, `intersects` 40, `overlaps_beyond_shared_endpoint` 95, `on_segment` 117, `point_in_loop` 131
- `probe_loop`, `curve_edges`: rust/landxml/src/plan/numeric/parcel_measure.rs:21, 161
- rust/clash/src/triangle.rs: `tri_tri_intersect` 32, `closest_pt_seg_seg` 64, `closest_pt_point_triangle` 120, `tri_tri_distance` 172
- rust/clash/src/tri_mesh.rs: `closest_on_surface` 260, `contains_point` (Möller–Trumbore) 311
- rust/wasm-bindings/src/api/bool2d.rs: `union_2d` / `difference_2d` / `intersection_2d` 209-246
- `split_mesh_by_zones_js`: rust/wasm-bindings/src/api/zone_split.rs:164
- `mesh_from`: rust/wasm-bindings/src/api/clash_solid.rs:146
- `holes_offsets`: rust/wasm-bindings/src/zero_copy/symbolic.rs:378-392
- `build_segments`, `build_wall_rects`: rust/wasm-bindings/src/api/space_plate_input.rs:52, 88

**Entity attribute access and decoding**
- XML attributes (`attributes`, `attr`, `required`, `split_name`, `utf8`, `character_references`, `unescape`): rust/landxml/src/xml.rs:60, 95, 102, 112, 120, 131, 135
- Properties helpers:
  - rust/landxml/src/parser/state.rs:199
  - rust/landxml/src/plan/parser/state.rs:83
  - rust/landxml/src/pipe_parser/state.rs:63
- Float parsers:
  - rust/landxml/src/semantics.rs:10, 22, 42
  - rust/landxml/src/parser/profiles/values.rs:8-111
  - rust/landxml/src/plan/parser/value.rs:26-118
  - rust/landxml/src/alignment/parser/actions/values.rs:27-110
  - rust/landxml/src/pipe_parser/convert.rs:326-384
- IFC attributes via `get_ref(0/5)` and `get(6).as_list`:
  - rust/wasm-bindings/src/api/styling/prepass.rs:164, 171, 206, 215, 266, 290, 336
  - rust/wasm-bindings/src/api/gpu_meshes/batch.rs:448, 461-465
  - rust/wasm-bindings/src/api/styling/color.rs:79-161
  - rust/wasm-bindings/src/api/grid_lines.rs:98-163
- `keyword_at`, `is_disabled`: rust/wasm-bindings/src/api/gpu_meshes/prepass_discovery.rs:29, 44

**Colour and style resolution**
- `find_color_for_geometry`, `resolve_element_color`, `walk_representation_for_direct_color`: rust/wasm-bindings/src/api/styling/color.rs:10, 134, 154
- `style_colors_from_wire`: rust/wasm-bindings/src/api/gpu_meshes/batch_partition.rs:206
- `style_finishes_from_wire`, `BatchFinishes`, `mesh_js_with_finish`: rust/wasm-bindings/src/api/gpu_meshes/style_finishes.rs:49, 65, 106
- `get_or_build_indexed_colour_maps`: rust/wasm-bindings/src/api/mod.rs:935
- `styles_payload`, `check_rgba_columns`: rust/wasm-bindings/src/api/gpu_meshes/prepass_sharded.rs:330, 342, 18
- `combined_pre_pass`: rust/wasm-bindings/src/api/styling/prepass.rs:34
- `is_class_toggled`, `CLASS_TOGGLED_TYPES`: rust/wasm-bindings/src/api/gpu_meshes/batch_partition.rs:140-155
- glTF material to IFCX presentation: rust/cloud-import/src/meshes.rs:204-215
- Python palette/face_colors emit: rust/python/src/lib.rs:168-172

**Error types**
- `LandXmlDiagnosticCode`, `LandXmlError`, `LandXmlTerrainDiagnostic`: rust/landxml/src/model.rs:12, 42, 230
- `error()`: rust/landxml/src/xml.rs:320
- `invalid` / `limit` helpers: rust/landxml/src/alignment/parser/state.rs:269, 272
- `LandXmlNumericDiagnostic`: rust/landxml/src/alignment/numeric.rs:21
- `LandXmlProfileEvaluationError`, `LandXmlCapabilityDiagnostic`: rust/landxml/src/profile.rs:84, 205
- `TopologyValidationError`: rust/landxml/src/terrain_topology.rs:32
- `SplitElevationValidationError`: rust/landxml/src/terrain_validation.rs:11
- Pipe `Result<_, String>`: rust/landxml/src/pipe_parser/convert.rs
- clash: none (silent sanitisation); unused Plato `Error`: rust/clash/src/generated/plato.rs:251
- wasm: `JsValue::from_str` vs `JsError` vs `js_sys::Error` + `set_name` (rust/wasm-bindings/src/api/space_plate.rs:316)
- `refuse`: rust/wasm-bindings/src/api/gpu_meshes/prepass_owned_columns.rs:23
- `ColumnLengthMismatch`: rust/wasm-bindings/src/api/entity_index.rs:54-66
- ffi: integer codes 0-4 (rust/ffi/src/lib.rs:193-200)
- python: `PyValueError` / `PyRuntimeError` from `String`
- cloud-import: `type Result<T> = Result<T, String>` (rust/cloud-import/src/lib.rs:10); main.rs prints a fixed message only
