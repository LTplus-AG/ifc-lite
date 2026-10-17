# rust/processing review

Scope: `rust/processing/` (~68k lines: orchestrator `processor/`, `element*`, `prepass*`, `parallel_scan*`, `shard_classes`, `mesh_frame`, `stream_meta`, `style/`, `appearance/`, `symbolic/`, `pdf_vector/`, `scan_*`, `analytic_export/`, `geometry_export`, `georeferencing`, `determinism`, `types/`) plus the consumer surfaces that mirror it (`rust/wasm-bindings/src/api/{gpu_meshes,styling}`, `apps/server/src/{services,types,routes/parse}`, `rust/ffi`, `rust/python`, `rust/export`). Paths are repo-relative. `appearance/` and `symbolic/`+`pdf_vector/` were reviewed by delegated sub-reviewers; their findings are merged below under the same numbering.

## Summary

- **The "one orchestrator" story is true for mesh production (`produce_element_meshes`) and post-scan resolution (`resolve_prepass`), but NOT for the scan itself or for the colour/plan inputs feeding them.** The STEP-keyword scan dispatch exists six times (native scan loop, `PrepassSpans::stash`, `shard_classes` NAMED_ARMS, wasm streaming scan, wasm `combined_pre_pass`, wasm `discover_from_columns`), the #957/#1623 type-geometry plan is computed three different ways, and the wasm batch still carries a verbatim copy of the element-colour walks that `element/element_color.rs` exposes a closure-form API for. These are the exact seams the #858/#913/#957 drift class came from, and they are where the remaining drift lives (PROCESSING-1..4, 9).
- **Two confirmed consumer drifts:** `apps/server` has its own `detect_schema_version` that disagrees with `processor/schema_detection.rs` on lowercase headers and on "IFC4X3 anywhere in DATA" (PROCESSING-5); and the per-element material fallback colour is "first opaque" on the native path but "first colour" on the wasm wire, which diverges on every fallback-path element whose first material colour is glass (PROCESSING-4).
- **The representation graph (`IfcProductDefinitionShape → Representation → Items → IfcMappedItem → RepresentationMap → …`) is walked by seven independent hand-written traversals inside processing**, each with its own cycle guard (depth cap + visited-depth map, iterative visited set, or none), and one of them (`opening_filter`) filters to meshed representations while the colour walks do not (PROCESSING-6).
- **Public API sprawl in the orchestrator:** 12 `process_geometry*` entry points plus `PassScope`/`baked_basis` side channels, a 1,180-line pipeline function, a 26-parameter `process_entity_job`, all driven by "StreamingOptions has pub fields so we add a function instead of a field" (PROCESSING-7, 8).
- **Math helpers are re-implemented per module**: seven private `dot/cross/sub/unit` mini-libs, four copies of "apply Rᵀ of a column-major 4x4", three row-major mat4 multiply/invert sets across processing/wasm/export, three vertex-weld/quantise implementations, and SHA-256 fingerprint writers in eight places (PROCESSING-10..13).
- **Sub-area reviews add two High bugs and a third re-implemented geometry layer.** `symbolic/` is a drifted f32 copy of geometry's operator/placement/curve evaluators (SYM-1/2/3; `Scale=-1` mirrors the mesh but not its symbol, `IfcIndexedPolyCurve.Segments` ignored, trimmed `IfcLine` dropped) and quantises georeferenced coordinates to f32 *before* the RTC rebase, so overlays sit up to 0.5 m off their meshes at 5,000 km (SYM-4, CONFIRMED). `appearance/` has four `AttributeValue → wire` converters, one of which `unreachable!()`s on a file-supplied `*` attribute reachable through `evaluatedOccurrence` (APP-1/2, LIKELY), plus three budget modules repeating the same caps by literal (APP-5). `pdf_vector/` hand-rolls its DrawOPS cursor eight times (SYM-5).
- Bugs in the orchestrator core are mostly SUSPECT/LIKELY quirks rather than crashes: the crate is disciplined about `unwrap`, overflow and HashMap order (`flat_*` wires sort, `dominant()` tie-breaks, instancing finalize sorts). The notable hazards are the two drifts above, the non-unit-scaled storey elevation in the quick-metadata bootstrap, and the server re-resolving every styled item a second time per request for finishes.
- Test code is the single largest copy-paste surface: `read_fixture()` is re-declared in ≥8 integration tests, `MeshProductionContext` fixture blocks in `element_tests.rs` are cloned, and jscpd flags 42 intra-processing clones nearly all in `tests/` — a `tests/common/fixtures.rs` would remove most of them (PROCESSING-20).

## Findings

### PROCESSING-1: STEP-keyword scan dispatch implemented six times across native and wasm
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - `rust/processing/src/processor/mod.rs:598-827` (native scan loop; 25 `keyword_eq` arms + `geometry_flags_by_name` + `nth_attribute_is_present` #1910 exception + `type_product_ifc_type`)
  - `rust/processing/src/prepass.rs:66-88` (`PrepassSpans::stash`, 8 arms)
  - `rust/processing/src/shard_classes.rs:463-497` (`classify_type_name` NAMED_ARMS table, 13 arms + 2 flag predicates) and `:439-448` (`classify_type_name_with_content`, the #1910 exception again)
  - `rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:373-433` (streaming scan: `stash` + IFCPROJECT/IFCSITE/IFCMAPPEDITEM/IFCMATERIALLAYERSET* arms + `has_geometry_by_name` + #1910 exception)
  - `rust/wasm-bindings/src/api/styling/prepass.rs:420-459` (`combined_pre_pass`: `stash` + IFCPROJECT/IFCSITE + simple/complex split + #1910 exception a third time)
  - `rust/wasm-bindings/src/api/gpu_meshes/prepass_discovery.rs:855-945` (`discover_from_columns`: a `match` over the class codes that re-expands into the same `PrepassSpans` lists)
- What: Every one of these is the same decision table ("which list does this record go in, is it a geometry job, is it a type candidate, is it the project/site"), spelled by hand each time. `prepass.rs:16-22` explicitly accepts this ("the two scan loops remain per-pipeline"), but there are now six, not two, and the code comments at `shard_classes.rs:434-437` and `styling/prepass.rs:444-455` ("third instance, Greptile-flagged … had the identical gap") record that the #1910 exception was missed in two of them and had to be patched three times. Drift present today: the native loop never looks at `IFCMATERIALLAYERSET` and builds `MaterialLayerIndex::from_spans` unconditionally (`processor/mod.rs:1073-1076`), while the wasm paths gate it on `has_layer_set` (`gpu_meshes/prepass.rs:624-632`) to "stay bit-identical to `get_or_build_material_layer_index`" — the output is the same, but the native side pays the decode of every `IfcRelAssociatesMaterial` on files with no layer sets. `combined_pre_pass` still computes a simple/complex job split (`is_simple_geometry_type`) that its own sibling comment (`gpu_meshes/prepass.rs:409-412`) says nothing reads any more.
- Why it matters: this is the documented #858/#913/#957/#1910 bug class — a new record kind (the next `IfcRelX` the resolver needs) has to be added in six places with three different encodings (keyword chain, class byte, `match` on class byte); the class-byte table and the `stash` table are only kept in sync by a hand-written test (`shard_classes.rs:549-584`).
- Fix: one `prepass::ScanObserver` (or `ScanRecord` enum) in processing: `fn classify(type_name, record_bytes) -> ScanClass` returning an enum (`StyledItem | IndexedColourMap | … | Project | Site | MappedItem | TypeCandidate(IfcType) | GeometryJob(IfcType) | None`), with `impl From<ScanClass> for u8` for the shard wire and `PrepassSpans::push(ScanClass, span)`. The native loop, `stash`, `classify_type_name`, both wasm scans and `discover_from_columns` all consume the one enum; the #1910 and type-candidate predicates live once. Keep the native-only arms (presentation layers, properties, quick-metadata) as a thin `match` on the enum in `processor/mod.rs`.
- Effort: M

### PROCESSING-2: The #957/#1623 type-geometry plan (referenced RepresentationMaps, instantiated type ids, mapped-instance plan, type candidates) is computed three different ways
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - `rust/processing/src/processor/mod.rs:788-826` (native, inline during the scan, via the hand-rolled `parse_step_arguments`/`parse_step_ref` byte tokenizers) and `:839-864` (job synthesis)
  - `rust/wasm-bindings/src/api/styling/prepass.rs:565-598` (`collect_type_geometry_jobs_from_spans`), `:625-639` (`build_referenced_representation_maps_from_spans`), `:649-669` (`build_mapped_instance_plan_from_spans`), `:695-709` (`build_instantiated_type_ids_from_spans`) — decoder-based, from spans
  - `rust/wasm-bindings/src/api/styling/prepass.rs:506-555` (`collect_type_geometry_jobs`), `:603-616` (`build_referenced_representation_maps`), `:676-689` (`build_instantiated_type_ids`) — full-file `EntityScanner` re-walks, each its own loop
  - `rust/wasm-bindings/src/api/mod.rs:841-898` (`get_or_build_referenced_repmaps`, `get_or_build_instantiated_type_ids`: per-worker lazy rebuild of the same sets)
- What: The same three facts (which maps an `IfcMappedItem` references; which types an `IfcRelDefinesByType` instantiates; which sources repeat ≥2 times) are derived by (a) a byte tokenizer on the native side, (b) a decoder over stashed spans on the wasm side, and (c) a decoder over a fresh scan as the wasm fallback. The native plan additionally tracks the min-id template per source (`mapped_item_plan: (count, min_id)`), the wasm plan ships only the sorted id list and picks templates per batch. `plan_type_geometry` in `element.rs:157` correctly centralises the *decision*, but its three *inputs* are rebuilt per consumer.
- Why it matters: `processor/mod.rs:807-813` reads `RelatingType` as `args.get(5)` from raw bytes while the wasm path reads `entity.get_ref(5)`; `parse_step_ref` (`quick_metadata.rs:101`) accepts only `#<digits>` after `trim_ascii`, so any divergence in how `StepListItems::of_record` and the full decoder treat trivia/comments inside the record is a silent parity split in which types render. The three wasm full-rescan functions are a 2nd/3rd/4th walk of the file for the one-shot `buildPrePassOnce` path.
- Fix: `prepass::TypeGeometryPlan::from_spans(mapped_item_spans, defines_by_type, type_candidate_spans, decoder) -> { referenced: FxHashSet<u32>, instantiated: FxHashSet<u32>, instance_plan: FxHashMap<u32,(count,min_id)>, candidates: Vec<(id, IfcType, Vec<u32>)> }` in processing, fed by the `ScanObserver` of PROCESSING-1. Native, both wasm pre-passes and the per-worker fallback call it; `build_mapped_instance_plan_from_spans` becomes `plan.instance_plan.keys().sorted()`.
- Effort: M

### PROCESSING-3: wasm `styling/color.rs` is a verbatim copy of `element/element_color.rs`'s walks, despite processing exposing the closure-form API for exactly that caller
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - `rust/wasm-bindings/src/api/styling/color.rs:10-108` (`find_color_for_geometry` / `find_color_for_geometry_at`) ≡ `rust/processing/src/element/element_color.rs:30-109` (`find_geometry_item_style_source` / `_at`) — same depth cap, same visited-depth map, same attr-0/attr-1/attr-3 chase, same doc comments ("Codex, #2868 review")
  - `rust/wasm-bindings/src/api/styling/color.rs:154-179` (`walk_representation_for_direct_color`) ≡ `element_color.rs:146-171` (`product_shape_style_source`)
  - `rust/wasm-bindings/src/api/styling/color.rs:134-148` (`resolve_element_color`) ≡ `rust/processing/src/processor/color_layer.rs:30-36` + `processor/mod.rs:1333-1348` (element colour precedence: representation style, else element-keyed material colour)
- What: `element_color.rs:47-50` says "`has_style` is the style map's membership test, so a caller holding the colour map in another shape (the wasm batch's `id -> rgba`) walks exactly the same path" — i.e. the shared home was built for the wasm batch, and the wasm batch still does not use it. `styling_parity.rs` cannot catch this because it greps for the historical function names (`get_default_color*`, `extract_color_from_rendering`, `extract_color_rgb`) only.
- Why it matters: the two walks were patched in lockstep for #2863/#2864/#2868 (the comments prove it); the next guard change (e.g. widening the cap, or the `meshed_representations` filter in PROCESSING-6) will land in one and not the other.
- Fix: delete `styling/color.rs`; `resolve_element_color` becomes `ifc_lite_processing::element::product_shape_style_source(pds, &|id| styles.contains_key(&id), decoder).and_then(|s| styles.get(&s))` plus the element-keyed fallback, and that fallback itself should move into processing as `style::resolve_element_fallback_color(entity, has_style, material_colors)` so PROCESSING-4 closes too.
- Effort: S

### PROCESSING-4: Element-level material fallback colour drifts between native ("first opaque") and wasm ("first colour")
- Category: Bug (parity drift)
- Severity: High
- Confidence: LIKELY
- Where:
  - native: `rust/processing/src/processor/mod.rs:1148-1151` (`element_material_color = pick_opaque_first(colors)`), consumed at `:1344-1348` and `:281-283`
  - wasm wire: `rust/processing/src/prepass.rs:538-542` (`flat_styles_rgba8`: `colors.first()`), and the sharded twin `rust/processing/src/prepass_styled.rs:116-120`; consumed by `rust/wasm-bindings/src/api/styling/color.rs:147` (`geometry_styles.get(&entity.id)`)
- What: Both pipelines hand `produce_element_meshes` an `element_color` that, when the product has no representation-level style, is the element's material colour. Native picks the first colour with alpha ≥ 0.95 (`style/material.rs:85-96`), the wasm pre-pass folds `colors.first()` into `styleIds` keyed by element id. For a window whose `IfcMaterialList` is `[glass(α=0.4), frame(α=1.0)]` native says frame, wasm says glass. `element_color` is used directly on the fallback path (`element.rs:440-444`, `emit_fallback_mesh`), on type geometry with no map style (`element.rs:716-718`), and by `is_opaque_opening` (`processor/opening_filter.rs:151-157`).
- Why it matters: any element that falls off the sub-mesh path (unsupported item mix, empty sub-mesh collection) renders translucent in the viewer and opaque on the server/export for the same bytes. There is no parity test on this value (see Parity gaps).
- Fix: make the wire carry what native computes: `flat_styles_rgba8` / `flat_styles_rgba8_from_geometry_columns` use `pick_opaque_first(colors)` — or better, stop folding element colours into `styleIds` at all and let the batch compute the fallback from `material_colors_from_flat` through one shared `style::element_fallback_color`. Add a pinning test in `tests/styling_parity.rs` that runs both resolvers over the material-chain fixture.
- Effort: S

### PROCESSING-5: `apps/server` has its own `detect_schema_version` that disagrees with processing's
- Category: Bug (DRY drift)
- Severity: High
- Confidence: CONFIRMED
- Where: `apps/server/src/services/streaming.rs:56-88` (`find_bytes` + `detect_schema_version`, header-only, case-sensitive) vs `rust/processing/src/processor/schema_detection.rs:22-39` (whole-file, case-insensitive, "IFC4X3 anywhere wins"); consumer `apps/server/src/routes/parse/json.rs:259` (`/metadata` endpoint) vs `ModelMetadata.schema_version` on every geometry endpoint.
- What: the server version says `FILE_SCHEMA(('ifc4'))` is `IFC2X3` (case-sensitive `windows()` search), which #4661 fixed in processing; the processing version says a file whose header is `IFC2X3` but whose DATA contains the substring `IFC4X3` (a description, a comment, a `IfcPropertySingleValue` text) is `IFC4X3`, which the server comment at `:64` explicitly forbids ("Schema-like text in DATA values or comments must not influence metadata"). The two documented intents contradict each other, and neither owner knows about the other.
- Why it matters: `/api/v1/metadata` and `/api/v1/parse` on the same upload return different `schema_version`; a client keying schema-dependent behaviour (attribute indices, 2x3 vs 4 property layouts) on one endpoint gets the other's answer. `find_bytes` is also an O(n·m) `windows()` scan over the full content for `ENDSEC;`.
- Fix: export `ifc_lite_processing::detect_schema_version` (header-scoped AND case-insensitive — the header-scoping argument is the correct one; fix processing to search only `[..data_section_start]` via `ifc_lite_core` `scanner_header::data_section_start`), delete the server copy, pin with a test that feeds both a lowercase header and an `IFC4X3`-in-DATA decoy.
- Effort: S

### PROCESSING-6: The representation graph is walked by seven independent hand-written traversals with three different cycle-guard strategies
- Category: DRY
- Severity: High
- Confidence: CONFIRMED (drift LIKELY)
- Where:
  - `rust/processing/src/element/element_color.rs:60-109` (`find_geometry_item_style_source_at`: recursive, depth cap + visited-depth map)
  - `rust/processing/src/element/element_color.rs:146-171` (`product_shape_style_source`: PDS → reps → items, no guard, delegates per item)
  - `rust/processing/src/element/element_color.rs:124-137` (`representation_map_style_source`)
  - `rust/processing/src/element/element_color.rs:178-197` (`find_indexed_colour_for_element`: PDS → reps → items, one level, no mapped-item chase)
  - `rust/processing/src/element/element_color.rs:208-237` (`element_reaches_indexed_colour`: iterative, visited set over representations, chases mapped items)
  - `rust/processing/src/processor/opening_filter.rs:166-205` (`scan_item_styles`: iterative stack, depth cap + visited-depth map, filtered by `meshed_representations`)
  - `rust/processing/src/processor/color_layer.rs:140-233` (`resolve_presentation_layer_name`: iterative, visited set, parent chain memo, items pushed in reverse for document order)
  - (plus `style/finish_join.rs:82-100` composing two of the above, and the wasm copies in PROCESSING-3)
- What: every walk re-spells "attr 6 → attr 2 → attr 3 → (IfcMappedItem attr 0 → attr 1 → attr 3)". Three guard regimes coexist (`MAX_MAPPED_ITEM_DEPTH` + visited-depth, visited-set-only iterative, none). Drift: `opening_filter.rs:149-156` filters to `meshed_representations(&entity, &reprs)` (#4699: "only the representations the router meshes count"), but `product_shape_style_source` — the element colour the opening filter is defending — walks *every* representation including `Axis`/`FootPrint`, so a styled axis `IfcPolyline` can set the element colour of a wall whose body is unstyled, and the opening filter and the colour resolver can disagree about the same element.
- Why it matters: the #2863/#2864/#2868 history (stack overflow, then exponential fan-out, then wrong-answer from the naive guard combination) was fixed per-walk. The next malformed-file class will again be fixed in one walk at a time.
- Fix: one `element::RepresentationWalk` iterator in processing (`fn items(entity_or_pds, decoder, filter: RepFilter) -> impl Iterator<Item = (item_id, depth, owner_rep)>`), iterative, visited set, document order, mapped-item chase bounded by `MAX_MAPPED_ITEM_DEPTH`; `RepFilter::Meshed` wraps `ifc_lite_geometry::meshed_representations`. The seven walks become predicates over it; `color_layer`'s parent-chain memo becomes an optional visitor hook.
- Effort: M

### PROCESSING-7: Twelve public `process_geometry*` entry points plus two side-channel structs, because `StreamingOptions` has public fields
- Category: Maintainability
- Severity: High
- Confidence: CONFIRMED
- Where: `rust/processing/src/lib.rs:85-93` (re-exports), `rust/processing/src/processor/mod.rs:330-466`, `processor/id_filter.rs:17-58`, `processor/baked_basis.rs:26-59` (`PassScope`, `process_geometry_streaming_filtered_with_baked_basis`); the doc at `baked_basis.rs:8-12` and `id_filter.rs` spell out the cause ("that struct is public with public fields, so a new field would break every caller that builds it with a struct literal. This is additive instead.").
- What: `process_geometry`, `_with_index`, `_filtered`, `_filtered_with_quality`, `_filtered_with_quality_and_ids`, `_streaming`, `_streaming_with_options`, `_streaming_with_options_and_bootstrap`, `_streaming_filtered`, `_streaming_filtered_with_options`, `_streaming_filtered_with_baked_basis`, and the private `_with_options_and_ids` — all thin wrappers that end in one function. Every caller surveyed (`apps/server/src/services/streaming.rs:141`, `rust/ffi/src/lib.rs:113`, `rust/python/src/lib.rs:83`, `rust/export/src/gltf.rs:1533/1556/1736`) picks a different one, so the "what does the server do that the ffi doesn't" question needs a diff of wrapper chains.
- Why it matters: the next pass-scoped input (an id allow-list AND a baked basis are already two) will add a 13th function; the `StreamingOptions` doc comment on `cancel`/`entity_index`/`enable_instancing` already shows the options struct is the right place and it keeps getting bypassed.
- Fix: `#[non_exhaustive] pub struct ProcessingRequest { opening_filter, quality, options…, entity_ids: Option<Arc<HashSet<u32>>>, baked_basis_out: Option<&OnceLock<..>> }` with a builder (`ProcessingRequest::new().opening_filter(..).ids(..)`), one `pub fn process(content, &ProcessingRequest, &mut dyn ProcessingSink) -> ProcessingResult` where `ProcessingSink` has default no-op `on_batch/on_color_update/on_bootstrap`. Keep `process_geometry(content)` as the one convenience. Deprecate the rest for one release (the crate is published).
- Effort: M

### PROCESSING-8: `processor/mod.rs` is a 1,656-line file around one 1,180-line function; `process_entity_job` takes 26 parameters
- Category: Maintainability
- Severity: High
- Confidence: CONFIRMED
- Where: `rust/processing/src/processor/mod.rs:468-1649` (`process_geometry_streaming_filtered_with_options_and_ids`); `rust/processing/src/processor/jobs.rs:96-150` (26 params, `#[allow(clippy::too_many_arguments)]` with the comment "factoring the args into a struct would not change behavior and is out of scope"); `tests/module_size_allowlist.txt` carries `1661 rust/processing/src/processor/mod.rs` and `816 element.rs`, `781 prepass.rs`, `499 determinism.rs`, `410 jobs.rs` as frozen budgets.
- What: scan (600-827), plan (839-864), resolve (870-931), quick-metadata tree build (953-1045, 90 lines of logic that belongs in `quick_metadata.rs`), frame selection (1079-1106), the parallel loop (1290-1503), and diagnostics/finalize (1505-1649) all share one scope with ~70 locals. The `cfg(target_arch = "wasm32")` fork at 1307-1379 duplicates the metadata phase (PROCESSING-14). `lib.rs:28-37` documents that `determinism_tests.rs` is declared from `lib.rs` "because that module already sits exactly at its frozen budget; adding even a `mod` declaration there would fail the gate" — the ratchet is being gamed rather than the file split.
- Why it matters: every reviewer of a pipeline change reads 1,200 lines to find the 10 that matter; the per-phase `ProcessingStats` timers are the only structure.
- Fix: split into phases with explicit structs: `ScanOutput { prepass_spans, jobs, type_plan, quick: Option<QuickMetadataCollector>, project_id, site, building, georef_candidates, index }` → `ResolvedContext` (from `resolve_prepass` + unit scales + frame) → `GeometryPass { ctx: Arc<PassContext>, collectors }` where `PassContext` bundles the 20 read-only `process_entity_job` arguments. Each phase is a ≤300-line module; `mod.rs` becomes the ~100-line sequencer.
- Effort: L

### PROCESSING-9: wasm `combined_pre_pass` is a fourth full-file scan path with its own job classification, followed by a fifth scan for type jobs
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/wasm-bindings/src/api/styling/prepass.rs:401-488` (`combined_pre_pass`) and `:478` → `:506-555` (`collect_type_geometry_jobs`, second `EntityScanner::new(content)` walk); `rust/wasm-bindings/src/api/mod.rs:733-935` (six `get_or_build_*` per-worker full-file rebuilders: parts_to_skip, material_layer_index, referenced_repmaps, instantiated_type_ids, texture_index, indexed_colour_maps)
- What: `buildPrePassOnce` scans the file once for spans/jobs, then `collect_type_geometry_jobs` scans it again for mapped items and type candidates that the first scan already saw (the streaming pre-pass fixed exactly this with `_from_spans`, #962 — the one-shot path was not updated). Each geometry worker then lazily re-walks the whole file up to six more times on its first batch unless the host shipped the columns.
- Why it matters: on the "small file" one-shot path (which the viewer's non-SAB fallback uses) that is 2 + 6·workers walks; and each walk is another copy of the keyword table (PROCESSING-1).
- Fix: `combined_pre_pass` consumes the `ScanObserver` of PROCESSING-1 and the `TypeGeometryPlan` of PROCESSING-2; the six `get_or_build_*` become one `get_or_build_prepass_columns` that runs the shared observer once and caches a `PrepassColumns` struct.
- Effort: M

### PROCESSING-10: "Apply the transpose of a column-major 4x4's rotation block" is spelled four times
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/processing/src/processor/site_local.rs:112-137` (`apply_inverse_rotation_in_place`, f32 triplets), `:165-191` (`apply_inverse_rotation_point_f64`), `:70-80` (`native_to_baked`: same 9-element extraction into `rot`), `rust/processing/src/mesh_frame.rs:759-768` (`MeshFrame::rotate_into_frame`), and the 9-element extraction once more in `mesh_frame.rs:625-648` (`rotation_is_identity`).
- What: all four read `m[0],m[1],m[2],m[4],m[5],m[6],m[8],m[9],m[10]` and compute `Rᵀ·v`; two of them carry their own `len() < 16` / identity guards, two don't. `mesh_frame.rs:747-754` even documents that `rotate_into_frame` "is exactly what `convert_mesh_to_site_local` bakes … same `Rᵀ`, applied under the same condition" — asserted by comment, not by sharing code.
- Why it matters: `rotate_into_frame` is the symbolic stream's view of the mesh frame (#4706); if either copy ever changes the convention (row-vs-column) the meshes and the 2D overlay silently separate.
- Fix: `MeshFrame::rotation() -> Option<Rot3>` (a `[f64; 9]` newtype with `apply_f64(&self, [f64;3])`, `apply_f32_in_place(&self, &mut [f32])`, `is_identity()`); `site_local.rs` and `native_to_baked` call it. `rotation_is_identity` becomes `Rot3::from_column_major(m).is_identity()`.
- Effort: S

### PROCESSING-11: Row-major mat4 multiply / transform / invert / Y-up conjugation exist in processing, wasm-bindings and export, with the geometry crate owning nalgebra
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/processing/src/simplify_math.rs:26-102` (`conjugate_yup_to_zup` with inline `S`/`ST`, `matmul_row_major`, `transform_point_row_major`, `invert_affine_row_major`); `rust/wasm-bindings/src/zero_copy/frame_swap.rs:35-60` (`swap_zup_to_yup_mat4` with the SAME `S`/`ST` constants and a nested `fn matmul` — jscpd clone of `simplify_math.rs:28-41`); `rust/export/src/gltf/matrix.rs:40-66` (`S_YUP_INV`, `IDENTITY16`, `mat4_mul`); `rust/processing/src/processor/site_local.rs:84-90` (hand-expanded `Rᵀ·T(-rtc)`); `rust/geometry/src/instancing/dont_bake.rs:21-57` (`compose_instance_world_row_major`, `instance_rel_row_major_f32`); `rust/geometry/src/scalar.rs:114` (`transform_point4`, nalgebra).
- What: the Z-up→Y-up permutation matrix is declared three times (once as `S`+`ST`, once as `S_YUP_INV`, once implicitly in `yup_to_zup`/`zup_to_yup` at `simplify_math.rs:13-22` and in `frame_swap.rs` for AABBs). Each crate has its own 4x4 multiply.
- Why it matters: `simplify_math.rs` exists only to undo what `frame_swap.rs` did; they are kept equal by a jscpd hit and a test, not by sharing. The export matrix module composes `S_YUP · native_to_baked` with its own multiply.
- Fix: `ifc_lite_geometry::math::rm4` (row-major `[f64;16]` helpers: `mul`, `transform_point`, `invert_affine`, `const ZUP_TO_YUP`, `conjugate(m, basis)`) used by processing, wasm-bindings and export; nalgebra stays internal to geometry.
- Effort: S

### PROCESSING-12: Seven private `dot/cross/sub/add/unit` vector mini-libraries inside processing
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/processing/src/appearance/authored.rs:18-24`, `appearance/calibration.rs:36-50`, `appearance/mapping.rs:31`, `appearance/transfer_math.rs:8-20`, `pdf_vector/strokes.rs:14-26` (2D), `scan_proposals/frame.rs:12-30` (`V3` + `add/scale/norm/unit`), `scan_segmentation/normals.rs:16` (`unit(Vec3) -> Option<Vec3>`), `scan_segmentation/extent.rs:15`/`ring.rs:38` (two `type P2 = [f64;2]`).
- What: the same three-line functions, with inconsistent contracts (`unit` returns `V3`, `Option<Vec3>`, or `Result<[f64;3], String>` depending on the module). `point_pca.rs` correctly centralises the eigen decomposition on nalgebra, so the crate already pays for nalgebra; the mini-libs avoid it for `[f64;3]` arrays.
- Why it matters: three different "unit vector of zero" behaviours (`NaN`, `None`, `Err`) in one crate; a tolerance change to one `unit` does not reach the others.
- Fix: one `ifc_lite_geometry::math::v3` (`dot, cross, sub, add, scale, norm, unit -> Option`) and `v2` module; processing imports it. (`appearance/` and `pdf_vector/` sites are also listed by the sub-reviewers below.)
- Effort: S

### PROCESSING-13: Three vertex-weld/quantise implementations and nine fingerprint hashers
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: welds — `rust/processing/src/geometry_export.rs:287-328` (`weld_positions`: `BTreeMap<(i64,i64,i64)>` on a `1/eps` grid, drops degenerates), `rust/geometry/src/mesh_weld.rs:182-299` (`weld_indexed`/`weld`: `FxHashMap<VKey>`), `rust/geometry/src/geom_hash.rs` (`GeometryHasher` quantisation grid, `tolerance`). hashes — `rust/processing/src/determinism.rs:150-172` (hand-rolled FNV-1a over bytes/u32/f32 bits), `Sha256` writers in `pdf_vector/mod.rs:44`, `pdf_vector/report.rs:129`, `appearance/pdf_fill.rs:254`, `appearance/page.rs`, `appearance/registration.rs:194`, `appearance/evaluated_mask.rs:58`, `appearance/transfer.rs:201`, `appearance/atlas_plan.rs`, `analytic_export/definitions.rs:10`, plus `rust/geometry/src/geom_hash.rs:287` (`hash_mesh_world`) and `rust/wasm-bindings/src/api/gpu_meshes/source_fingerprint.rs`.
- What: `weld_positions` is a third quantised-weld with its own key type and its own degenerate drop, next to the crate-level `mesh_weld` + `drop_degenerate_triangles` that `build_mesh_data` already runs. The Sha256 sites each hand-write "feed these fields in this order" with no shared `Fingerprint` writer (the `Writer(Sha256)` adapter at `transfer.rs:201` is the only reusable piece and is private).
- Why it matters: `geometry_export`'s weld keys on `round(v/eps)` (ties can split a shared vertex across two cells) while `mesh_weld` uses a different key; the export's `GeometryDataExport` therefore does not necessarily reproduce the mesh topology the pipeline certified closed. Nine field-order hashers are nine places where adding a field silently changes a cache key.
- Fix: `geometry_export` calls `ifc_lite_geometry::mesh_weld::weld_indexed` with the export tolerance; one `processing::fingerprint::Sha256Writer` (impl `std::io::Write` + `fn field<T: Hashable>`) used by every Sha256 site; `determinism.rs` keeps FNV only if the manifest format must stay stable (document why).
- Effort: M

### PROCESSING-14: Per-job metadata population duplicated between the wasm32 and native cfg forks
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/processing/src/processor/mod.rs:243-298` (`populate_entity_job_metadata`, `#[cfg_attr(not(wasm32), allow(dead_code))]`, called only at `:1366-1379`) vs `:1307-1363` (native Phase 1 parallel decode + Phase 2 serial colour/layer resolution).
- What: identical logic (decode → `normalize_optional_string(get_string(0/2))` → `get_ref(6)` → colour cache → layer cache) written twice; the only real difference is `decode_at` vs `decode_at_uncached` and the `par_iter_mut` on Phase 1. The native Phase 2 is itself the body of `populate_entity_job_metadata` minus the decode.
- Why it matters: the #3987 `decode_at_uncached` fix landed on the native fork only; the wasm serial fork still deep-clones through the entity cache.
- Fix: split `populate_entity_job_metadata` into `decode_job_identity(job, decoder)` (Phase 1, target-independent) and `resolve_job_appearance(job, caches…)` (Phase 2); the native path calls the first under `par_iter_mut` and the second serially; wasm calls both serially. One body each.
- Effort: S

### PROCESSING-15: Hand-rolled STEP tokenisers and `$`/empty-string normalisers next to the core decoder
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/processing/src/processor/quick_metadata.rs:85-134` (`parse_step_arguments`, `parse_step_string` — its own `''`→`'` unescape then `decode_ifc_string`, `parse_step_ref`, `parse_step_ref_list`, `extract_name_from_args`, `extract_storey_elevation_from_args`); the same tokenisers reused by the native scan loop at `processor/mod.rs:609-655, 789-825`; `rust/wasm-bindings/src/api/gpu_meshes/prepass_discovery.rs:806-815` (`keyword_at`) duplicated verbatim in `rust/processing/tests/issue_2053_shard_scan_parity.rs:57-66`; `rust/export/src/merged/plan.rs:225` (`parse_ref_list`) and `export/src/merged/line_edit.rs:163` (`parse_ref`) are the `&str` twins. Normalisers: `processor/mod.rs:305-311` (`normalize_optional_string`: trim, `""`/`"$"` → None), `prepass.rs:761-770` (`normalize_style_name`: same plus `<unnamed>`), `processor/properties.rs:22-30` (`normalize_ifc_property_name`: wraps the first and trims again), `style/fill.rs:79-81` (`filter(|s| !s.trim().is_empty())`).
- What: `ifc_lite_core` already owns `parse_express_id`, `StepListItems::{of_record, of_list}`, `nth_attribute_is_present`, `decode_ifc_string`, and the full `EntityDecoder`; processing wraps them in a second mini-decoder so the quick-metadata path can avoid building `DecodedEntity`s. `parse_step_string` re-implements the `''` unescape that `decode_ifc_string`'s caller in core already handles.
- Why it matters: `parse_step_ref` accepts `#12` only; `StepListItems` and the decoder agree on trivia, but a record like `#12 /*c*/` or an inline typed ref would be read by two tokenisers with two answers, and only one of them is fuzzed (#1500 covers the core decoder). `extract_storey_elevation_from_args` falls back to "the first numeric attribute under 1 km" when attr 9/8 are not numeric — a heuristic over the whole record.
- Fix: move the raw-record helpers into `ifc_lite_core::parser::scanner_attributes` as `RecordView { fn ref_at(i), fn ref_list_at(i), fn string_at(i), fn float_at(i) }` built on `StepListItems`, with the `''`/escape handling shared with the decoder; one `core::normalize_step_string(Option<&str>) -> Option<String>` replaces the four normalisers (the `<unnamed>` rule becomes a style-specific filter on top).
- Effort: S

### PROCESSING-16: Server streaming/JSON routes resolve every styled item twice per request (`ModelFinishes::from_content` + the pipeline's own `resolve_prepass`)
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/processing/src/style/finish_join.rs:171-193` (`ModelFinishes::from_content`: full `EntityScanner` walk, builds its own `EntityIndex`, runs `resolve_geometry_finishes` AND `resolve_styled_items_into` over every styled item); called from `apps/server/src/services/streaming.rs:139` before `process_geometry_streaming_filtered_with_baked_basis` at `:141`, which scans the same bytes and resolves the same styled items again (`processor/mod.rs:880-887`).
- What: the finish index could not go on `MeshData` (semver), so the server rebuilds the whole style context from scratch outside the pipeline. On the `fast_first_batch` path the pipeline defers attached styles while `ModelFinishes` resolves them eagerly, so the two style indexes can also disagree mid-stream.
- Why it matters: a second full scan + a second decode of every `IfcStyledItem`/`IfcSurfaceStyle` per server request (styled items are ~5-10% of entities on ArchiCAD/Revit files); peak memory holds two entity indexes.
- Fix: the pipeline already has `prepass_spans.styled_items` and the decoder in hand — compute `resolve_geometry_finishes` once in `resolve_prepass` (behind `ResolveOptions::collect_finishes`) and expose `ProcessingResult::finishes: Option<Arc<ModelFinishes>>` (a new field on a non-`Deserialize` result struct is cheap; or hand it to the batch callback). The server's `finish_meshes` then joins against it.
- Effort: S

### PROCESSING-17: Opening filter decodes every window/door (and its whole representation chain) a second time before the metadata phase decodes it again
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/processing/src/processor/opening_filter.rs:118-125` (`is_opaque_opening`: `decode_at` per job), `:141-152` (collects `Vec<DecodedEntity>` of all representations just to filter them), `:128-133` and `:239-247` (`to_lowercase().contains("glas")` allocates per entity/style); the metadata phase then decodes the same job at `processor/mod.rs:1320`.
- What: with `IgnoreOpaque` on, each `IfcWindow`/`IfcDoor` is decoded once here, once in the metadata phase, and once more in `process_entity_job` (fresh per-element decoder). The `reprs` Vec is a full clone of every representation entity (Arc'd attributes, but still a `DecodedEntity` per rep).
- Fix: run the opening filter after Phase 1 of the metadata loop (it only needs `product_definition_shape_id` + name), or cache the decoded PDS on the job; `eq_ignore_ascii_case`-style `contains` without allocation (`memchr`/`find_keyword` on `b"GLAS"`).
- Effort: S

### PROCESSING-18: Quick-metadata storey elevation is emitted in file units, not metres
- Category: Quirk
- Severity: Medium
- Confidence: SUSPECT
- Where: `rust/processing/src/processor/quick_metadata.rs:116-134` (`extract_storey_elevation_from_args`), consumed at `processor/mod.rs:615-619` BEFORE `resolve_unit_scales` runs at `:1056`; `types/response.rs` `QuickMetadataEntitySummary.elevation: Option<f64>` has no unit doc.
- What: the bootstrap is emitted at the end of the scan phase, before the unit scale is known, so a millimetre file ships `elevation: 3000.0` while every other number on the response (`origin_shift`, `site_transform`) is in metres. The "first numeric attribute < 1 km" fallback at `:129-134` compares a file-unit value against `LARGE_COORD_THRESHOLD_METERS`, so on a millimetre file a storey at +1.2 km elevation (1_200_000 mm) is rejected and the fallback picks whatever smaller number appears first in the record.
- Why it matters: the TS tree sorts/labels storeys by this value; mixing units silently reorders or mislabels on mm files (most Revit/ArchiCAD exports).
- Fix: either resolve the unit scale before the bootstrap (it is one indexed decode once `project_id` is known — the inline index is complete at `:870`, i.e. before the bootstrap is emitted at `:1039`), or document the field as file units and drop the metre-threshold fallback.
- Effort: S

### PROCESSING-19: Native vs wasm entity-index construction strategies differ (compact-page builder vs columnar-from-hashmap) with different thresholds
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/processing/src/processor/entity_index.rs:58-141` (`IndexBuilder::{Hash, Compact}`, `PAGE_ROWS = 4096`, `compact_eligible` at ≥ 32 MiB, `max_rows = len/50` spill-to-hash); `rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:245-262, 518-523` (`FxHashMap` with `PREPASS_INDEX_RESERVE_CAP = 40_000_000` then `ColumnarEntityIndex::from_hashmap_consuming`); `rust/processing/src/parallel_scan/native.rs:193-204` (stitch into a third `FxHashMap::with_capacity(len/50)`); `rust/core` owns `EntityIndex`, `ColumnarEntityIndex::from_scan`, `DenseEntityIndex::try_from_columns`.
- What: three builders for the same `id → span` map, each with its own capacity heuristic (`len/50` twice, a 40 M cap once), each in a different crate. The native compact builder sorts rows and dedups last-wins; the wasm path inserts into a hashmap then sorts.
- Why it matters: the wasm OOM guard (`PREPASS_INDEX_RESERVE_CAP`, "reserving len/50 … aborts with a bare `unreachable executed`") does not exist on the native `IndexBuilder::Hash` branch or the parallel stitch, which still reserve `len/50` unconditionally.
- Fix: one `ifc_lite_core::IndexBuilder` (paged rows → Dense/Columnar/Hash by size, with the reserve cap) used by `processor/entity_index.rs`, `parallel_scan/native.rs::stitch` and both wasm pre-passes.
- Effort: M

### PROCESSING-20: Test fixture loaders and `MeshProductionContext` fixture blocks are copy-pasted across integration tests
- Category: DRY (tests)
- Severity: Medium
- Confidence: CONFIRMED
- Where: `read_fixture()` with the identical `NotFound → eprintln!("run pnpm fixtures") → None` body in `rust/processing/tests/geometry_volume_gate.rs:36-48`, `geometry_hash_world_aabb.rs:31-43`, `issue_845_wall_elemented_case.rs:23-35`, `beam_winding_consistency.rs:22-34`, `georef_map_conversion_math.rs:37`, `issue_4206_structural_{edge_curve,surface_member,curve_member}_geometry.rs:16/13/35`, `issue_5389_annotation_symbolic_items.rs:50-60`, `issue_1910_bootstrap_regression.rs:48`; `fixture(name)` variants in `analytic_swept_disk.rs:9`, `swept_disk_checks.rs:12`, `instancing_real_geometry.rs:20`, `mesh_id_provenance.rs:168`; `fixture_path` in `native_geometry_diagnostics.rs:14` and `issue_5582_specular_material.rs:23`. The six-line `let void_index = FxHashMap::default(); … MeshProductionContext { … }` block is repeated at `src/element_tests.rs:46-70` and `:470-492` (jscpd) and again in `tests/geometry_closure_after_cleanup.rs:144-159`, `source_vertex_weld.rs:45-77`, `geometry_data_export_test.rs:171-185`, `instancing_batch_local.rs:121-136`. jscpd reports 42 intra-processing clones; 36 are in tests, including `geometry_closure_after_cleanup ↔ geometry_volume_gate ↔ geometry_hash_world_aabb` (3 × 16-32 lines), `instancing_dont_bake ↔ instancing_multi_item` (37 lines), `appearance/tests.rs ↔ tests/issue_1781_image_textures.rs` (38 lines), `site_rotation ↔ issue_4706` (35 lines), and cross-crate `export/tests/issue_4118_site_rotation_instancing.rs ↔ tests/site_local_instancing.rs` (73 lines).
- What: `tests/common/mod.rs` exists and already hosts `quick_metadata` and `wall_frame_seams` helpers, so the home is there; the loaders simply were never moved.
- Why it matters: the skip-vs-panic policy for a missing fixture is spelled 10 times (and `issue_1910_bootstrap_regression.rs:48` returns `Vec<u8>` and panics, i.e. it already drifted); `MeshProductionContext::empty()` would delete ~150 lines.
- Fix: `tests/common/fixtures.rs` (`fn read_or_skip(path) -> Option<Vec<u8>>`, `fn geometry_fixture(name)`), a `#[cfg(test)] impl MeshProductionContext<'static> { fn empty() }` or a `tests/common/mesh.rs` builder; share the 73-line site-rotation fixture with `rust/export` via a workspace `test-fixtures` crate.
- Effort: S

### PROCESSING-21: Three identical `EntityJob` literals, two identical placement closures, two identical fallback-summary literals, and `if x { Vec::new() } else { Vec::new() }` ×3
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/processing/src/processor/mod.rs:740-752`, `:768-780`, `:850-862` (`EntityJob { … product_definition_shape_id: None, element_color: default_color_for_type(..), global_id: None, … }`); `:1079-1092` (`site_transform`/`building_transform` closures); `:726-738` and `processor/quick_metadata.rs:286-297` (`QuickMetadataEntitySummary { kind: "element", has_children: false, … }` placeholder); `:566-589` (three `if quick_metadata_enabled { Vec::new() } else { Vec::new() }`).
- Fix: `EntityJob::new(id, ifc_type, span)`, `fn resolve_placement_matrix(pos) -> Option<Vec<f64>>`, `QuickMetadataEntitySummary::placeholder(id, type_name)`, and plain `Vec::new()`.
- Effort: S

### PROCESSING-22: `scan_shard` family exposes five tuple-returning functions that differ only by how many diagnostics they return
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/processing/src/parallel_scan.rs:86-97` (`scan_shard` → 2-tuple), `:106-113` (`_with_refusals` → 3-tuple), `:152-176` (`_with_diagnostics` → 4-tuple), `rust/processing/src/shard_classes.rs:370-378` (`scan_shard_classified` → 3-tuple), `:398-428` (`_with_refusals` → 4-tuple); each doc comment justifies the next function with "adding a return value in place would be a breaking change (published crate)".
- What: the shard primitive is one loop; the API has grown a function per added field. The native stitch already wraps the result in a named `ChunkScan` struct (`parallel_scan/native.rs:57-66`) — the public API should be that struct.
- Fix: `pub struct ShardScan { records, classes: Option<Vec<u8>>, handoff, refusals, malformed_starts }` with `#[non_exhaustive]`; keep the five functions as `#[deprecated]` shims for one release.
- Effort: S

### PROCESSING-23: `/metadata`'s `geometry_count` disagrees with `ModelMetadata.geometry_entity_count`
- Category: Quirk (parity)
- Severity: Low
- Confidence: CONFIRMED
- Where: `apps/server/src/routes/parse/json.rs:240-247` (`has_geometry_by_name(type_name)` only) vs `rust/processing/src/processor/mod.rs:718-781, 839-864` (adds the #1910 representationless-spatial exception and the #957 synthetic type jobs, subtracts the opening-filter skips).
- Fix: expose `ifc_lite_processing::count_geometry_jobs(content)` (the `ScanObserver` of PROCESSING-1 in count mode) and use it from the route.
- Effort: S

### PROCESSING-24: `georeferencing::extract_georeferencing_with_index` still performs a full `EntityScanner` walk despite holding an index
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/processing/src/georeferencing.rs:92-106` (walks the file to collect candidates), vs `:141-152` (`extract_georeferencing_from_candidates`, which the pipeline uses to avoid exactly that walk). Callers of the index-taking variant: `rust/export` (`model.rs`, `quantity_analysis.rs`) after they already ran `build_entity_index_parallel`.
- Fix: an `EntityIndex` cannot yield type names, so either have `build_entity_index_parallel` return the georef candidate list alongside the index (the shard scan sees every keyword), or accept that this variant is "index for decoding, scan for discovery" and rename it so callers stop assuming it is scan-free.
- Effort: S

### PROCESSING-25: Non-deterministic tie order in the CSG summary breakdown (log only)
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/processing/src/processor/mod.rs:1527-1545` (`by_reason: HashMap<&str, usize>` → `sort_by(count)` only), whereas `rust/geometry/src/router/diagnostics.rs:276` sorts `(count desc, reason asc)` for the same data in `GeometryDiagnostics`.
- What: equal-count reasons appear in `HashMap` order in the `tracing::warn!` breakdown string; the structured diagnostics are already deterministic.
- Fix: reuse `aggregate_diagnostics`'s sorted `by_reason` for the warning text (it is computed four lines later at `:1558`).
- Effort: S

### PROCESSING-26: `scan_segmentation` / `scan_proposals` options and report types are hand-mirrored into the wasm API; vector types differ per module
- Category: DRY
- Severity: Low
- Confidence: LIKELY (surface read only; the scan sub-review did not run)
- Where: `rust/processing/src/scan_segmentation/options.rs` (286 lines of option fields + validation), `scan_proposals/options.rs` (164), `rust/wasm-bindings/src/api/scan_segmentation.rs`, `api/scan_proposals.rs`, `api/scan_registration.rs`; `scan_segmentation/*` uses a `Vec3` alias with `normals::unit -> Option`, `scan_proposals/frame.rs:12-30` a `V3` alias with its own `unit` (PROCESSING-12).
- What: two option structs with overlapping fields (voxel size, min support, tolerances: `prism.rs:39-40 STEP_TOLERANCE=0.15 / MIN_STEP_TOLERANCE=0.0349`, `scan_proposals/frame.rs:39 ORTHONORMAL_TOLERANCE=1e-6`) and their JS-facing twins. Determinism looks sound (`voxel.rs:166` sorts keys, `refit.rs:104/126` sorts pairs/members, `scan_proposals/mod.rs:90` sorts drafts) and PCA is centralised in `point_pca.rs`.
- Fix: derive the wasm option/report bindings with `serde-wasm-bindgen` from the processing structs instead of field-by-field; move the three tolerances into one `scan_segmentation::tolerances` module.
- Effort: M

### PROCESSING-27: Server `MeshData` wrapper and `symbolic_response.rs` are the only consumer-side type mirrors; FFI/python are clean
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: `apps/server/src/types/mesh.rs:26-86` (`MeshData { #[serde(flatten)] mesh, metallic, roughness }` + `Deref` + test-only builder mirrors at `:90-118`), `apps/server/src/types/response.rs` (re-exports processing types — good), `rust/ffi/src/lib.rs:37,113` (uses `ParseResponse` directly), `rust/python/src/lib.rs:83` (uses `process_geometry_filtered_with_quality_and_ids` directly).
- What: the wrapper is a documented semver workaround (#5582/#5984) and is acceptable; the `#[cfg(test)]` builder mirrors (`with_origin/with_instance/with_geometry_class/with_style_metadata`) are the cost. If PROCESSING-16 lands (`finishes` on `ProcessingResult`), the pipeline could stamp `SpecularMaterial` onto `MeshData` behind a `#[serde(default, skip_serializing_if)]` optional field in the next semver major, retiring the wrapper.
- Effort: S (after PROCESSING-16)

### PROCESSING-28: `_tests.rs` siblings declared from `lib.rs` to stay under a frozen ratchet budget
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/processing/src/lib.rs:28-37` (`determinism_tests`), `:49-54` (`simplify_session_tests`), `processor/mod.rs:27-29` (`csg_summary_tests` declared from `mod.rs` "so the test-revert oracle does not delete it with the code"); `tests/module_size_allowlist.txt` is 461 lines, most of them a changelog of "+8 / -35 / 606 -> 557" deltas.
- What: the ratchet is doing its job (the processing rows are 5), but the workaround pattern — declare a module's tests from its parent so the module's own line count does not move — hides test ownership and means `grep "mod tests" determinism.rs` finds nothing. The allowlist's running commentary belongs in git history.
- Fix: after PROCESSING-8 splits `processor/mod.rs`, `determinism.rs` (499) and `prepass.rs` (781) can be split along their natural seams (`determinism::{manifest, diff}`, `prepass::{spans, resolve, wire, units}`) and the sibling-from-parent declarations go away; trim the allowlist to rows.
- Effort: S

## Sub-area findings: symbolic/ + pdf_vector/ (delegated sub-review)

Numbering `PROCESSING-SYM-n` is kept because the findings cross-reference each other. Summary from that review: the 2D symbolic path is a third, drifted re-implementation of IFC geometry primitives that `rust/geometry` already owns and documents as single homes (`IfcCartesianTransformationOperator`, `IfcAxis2Placement2D/3D` + `IfcLocalPlacement` chain, `IfcTrimmedCurve`/`IfcCircle`/`IfcEllipse`/`IfcIndexedPolyCurve` evaluation, 25 inline `IfcCartesianPoint`/`IfcDirection` reads); every one has drifted (depth caps, trim defaults, segment counts, scale sign, arc segments ignored). CONFIRMED precision bug: the whole symbolic pipeline is `f32` from the first coordinate read and the RTC/site rebase subtracts in `f32`, so at 5,000 km georeferenced coordinates overlay symbols land up to ~0.5 m from meshes whose pipeline subtracts in f64. `pdf_vector/` hand-rolls the DrawOPS cursor 8 times with two arity tables, computes the affine's largest singular value twice (drifted), applies a `[f64;6]` affine in 3 places, folds an AABB 3 ways. 18 test files embed the same STEP prologue.

### PROCESSING-SYM-1: `IfcCartesianTransformationOperator` parsed a second time in symbolic, drifted from geometry's declared single home
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: rust/processing/src/symbolic/operator.rs:33-153 (full re-implementation); rust/geometry/src/router/transforms/operator.rs:33-200 (`parse_transformation_operator`, whose doc at :26-32 says "This is the SINGLE definition of the operator's attribute layout and frame derivation… `profile_extractor` used to carry its own copy, which drifted"); consumer items.rs:88-106.
- What: Same entity, same attribute layout, same Axis1/Axis2 Gram-Schmidt mirror handling, re-derived in f32 into a 7-field `Transform2D`. Drift already present: (a) geometry honours `Scale2` for `…2DnonUniform` (attr 4) and `Scale2/Scale3` for 3D; symbolic ignores them (operator.rs:19-21 calls this "a separate concern"); (b) geometry keeps a negative `Scale` as a reflection ("real exporters do write Scale = -1", geometry :95-97), symbolic takes `raw_scale.abs()` (operator.rs:80-81), so the same `MappingTarget` mirrors the mesh but not its plan symbol — the very class #1994 fixed for Axis2; (c) normalisation thresholds 1e-4 (symbolic :95,127) vs 1e-9/1e-6 (geometry :168-174,193); (d) `coords.to_vec()` clones vs direct reads.
- Why it matters: Two authoritative answers for one `IfcMappedItem` transform; the 3D mesh and the 2D overlay of a non-uniformly scaled or `Scale=-1` library block disagree today. Geometry's doc contract ("single definition") is false.
- Fix: Delete symbolic/operator.rs. Call `ifc_lite_geometry::...::parse_transformation_operator` (make it `pub`), take rows x,y of columns 0,1 plus translation into `Transform2D` (`m00=M[(0,0)], m10=M[(1,0)], m01=M[(0,1)], m11=M[(1,1)], tx..tz=M[(.,3)]`), and let `Transform2D::scale()` keep `sqrt(|det|)`. The projection argument in operator.rs:23-32 (Axis3 cannot matter) holds for the projected matrix too.
- Effort: M

### PROCESSING-SYM-2: `IfcAxis2Placement2D/3D` and the `IfcLocalPlacement` chain re-implemented; depth cap and docs have drifted
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: rust/processing/src/symbolic/transform.rs:133-189 (`resolve_object_placement`, `resolve_placement_for_symbolic`, `depth > 50`), :193-280 (`parse_axis2_placement_2d`); geometry homes: rust/geometry/src/transform/placement_2d.rs:14-46 ("Canonical router-free `IfcAxis2Placement2D` transform"), rust/geometry/src/transform.rs:`build_axis2_matrix`/`parse_axis2_placement_3d_from_id` (:239-285), rust/geometry/src/router/transforms/walk.rs (placement chain), rust/geometry/src/profile_extractor.rs:530 (`depth > MAX_PLACEMENT_DEPTH`); rust/core/src/limits.rs:74 (`MAX_PLACEMENT_DEPTH = 100`).
- What: Symbolic re-derives the 2D rotation block `[dx,-dy;dy,dx]` + location (identical math to placement_2d.rs:37-44), re-walks `PlacementRelTo` recursively, and re-reads `RefDirection`. Drift: depth cap 50 vs the shared `MAX_PLACEMENT_DEPTH = 100` (AGENTS.md: "Reuse the shared bound where the chain is shared: `ifc_lite_core::limits`"); direction threshold 1e-4 vs 1e-9; missing-Location handling (error vs `unresolved()`). The justification for a separate implementation is stale: mod.rs:38-42 says symbolic "uses a 2D translation-plus-rotation accumulation that intentionally diverges from the 3D geometry router", while transform.rs:13-17 states "`compose_transforms` is ordinary affine composition… (An earlier version of this comment claimed translations accumulated unrotated, which never matched the code.)" — i.e. for Z-rotations the XY block of the 3D chain IS what symbolic computes.
- Why it matters: See SYM-16 for the concrete depth-cap failure. Every placement fix (#2256, #2355 unresolved conventions, #4706 frames) must be made twice; the "intentional divergence" doc actively steers maintainers away from the shared path.
- Fix: Resolve the chain once via the geometry router's placement walk (or `parse_axis2_placement_3d_from_id` + `MAX_PLACEMENT_DEPTH`) in f64, then project: `Transform2D::from_matrix_xy(&Matrix4)`. Keep `unresolved()` as the error mapping. Rewrite mod.rs:36-42 to describe projection, not divergence.
- Effort: M

### PROCESSING-SYM-3: Curve evaluation (`IfcTrimmedCurve`, `IfcCircle`, `IfcEllipse`, `IfcIndexedPolyCurve`, `IfcCompositeCurve`) re-implemented in symbolic and drifted from geometry
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: rust/processing/src/symbolic/trimmed_curve.rs:27-238; conic.rs:21-85; items.rs:187-221 (indexed polycurve), :222-263 (circle/ellipse), :277-302 (composite); fill.rs:105-133; geometry homes: rust/geometry/src/trimmed_curve.rs:41-157 (`decode_trimmed_primitive`), rust/geometry/src/curve_source.rs:156-260 (`trim_point`, `circle_basis`, `trim_angle`), rust/geometry/src/profiles/curves_2d.rs:21-530 (`extract_trim_select`, `process_trimmed_conic`, `process_circle_curve`, `process_ellipse_curve`, `process_polyline`, `process_indexed_polycurve` incl. `IfcArcIndex`).
- What: `resolve_trim`/`cartesian_trim_angle` (trimmed_curve.rs:180-238) is `curve_source::trim_angle` rewritten in f32; `Conic::read`/`conic_basis` is `circle_basis`. Drift: (a) unresolved trims default to `(0, TAU)` (:82-83) where geometry `RequireBoth` returns `None`; (b) only an `IfcCircle` basis is accepted (:40-42) — a trimmed `IfcLine` (every DWG-import line) is silently dropped, geometry handles it; (c) `IfcIndexedPolyCurve.Segments` is never read (items.rs:188-205, fill.rs:106-119) so `IfcArcIndex` arcs become two chords and non-sequential `IfcLineIndex` is ignored — geometry :322-434 handles both; (d) sense/master parsing accepts `"TRUE"`, `".T."` and `trim_matches('.')` (:57,:77) although the tokenizer already strips dots (rust/core/src/parser/tokenizer_tests.rs:34: `.TRUE.` → `Enum("TRUE")`), geometry compares `== "T"`/`== Some("CARTESIAN")` — the extra branches are dead, the semantics differ for a `.TRUE.` token; (e) segment policy: 64 fixed (ellipse), 32/64 by `semi_a < 0.05` (fill ring), `arc_len*r/0.1` clamped 8..64 (arc) vs geometry's quality-driven `circle_profile_segments(36)` / `profile_arc_segments` + 0.5 mm sagitta cap; (f) f32 throughout.
- Why it matters: A plan view and the Body/Axis mesh of the same curve disagree; three bug classes (b, c) are silent content loss on common exporter output. #2356 was fixed only on the symbolic copy.
- Fix: Evaluate curves once in geometry (`decode_trimmed_primitive` with `TrimRecovery::BasisDefaults`, `process_indexed_polycurve`, conic sampling) returning f64 points in the curve's plane; symbolic only projects, rebases and casts. Put the plan-view segment policy next to geometry's `TessellationQuality`.
- Effort: L

### PROCESSING-SYM-4: f32 pipeline quantises georeferenced coordinates BEFORE the RTC/site rebase — overlay misaligned by up to 0.5 m at 5,000 km
- Category: Bug
- Severity: High
- Confidence: CONFIRMED (by code path; no test covers > 12 km)
- Where: rust/processing/src/symbolic/mod.rs:190 (`unit_scale as f32`); items.rs:158-160,196-198; transform.rs:220-223 (`raw_x as f32 * unit_scale`); operator.rs:64-67; fill.rs:97-98,113-114; grid.rs:161-162; rebase.rs:73-75 (`x: x as f32`), :118 (`ifc_x - self.x` in f32); contrast rust/wasm-bindings/src/api/grid_lines.rs:176-201 (`to_render_frame` subtracts in f64 then casts, and its comment states the two "can differ by an ulp") and rust/processing/tests/mapped_operator_precision.rs:80 (mesh side pinned at 5,000 km).
- What: Every coordinate and every placement translation is cast to f32 at read time; the rebase then subtracts an f32 offset from an f32 world coordinate. f32 has a 24-bit mantissa: at 5,000,000 m the ulp is 0.5 m, at 12,000,000 m (symbolic_rtc_frame.rs `LOW`, but that test is in mm so only 12 km) it is 1 m.
- Why it matters: Scenario: a Swiss LV95 / UTM model with `IfcSite` at E=2,600,000.3 m. Mesh path: f64 world − f64 offset → 0.3 exactly. Symbolic: `2_600_000.3 as f32` = 2,600,000.25 (ulp 0.25), offset `as f32` = 2,600,000.25 → 0.0 instead of 0.3; neighbouring points round to different ulps, so a 20 cm wall symbol can be drawn 25 cm off its mesh. That is the bug class AGENTS.md warns about ("models past 1 km from origin get f32 jitter") re-introduced on the overlay. `symbolic_rtc_frame.rs:189-196` asserts `< 0.01` only at 12 km, where the ulp is 1 mm, so it cannot see this.
- Fix: Carry f64 through `Transform2D`, `Conic`, `RenderFrameRebase` (store the frame's f64 offset) and cast to f32 only in `push_finite_point`/the primitive constructors. Add a 5,000 km case to symbolic_rtc_frame.rs mirroring mapped_operator_precision.rs.
- Effort: M

### PROCESSING-SYM-5: Eight hand-rolled DrawOPS cursor walkers and two arity tables in pdf_vector
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: rust/processing/src/pdf_vector/mod.rs:158-186 (`validate_path`, arity table :163-167); extent.rs:15-22 (second arity table), :25-44 (`path_points`), :46-56 (`opcodes`); dashes.rs:16-30 (`supported`), :79-102 (`has_capped_loop` subpath loop), :255-301 (`expand` subpath loop); strokes.rs:328-362 (`rings` subpath loop); fill_paths.rs:59-119 (`rings` subpath loop).
- What: Every function re-parses `[op, args…]` with its own `cursor += 3` / `cursor += 1 + arity` arithmetic. The "split into straight subpaths with `just_closed` + `truncate(1)`" state machine appears four times (dashes.rs:79-102, :255-301, strokes.rs:328-362, fill_paths.rs:59-119) and has already drifted: `has_capped_loop` has no `just_closed` guard, so `close; close` emits a degenerate second qualification, while the other three suppress it.
- Why it matters: A new opcode (e.g. `re` as a native command) or a change in close semantics must be applied in eight places; the `just_closed` drift shows it already was not.
- Fix: One `pdf_vector/path.rs` with `const fn arity(op) -> usize`, `fn commands(&[f64]) -> impl Iterator<Item = Cmd>` (typed enum `Move/Line/Cubic/Quad/Close`) and `fn subpaths(&[f64], close_last) -> impl Iterator<Item = Subpath { points, closed }>`. `validate_path` becomes the only place that reads raw floats.
- Effort: M

### PROCESSING-SYM-6: `IfcCartesianPoint` / `IfcDirection` reads inlined 25 times with three different malformed-data policies
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: coordinate reads (`.as_float()).unwrap_or(0.0) as f32`): items.rs:158-160,196-198; transform.rs:220-222,245-247; operator.rs:64-66,92-93,119-120; fill.rs:97-98,113-114,152,165; trimmed_curve.rs:226-227; conic.rs:56; grid.rs:161-162 (uses `?` instead); direction normalisation ×3: transform.rs:240-257, operator.rs:84-104, :111-142. Geometry homes: rust/geometry/src/transform.rs:134-224 (`parse_cartesian_point`, `parse_decoded_cartesian_point`, `parse_cartesian_point_from_id` with `decoder.get_cartesian_point_fast`), :286-306 (`parse_direction`).
- What: The same three-line read is copied everywhere, with `.map(|l| l.to_vec()).unwrap_or_default()` clones at transform.rs:218,243 and operator.rs:61,89,116. Policy drift inside symbolic: items/fill/transform substitute `0.0` for a non-numeric coordinate (so `(1.0, 'x')` silently becomes `(1.0, 0.0)`), grid.rs:160-162 drops the whole axis, conic.rs:62-64 refuses. None uses the decoder's fast path.
- Why it matters: Silent coordinate fabrication is the #2256 failure class in a different coat; the geometry crate already has the reader and the fast path.
- Fix: Add `DecodedEntity::cartesian_coords(&self) -> Option<[f64;3]>` / `direction_ratios()` in `ifc_lite_core` (or make geometry's `parse_decoded_cartesian_point`/`parse_direction` the home) and one `unit_direction_2d(ratios) -> Option<(f64,f64)>` helper; pick one malformed-data policy (refuse, matching `Conic::read`).
- Effort: M

### PROCESSING-SYM-7: Polyline / indexed-polycurve point emission written five times inside symbolic
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/processing/src/symbolic/items.rs:145-186 vs :187-221 (jscpd 166-184 <-> 203-221); fill.rs:86-104 and :105-120 (`extract_curve_ring`); fill.rs:144-168 (`sample_curve_world_y`, a third reader of the same two entities just to fetch Z); grid.rs:142-168 (`sample_grid_axis_endpoints`).
- What: Same resolve-list → read-xy(z) → `transform_point` → `rebase.plan` → `push_finite_point` loop. Drift: items.rs derives `world_y` from `first_z + transform.tz`, grid.rs uses `transform.tz` only (ignores the axis points' Z), fill.rs re-decodes the outer curve a second time to find Z; closed-loop detection (`(points[0]-points[n-2]).abs() < 0.001`, items.rs:171-173 and :208-210) exists only in items.rs, so a fill ring and a plan polyline of the same `IfcPolyline` disagree on closure.
- Why it matters: `push_finite_point` was introduced precisely because "fill.rs pushed unguarded coordinates while items.rs did not" (transform.rs:26-30) — the remaining five loops are the same drift waiting to recur.
- Fix: One `fn polyline_points(curve, decoder, unit_scale) -> Option<(Vec<[f64;2]>, first_z)>` covering `IfcPolyline`/`IfcIndexedPolyCurve` (after SYM-3, delegate to geometry), with `fn project_ring(points, transform, rebase) -> Vec<f32>` and `fn is_closed(&[f32])`.
- Effort: S

### PROCESSING-SYM-8: Conic tessellation duplicated inside symbolic with two different closure and segment conventions
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/processing/src/symbolic/items.rs:241-263 (ellipse: `0..=64`, 65 points, duplicated end point AND `closed: true`); fill.rs:121-133 (circle/ellipse ring: `0..segments`, 32 if `semi_a < 0.05` else 64, no duplicate); trimmed_curve.rs:143-153 (arc: `(arc_len*r/0.1).max(8).min(64)`).
- What: Three sampling loops over `Conic::point_at`, three segment policies, two closure conventions.
- Why it matters: A consumer that treats `closed: true` as "last point == first point" gets a zero-length segment on ellipses but not on polylines; the 0.05 m small-circle rule exists in one path only.
- Fix: `Conic::sample(&self, start, end, segments) -> impl Iterator<Item=(f64,f64)>` plus one named segment policy (`fn plan_segments(radius, sweep) -> usize`) in conic.rs.
- Effort: S

### PROCESSING-SYM-9: Largest singular value of the affine computed twice, drifted
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/processing/src/pdf_vector/interpret.rs:135-141 (`largest_scale`, floors at `f64::MIN_POSITIVE`); strokes.rs:39-47 (inline `max_scale`, multiplies by `(1 + 16ε)`, no floor).
- What: Same `sqrt((trace + sqrt(trace² − 4det²))/2)` formula; one has a roundoff inflation the other lacks, one has a zero guard the other lacks.
- Why it matters: A clip-tolerance decision and a stroke-arc tolerance decision about the same calibration matrix use two different numbers.
- Fix: `pub(super) fn largest_scale(m: &[f64;6]) -> f64` in extent.rs (or the affine type of SYM-10); callers apply their own ε policy explicitly.
- Effort: S

### PROCESSING-SYM-10: Four 2D affine representations in `processing`; `[f64;6]` apply/multiply duplicated inside pdf_vector
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: pdf_vector: extent.rs:9-14 (`apply`), fill_paths.rs:12-21 (`point`, same apply + finite/1e8 check), strokes_tests.rs:20 (`transformed`), mod.rs:148-157 (`multiply`), mod.rs:138-147 (`validate_matrix`); symbolic/transform.rs:51-130 (`Transform2D` 7×f32, `compose_transforms`, `transform_point`); rust/processing/src/mesh_frame.rs:174-180 (column-major `[f64;16]` by hand); rust/wasm-bindings/src/api/grid_lines.rs:183-186 (same 4×4 by hand); geometry uses `nalgebra::Matrix4`.
- What: `Transform2D` is `[f64;6]` in a different field order and precision; `compose_transforms` is `multiply`; `transform_point` is `apply`. Consumers (`Drawing2DCanvas`, wasm `symbolic_from_data.rs:40-116`) re-transcribe the primitives field by field because the wire types share no type with the wasm wrappers.
- Why it matters: Each representation has its own composition order convention (`a*b` = apply b first) and its own identity/validity test (mod.rs:315-323 hand-rolls `is_identity` with 1 mm / 1e-4 tolerances; `validate_matrix` tests `det == 0`), so correctness arguments cannot be shared.
- Fix: One `Affine2 { m: [f64;6] }` in `ifc_lite_geometry` (or core) with `compose`, `apply`, `apply_vec`, `det`, `uniform_scale`, `largest_singular_value`, `is_identity(eps)`, `from_matrix4_xy`; `Transform2D` becomes `Affine2 + tz`.
- Effort: M

### PROCESSING-SYM-11: AABB fold written three ways in pdf_vector
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/processing/src/pdf_vector/extent.rs:57-66 (`bbox`), extent.rs:98-104 (inline min/max in `rectangle_path`), curve_hulls.rs:53-63 (`bounds` closure in `strictly_separated`); cross-crate: rust/geometry/src/geom_bounds.rs:82 (`world_aabb`), rust/processing/src/appearance/evaluated_precision.rs:10 (`local_cast_bounds`).
- What: Same `[min x, min y, max x, max y]` fold; `rectangle_path` and `strictly_separated` ignore the existing `extent::bbox` in the same module tree.
- Fix: Use `extent::bbox` in both; expose `Rect::union/intersects` on a small `Rect` newtype.
- Effort: S

### PROCESSING-SYM-12: Dash phase normalisation, odd-pattern doubling, closed-ring stripping and signed area each duplicated
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/processing/src/pdf_vector/dashes.rs:42-52 vs :142-152 (phase → `(index, offset)` walk); :42-45 vs :250-253 (odd pattern doubled); closed-ring `first == last` strip: strokes.rs:178-182, dashes.rs:61-65, dashes.rs:134-138; signed area: strokes.rs:109-111 (inline in `emit`) vs :165-169 (`signed_area`); perimeter loop dashes.rs:66-71 vs segment-length loop :159-160.
- What: `has_capped_loop` receives the raw `pattern` and doubles it itself, `expand` doubles before calling `subpath` — two entry points to the same normalisation with the invariant ("effective pattern is even") enforced in two places.
- Fix: `struct DashPattern { effective: Vec<f64>, cycle }` with `fn start(&self, phase) -> (usize, f64)`; `fn strip_closing_point(&[Point]) -> &[Point]`; use `signed_area` in `emit`.
- Effort: S

### PROCESSING-SYM-13: Work-budget charging has two helpers and three ad-hoc `checked_mul` chains
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/processing/src/pdf_vector/flatten.rs:8-13 (`charge`), fills.rs:19-29 (`Budget::charge`, identical `checked_sub` with a different message), fills.rs:35-36, :109-110, stroke_topology.rs:26-31 (`n.checked_mul(n).and_then(|x| x.checked_mul(k)).ok_or(...)`), curve_hulls.rs:15,:158 and fill_paths.rs:154 (`.pow(2) * k` — unchecked, can overflow to a tiny charge with `overflow-checks` off in release).
- What: Two budget APIs over one `u64` and inconsistent overflow handling: `(total as u64).pow(2) * 4` (fill_paths.rs:154) wraps for `total > 2^31` — unreachable under the 4096-command cap today, but the sibling sites bother to check, so the contract is unclear.
- Fix: One `Budget` type (`charge(units)`, `charge_quadratic(n, k)` using saturating arithmetic) in flatten.rs, used by all five modules.
- Effort: S

### PROCESSING-SYM-14: The `IfcMappedItem → IfcRepresentationMap → Items` walk is the fifth copy in `processing`, each with its own guard and depth constant
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/processing/src/symbolic/items.rs:65-144 + item_walk.rs:34 (`MAX_ITEM_DEPTH = 32`, "Kept in step with `MAX_MAPPED_ITEM_DEPTH`", pinned by items_cycle_tests.rs:556 instead of imported); rust/processing/src/analytic_export/walk.rs:258-275 + analytic_export/mapped.rs (`MappedSourceCache`, own `MAX_ITEM_DEPTH`); rust/processing/src/processor/opening_filter.rs:203-210; rust/processing/src/processor/color_layer.rs:107-233; rust/geometry/src/router/mapped_item.rs:30-102 and router/transforms/mapped.rs:61-90 (`compose_mapped_transform`, `t * o`); rust/core/src/limits.rs:31-39 (`MAX_MAPPED_ITEM_DEPTH`, whose doc already lists symbolic as a walker that "also walks this").
- What: Each copy re-resolves `MappingSource`, `MappingOrigin`, `MappingTarget`, `MappedRepresentation.Items` with its own unresolved/dangling policy and its own cycle guard. Symbolic's compose order `transform * (target * origin)` matches geometry's `t * o`, but only by inspection. (See also PROCESSING-6 for the colour/layer/opening-filter walks.)
- Why it matters: AGENTS.md "Bounding walks" section exists because #2866 found seven such sites; five remain in one crate. `MAX_ITEM_DEPTH` is a literal `32` guarded by a test rather than `use ifc_lite_core::MAX_MAPPED_ITEM_DEPTH`.
- Fix: A single `ifc_lite_geometry::mapped::resolve(item, decoder) -> Result<MappedResolution { items, transform: Matrix4, representation_id }>` (analytic_export's `MappedResolution` is already that shape) used by all five; symbolic imports the limit.
- Effort: M

### PROCESSING-SYM-15: `IfcIndexedPolyCurve.Segments` ignored — arcs drawn as chords, index lists ignored
- Category: Bug
- Severity: Medium
- Confidence: LIKELY
- Where: rust/processing/src/symbolic/items.rs:187-221; fill.rs:105-120; contrast rust/geometry/src/profiles/curves_2d.rs:322-434.
- What: Only attribute 0 (`Points`) is read; attribute 1 (`Segments: LIST OF IfcSegmentIndexSelect`) is never consulted.
- Why it matters: `IFCINDEXEDPOLYCURVE(#pts,(IFCARCINDEX((1,2,3)),IFCLINEINDEX((3,4))),$)` — standard Revit/ArchiCAD 2D output — renders the arc as two straight chords through its mid-point, and a `Segments` list that reuses or re-orders points (e.g. `(1,2),(4,3)`) is drawn in storage order. The 3D path draws it correctly, so plan and mesh disagree on the same entity.
- Fix: Covered by SYM-3 (delegate to `process_indexed_polycurve`); otherwise port the `IfcArcIndex` 3-point arc sampler.
- Effort: M (S after SYM-3)

### PROCESSING-SYM-16: Placement-chain cap of 50 vs shared `MAX_PLACEMENT_DEPTH = 100` silently relocates deep products to the origin
- Category: Bug
- Severity: Medium
- Confidence: LIKELY
- Where: rust/processing/src/symbolic/transform.rs:158 (`depth > 50` → `unresolved()`); rust/core/src/limits.rs:74; rust/geometry/src/profile_extractor.rs:530 and router/transforms/walk.rs:23 (100).
- What: A chain of 51-100 `IfcLocalPlacement`s resolves in 3D but returns `Transform2D::unresolved()` here, which keeps `tx = ty = 0` (finite) and `tz = NaN`.
- Why it matters: The product's meshes render in place; its plan symbols are drawn at the model origin with `world_y = null`, with no `truncated` diagnostic (this is not an output-cap event). Deep placement nesting is real in federated/IFC4.3 alignment models.
- Fix: `use ifc_lite_core::MAX_PLACEMENT_DEPTH` (or SYM-2's shared walk).
- Effort: S

### PROCESSING-SYM-17: Unresolvable trims fabricate an arc; trimmed `IfcLine` silently dropped
- Category: Bug
- Severity: Medium
- Confidence: LIKELY
- Where: rust/processing/src/symbolic/trimmed_curve.rs:40-42 (`!= IfcCircle → return`), :82-83 (`raw_trim1.unwrap_or(0.0)`, `raw_trim2.unwrap_or(TAU)`), :221-223 (`decode_by_id(point_id).ok()?` swallows a dangling trim point).
- What: If `Trim1` is a dangling `IfcCartesianPoint` ref, `resolve_trim` yields `None` and the arc starts at angle 0; if both dangle a full circle is emitted. Geometry's `RequireBoth` returns `None`. Trimmed lines (`IfcTrimmedCurve` over `IfcLine`, the common DWG/DXF import shape) are never emitted and nothing records the drop.
- Why it matters: Fabricated full circles on broken exports and vanished line work on good ones; the only symptom is a drawing that looks wrong.
- Fix: Return early when either trim fails to resolve; add the `IfcLine` basis (two-point polyline) — both come for free from `decode_trimmed_primitive` (SYM-3).
- Effort: S

### PROCESSING-SYM-18: Style index performs two extra full-file scans per extraction
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/processing/src/symbolic/color.rs:16-25 (scan 1: `IFCPRESENTATIONSTYLEASSIGNMENT`), :29-48 (scan 2: `IFCSTYLEDITEM`); plus mod.rs:184 (`build_entity_index`), :189 (`GeometryRouter::with_units` → `scan_unit_scale`), :195 (`for_overlay` → `detect_rtc_offset_for_file` → `scan_placement_bounds`), :205 (main scan) — at least six linear passes over the bytes for one `extract_symbolic_data` call.
- What: The wrapper map is only needed to unwrap `IfcPresentationStyleAssignment` refs; that can be done lazily at lookup time (`decode_by_id(ref)` and check its type), collapsing both passes into the main scan (collect styled items as they are met) or one.
- Why it matters: On the server this runs on every upload (`services/streaming.rs:216`) in addition to the geometry pipeline's own scans; on a 300 MB IFC each pass is tens of ms of pure byte scanning.
- Fix: Single pass collecting `styled: HashMap<item, Vec<raw_ref>>`; unwrap assignment wrappers in `resolve_color_via_styles` (cached decode). Consider sharing the `EntityScanner` loop with `scan_unit_scale`.
- Effort: S

### PROCESSING-SYM-19: Allocation per placement resolution and per point list
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/processing/src/symbolic/transform.rs:215-219, :240-244; operator.rs:59-63, :87-91, :114-118 (`.map(|l| l.to_vec()).unwrap_or_default()` — clones the attribute list to read 2-3 floats); items.rs:147, fill.rs:88, grid.rs:152 (`resolve_ref_list` decodes/clones every `IfcCartesianPoint` entity, bypassing `decoder.get_cartesian_point_fast`); items.rs:177,181 etc. (`ifc_type.to_string()`, `rep_identifier.to_string()` — two `String`s per primitive, up to 2 M primitives).
- What: The hot loop allocates 3-4 times per point entity and 2 per emitted primitive.
- Fix: Borrow the list (`let coords = loc.get(0).and_then(|a| a.as_list())?`); use `get_cartesian_point_fast` for point refs; for the wire strings consider an interned `ifc_type` index (the JSON shape can stay via a custom `Serialize`).
- Effort: S

### PROCESSING-SYM-20: Twelve-parameter signatures threaded through seven functions under `#[allow(clippy::too_many_arguments)]`
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/processing/src/symbolic/items.rs:27-41; item_walk.rs:151-164, :176-190; trimmed_curve.rs:26-37; text.rs:18-30; fill.rs:19-32; grid.rs:22-31.
- What: `(decoder, express_id, ifc_type, rep_identifier, unit_scale, transform, rebase, styled_items, out, depth, walk, direct_item_id)` is copied verbatim into every signature and every recursive call (items.rs:47-60, :128-141, :283-296 are 13-line argument lists).
- Why it matters: Adding one piece of context (e.g. the f64 frame from SYM-4) is a 7-signature, ~15-call-site edit; the blanket allows hide it from clippy.
- Fix: `struct Extraction<'a> { decoder, unit_scale, rebase, styled_items, out }` and `struct ItemFrame<'a> { express_id, ifc_type, rep_identifier, transform, depth }`; the recursion passes two references.
- Effort: M

### PROCESSING-SYM-21: Magic tolerances and segment counts with no named home
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where: symbolic: items.rs:172-173,209-210 (`0.001` closure), :244 (`64`); mod.rs:315-322 (`0.001`, `0.0001` identity test); transform.rs:158 (`50`), :249,251 (`0.0001`); operator.rs:95,127 (`0.0001`), :130 (`1e-6`); trimmed_curve.rs:106 (`0.0001`), :114 (`0.02` sagitta), :144 (`0.1` chord, `8`, `64`); fill.rs:123 (`0.05`, `32`, `64`); grid.rs:86 (`1e-4`); text.rs:49-50 (`0.7`, `0.18`), :56 (`1e-6`); default colours text.rs:109 (`[0.05;3]`), fill.rs:54, grid.rs:118,133. pdf_vector: mod.rs:96,101,105,114,181 (`1e9`, `75000`, `1e-9..1`), :140 (`1e12`); interpret_ops.rs:67 (`1e12`); fill_paths.rs:17 (`1e8`); flatten.rs:43 (`1e8`), :53 (`128ε`), :64 (`1024`), :73 (`32`); strokes.rs:46 (`16ε`), :60 (`256ε`), :70,:101 (`1024`), :206 (`1e-8`); dashes.rs:72,185 (`32ε`); extent.rs:131 (`1e-9`); fills.rs:63,67,69,88,137,145 (`128`, `16`, `4_000_000`, `4096`, `64/2048`, `256`); interpret.rs:20-22, interpret_ops.rs:11-12.
- What: ~45 numeric policy knobs, three of them (`0.0001` direction length, `0.001` coincidence, `64` segments) repeated in 2-4 places each with no shared constant.
- Fix: `symbolic/policy.rs` and `pdf_vector/limits.rs` with named, documented constants; geometry's `TessellationQuality` for segment counts.
- Effort: S

### PROCESSING-SYM-22: Ratchet-dodge file splits with stale justifications
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/processing/src/symbolic/output_cap_validate.rs (42 lines for a 3-line `all_finite`; header: "that file sits at its 400-line ratchet ceiling, and four new guards push it over"); output_cap_types.rs:7-10 (same claim) — but output_cap.rs is 340 lines; transform.rs:7-9 (`#[path = "operator.rs"] mod operator;` purely to split); interpret.rs:15-18 (`impl Interpreter` spread over three files via `#[path]`); trimmed_curve.rs:5-6 ("split out of `items.rs` to keep that module's dispatch table under the module-size ratchet").
- What: Splits chosen to satisfy the line counter rather than ownership; the stated reason is no longer true for two of them.
- Fix: Fold `all_finite` back into output_cap.rs (it has 60 lines of headroom); keep `output_cap_types.rs` but fix its doc; make operator.rs a normal sibling module; split `Interpreter` by concern (state vs scopes vs paths) rather than by `#[path]`.
- Effort: S

### PROCESSING-SYM-23: Stringly-typed omission kinds, a dead kind label, and `Result<_, String>` throughout pdf_vector
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/processing/src/pdf_vector/interpret.rs:232-275 (`"clip"`, `"transparency"`, `"pattern"`, `"hairline"`, `"dash"`, `"dashVersion"`, `"dashTopology"`, `"curvedStroke"`); interpret_ops.rs:58,78,83,171,204; interpret_path.rs:54; report.rs:17-21 (doc list, missing `dashVersion`/`dashTopology`), :172-191 (`kind_label`, includes `"roundCapJoin"` which no code path produces; rust/processing/src/appearance/pdf_stroke_tests.rs:107 asserts its absence; apps/viewer/src/i18n/catalogues/appearance-panel.en.ts:218,241-242 still carries it); ~90 `Err("…".into())` sites across the module.
- What: Kind vocabulary is maintained in four places (interpreter, report doc, `kind_label`, viewer i18n) with one stale entry; errors are untyped strings so the wasm boundary and tests match on substrings (`contains("32 MiB")`).
- Fix: `enum OmissionKind { … , Unsupported(String) }` with `as_wire_str()` (the same pattern `SymbolicTruncationReason::as_wire_str` already uses at output_cap_types.rs:59-67); delete `roundCapJoin`; `thiserror` enum for pdf_vector errors with `Display` producing today's strings.
- Effort: M

### PROCESSING-SYM-24: Symbolic integration tests embed the same STEP prologue in 18 files; `issue_2356` has six verbatim copies of its own fixture
- Category: DRY (tests)
- Severity: Medium
- Confidence: CONFIRMED
- Where: identical `ISO-10303-21/HEADER/IFCPROJECT/#2 context/#3 units/#4,#5/#6 metre/#40 placement` prologue in rust/processing/tests/issue_843_symbolic_data.rs:11, issue_843_symbolic_parity.rs:21, symbolic_conic_basis.rs:18, symbolic_rtc_frame.rs:129, issue_2356_trimmed_curve_basis.rs:21 (+ inline copies at :163-180, :216-233, :259-276, :296-313, :324-341, :351-368 — jscpd flags 23-40 <-> 163-180), issue_2256_mapped_item_unresolved.rs:36 and issue_2256_text_placement_unresolved.rs:27 (same 14-line prologue, same three-annotation structure), issue_2256_context_wcs_defects.rs, issue_2256_world_y_zero.rs, issue_fill_finiteness.rs:19,46 (jscpd 21-35 <-> 48-62), issue_trimmed_curve_finiteness.rs:18-74 and issue_symbolic_finiteness_followup.rs:24-97 (identical `BOILERPLATE_HEADER` + `fixture()`), issue_4706_symbolic_shares_the_mesh_frame.rs:41-75 (= rust/processing/tests/site_rotation.rs:30-64 = rust/export/tests/issue_4118_site_rotation_instancing.rs:37-68, three crates), issue_5389_annotation_symbolic_items.rs:14, annotation_fills_4406.rs; unit tests: symbolic/items_cycle_tests.rs:106 (`wrap`), :474-487 <-> :520-533; output_cap_tests.rs:112, :118, :302, :461, :590, :625 (six generator functions sharing the same id-allocation/`push_str(format!)` skeleton; jscpd 149-164 <-> 324-339, 165-181 <-> 647-663, 593-609 <-> 630-646); transform_tests.rs.
- What: No shared symbolic fixture builder although `rust/processing/tests/common/mod.rs` exists.
- Why it matters: A schema/unit change to the prologue (e.g. adding `PLANEANGLEUNIT` as issue_2356 had to) is an 18-file edit; the `issue_2356` copies already diverge from its `fixture()` (radius, trims) only in the one line that matters, hiding the intent.
- Fix: `tests/common/symbolic_fixture.rs` with `fn plan_annotation(items: &str, extra: &str) -> String` (+ `with_units`), reused by the unit tests via `#[path]`; one `fn hostile_dag(shape: DagShape)` in output_cap_tests; one `fn site_model(placement)` shared by the three site-rotation tests.
- Effort: M

### PROCESSING-SYM-25: `PdfVectorPage` fixture built three times; report test helpers duplicated
- Category: DRY (tests)
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/processing/src/pdf_vector/tests.rs:5-25 (`page()`); rust/processing/src/appearance/pdf_fill_tests.rs:48-70 (inline struct literal, different view box); rust/wasm-bindings/src/api/pdf_vector.rs:73-85 (JSON literal); helpers `rect`/`fill`/`end_path`/`gstate` in pdf_vector/report_tests.rs:10-44 vs `rectangle` in pdf_fill_tests.rs:10 vs `stroke` in pdf_stroke_tests.rs:5.
- Fix: `pub(crate) mod test_support` in pdf_vector with `page_with(view_box, matrix, ops)` and the op builders.
- Effort: S

### PROCESSING-SYM-26: Verdict serialization failure silently hashed as empty bytes
- Category: Quirk
- Severity: Low
- Confidence: SUSPECT
- Where: rust/processing/src/pdf_vector/report.rs:133 (`serde_json::to_vec(&verdict).unwrap_or_default()`).
- What: The fidelity `sha256` is documented as binding the verdict; on a serialization error it would bind `""` and still be accepted by `plan_pdf_fill_annotation_with_clip` (appearance/pdf_fill.rs:37-41). Not reachable with today's types (f64 NaN serializes as `null`), but the pattern contradicts the "refuses atomically" contract everywhere else in the module.
- Fix: Make `finish` return `Result` and propagate.
- Effort: S

### PROCESSING-SYM-27: Inconsistent error context between fill and stroke composition
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/processing/src/pdf_vector/fills.rs:90-91 (fill `rings(...)?`, no operator context) vs :99-100 (`.map_err(|e| format!("PDF operator {}: {e}", ordinal))` for strokes only); dashes.rs:118 and :307 emit the same "exceeds 1024 visible run pieces" text from two guards.
- Fix: Wrap once around the per-path loop body.
- Effort: S

### PROCESSING-SYM-28: Symbolic placement doc contradicts itself and hand-rolls an identity test that drops sub-millimetre context offsets
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/processing/src/symbolic/mod.rs:38-42 vs transform.rs:11-17 (see SYM-2); mod.rs:315-327 (`context_transform` applied only if `|tx| > 0.001 || … || |m01| > 0.0001 || tz.is_nan()`).
- What: A `WorldCoordinateSystem` with a 0.5 mm offset or a 5e-5 rad rotation is silently treated as identity; a `Transform2D::is_identity(eps)` would make the policy visible and testable. The branch also means an unresolved context (NaN `tz`) is composed in — correct per #2256 but only because of the trailing `|| tz.is_nan()` clause.
- Fix: `if !context_transform.is_identity() { compose }` with the tolerance named in policy.rs; rewrite mod.rs:38-42.
- Effort: S

### PROCESSING-SYM-29: `IfcColourRgb` read duplicated between symbolic text colour and the style crate's fill leaf
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/processing/src/symbolic/color.rs:83-90 (`IfcTextStyleForDefinedFont.Colour → IfcColourRgb` attrs 1-3 → `[r,g,b,1]`) vs rust/processing/src/style/fill.rs:16-22 (same read) vs rust/processing/src/style/surface.rs:17 (`read_colour_rgb`, the `extract_surface_style_colors` leaf). AGENTS.md names `ifc_lite_processing::style` as the colour home and bans per-pipeline `extract_color_rgb` copies (`styling_parity` only greps for that name).
- Fix: `style::colour_rgb(entity) -> Option<[f32;4]>` used by all three; move `extract_color_from_text_style` next to `extract_color_from_fill_area_style`.
- Effort: S

### PROCESSING-SYM-30: Per-extraction `GeometryRouter` and overlay-frame detection re-run work the caller already did
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/processing/src/symbolic/mod.rs:189-195; callers apps/server/src/services/streaming.rs:216, routes/parse/json.rs:96, parquet.rs:180, parquet_optimized.rs:159 all pass `result.frame` but the router (and its unit scan) is still rebuilt; `decoder.length_unit_scale()` exists (rust/processing/src/analytic_export/walk.rs:78 uses it) so the router is constructed only for `unit_scale`.
- What: The comment at :187-188 documents that the router "meshes nothing", but it still scans for units; the `_in_frame` entry point could take `(frame, unit_scale)` or read `decoder.length_unit_scale()`.
- Fix: Use `decoder.length_unit_scale()`; build the router only on the `None`-frame (overlay) path.
- Effort: S

## Sub-area findings: appearance/ (delegated sub-review)

Numbering `PROCESSING-APP-n` kept for cross-references. Headline from that review (61 files, ~6.4k non-test + ~4.4k test lines): no HashMap-order leaks into outputs (FxHashMap/HashSet are lookup-only; all iterated maps are BTree), no untrusted PNG decode here (decode lives in geometry), but the module carries four copies of the STEP wire converter (one of which panics on `*`), two copies of the rigid-placement inversion, five scattered copies of the geometry/budget caps, and a large block of copy-pasted test scaffolding.

### PROCESSING-APP-1: Four `AttributeValue -> wire JSON` converters, one of which has drifted into a panic
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: `rust/processing/src/appearance/authored.rs:62-81` (`wire`), `evaluated.rs:24-32` (`wire`), `page_material.rs:10-28` (`scalar`), `tests.rs:64-77` (`wire`)
- What: all four map `A::EntityRef -> "#id"`, `A::Enum -> ".X."`, `A::List [IFCTYPE, v] -> {"typed":{...}}`. Drift: `authored::wire` handles `A::Derived -> "*"` and the typed marker; `evaluated::wire` has `_ => unreachable!("fixed authored values")` and emits typed lists as plain arrays; `page_material::scalar` re-spells the typed marker with a hard-coded 3-name allowlist; `tests::wire` is a fourth copy with a `starts_with("IFC")` heuristic.
- Why it matters: the wire format is a contract with the host StoreEditor; four spellings guarantee divergence, and the `evaluated` copy is reachable with file data (see APP-2).
- Fix: one `pub(super) fn wire(&A) -> Value` in `authored.rs` (keep `scalar` as a thin validating wrapper over it); `tests.rs` imports it.
- Effort: S

### PROCESSING-APP-2: `evaluated::wire` panics (`unreachable!`) on a file-supplied `*` attribute
- Category: Bug
- Severity: High
- Confidence: LIKELY
- Where: `rust/processing/src/appearance/evaluated.rs:24-32`; callers feeding file attributes: `evaluated_replacement.rs:53` (`body.attributes.to_vec()` of the source `IfcShapeRepresentation`) and `:64` (`layer.attributes.to_vec()`)
- What: `evaluated_replacement::replace` clones the occurrence's Body wrapper when a type `IfcRepresentationMap` shares it; attribute 0 (`ContextOfItems`) is copied verbatim from the file into `authored(...)`, which runs every attribute through `evaluated::wire`. `ifc_lite_core` decodes `*` as `AttributeValue::Derived` (`core/src/schema_gen.rs:111`), which hits `unreachable!`. `evaluated_source::body` only checks attrs 1 (`get_string(1)=="Body"`) and 2/3; attr 0 is never type-checked.
- Why it matters: an IFC4 file with `#43=IFCSHAPEREPRESENTATION(*,'Body','SweptSolid',(#44));` where `#43` is also referenced by an `IfcRepresentationMap`, planned with `representationPolicy: evaluatedOccurrence` -> panic; under `release` (`panic='abort'`) the wasm instance dies instead of returning an exclusion.
- Fix: collapse into `authored::wire` (APP-1) which already maps `Derived -> "*"`; additionally validate attr 0 is an `EntityRef` in `evaluated_source::body`.
- Effort: S

### PROCESSING-APP-3: Rigid placement inversion implemented twice, with drift
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/processing/src/appearance/authored.rs:213-235` and `evaluated_source.rs:95-108`; forward 4x4 application also hand-rolled at `mapping.rs:264-273` while `transfer_math.rs:58-63` does the same with nalgebra
- What: both sites do `columns = from_fn(|i| from_fn(|j| transform[i*4+j]))`, check `|dot(c_i,c_j) - δ| <= 1e-10`, then `inverse = columns.map(|c| dot(c, v))` and `/ scale`. `authored.rs:224` additionally requires right-handedness (`dot(cross(c0,c1),c2) >= 0.999999`) and finiteness of the matrix; `evaluated_source.rs` accepts a mirrored placement. Whether that drift is deliberate is undocumented.
- Fix: `pub(super) struct RigidFrame { columns, translation, scale }` with `try_from(&[f64;16], scale, require_right_handed: bool)`, `apply`, `invert` in `transfer_math.rs` (already the declared math home, `mod.rs:38`).
- Effort: S

### PROCESSING-APP-4: `dot` / `cross` / `sub` / `length` / `unit` re-declared six ways inside appearance (and more across the workspace)
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where (in-area): `dot`: `mapping.rs:31`, `authored.rs:18`, `calibration.rs:36`, `transfer_math.rs:11`, closure `page_atlas.rs:31`, closure `evaluated_source.rs:98`. `cross`: `authored.rs:21`, `transfer_math.rs:14`, inline `mapping.rs:193-197`, inline `captured.rs:23`, inline `calibration.rs:83-87`. `sub`: `mapping.rs:34`, `transfer_math.rs:8`, closure `page_atlas.rs:30`. `length/unit`: `calibration.rs:39,47`, inline normalise `transfer_points.rs:92-96`, `transfer_math.rs:27-39`.
- Where (cross-crate, for the lead): `export/src/geom.rs:231`, `export/src/openings.rs:18-19`, `export/src/adjacency.rs:24`, `geometry/src/clash_contact_axes.rs:52-81`, `geometry/src/kernel/arrangement/classify.rs:17-20`, `geometry/src/router/voids/prism_cut.rs:222-250`, `processing/src/pdf_vector/strokes.rs:17-26` (2-D), `processing/src/scan_proposals/frame.rs:22-26`, `processing/src/scan_segmentation/normals.rs:16`, plus 8 test files. (Same finding as PROCESSING-12 from the orchestrator side.)
- What: `transfer_math` is already re-exported as the shared home (`scan_segmentation/normals.rs:14`, `scan_proposals/frame.rs:9`), yet five sibling modules in the same directory don't use it. No behavioural drift found (all are the textbook formulas), but the `normal()` degeneracy threshold (`transfer_math.rs:32`, relative `1e-10`) and `captured.rs:24` (`<= 1e-24` absolute), `mapping.rs:198` (`<= 1e-24` absolute) differ.
- Fix: import `transfer_math::{dot, cross, sub, Point}` everywhere in appearance; add `length`, `unit`, `triangle_normal` there; workspace-wide, promote to `ifc_lite_geometry::math`.
- Effort: S (in-area), M (workspace)

### PROCESSING-APP-5: Budget/cap literals spread across three "budget" modules and nine other files, with one drifted value
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `500_000` UV cap: `budget.rs:20`, `texture_budget.rs:23`, `atlas_plan.rs:52`, `evaluated_mask.rs:21`. `1_500_000` corners: `budget.rs:19`, `texture_budget.rs:27`. `10_000` products/items: `budget.rs:21`, `mod.rs:113,127`, `page.rs:31`, `catalog.rs:50`, `evaluated.rs:66`, `transfer.rs:46`, (source images) `transfer.rs:69`, `atlas_plan.rs:26`. `200_000` entities: `source.rs:46`, `authored.rs:153`, `evaluated.rs:144`. `128 MiB`: `source.rs:29`, `texture_budget.rs:53`, `transfer.rs:47-48`, `atlas_plan.rs:26`, `wasm-bindings/src/api/pdf_vector.rs:43`. `16 Mpx`: `page_atlas.rs:8` (`16_777_216`), `page_raster.rs:20`, `calibration.rs:65` (`16*1024*1024`). `8192` axis: `page_raster.rs:20`, `calibration.rs:64`. `source_revision` cap: `4096` at `catalog.rs:50`, `authored.rs:112`, `evaluated.rs:66` but **256** at `transfer.rs:68` and **uncapped** in `mod.rs::plan_with_source` (cloned straight into the plan).
- What: `budget.rs` (plan geometry), `texture_budget.rs` (source preflight) and `transfer_budget.rs` (work/memory) are three unrelated shapes; the first two duplicate each other's constants by literal. The string "Appearance scope must contain 1..10000 products" is spelled three times.
- Fix: named `pub(super) const` table in `budget.rs` (`MAX_PRODUCTS`, `MAX_UVS`, `MAX_CORNERS`, `MAX_ENTITIES`, `MAX_INPUT_BYTES`, `MAX_RASTER_AXIS`, `MAX_RASTER_PIXELS`, `MAX_LABEL_BYTES`), one `validate_scope(schema, product_ids, source_revision)`; `texture_budget::preflight` consumes those consts.
- Effort: S

### PROCESSING-APP-6: Canonical `MeshData` validity predicate copied four times; one consumer skips it and indexes raw
- Category: DRY (+ latent Bug)
- Severity: Medium
- Confidence: CONFIRMED (DRY) / SUSPECT (panic)
- Where: `rust/processing/src/appearance/evaluated.rs:114-119`, `evaluated_openings.rs:94-102`, `pdf_fill.rs:201-203`, `annotation.rs:64-66`, partial in `canonical.rs:70-76`; unchecked indexing `transfer_target.rs:45-48` (`mesh.positions[index*3+axis]` with `index` from `mesh.indices`)
- What: `canonical.rs:104-112` documents that corner indices "must be validated before multiplying, including on wasm32", and `corner_position` exists for exactly that; `transfer_target::prepare` ignores it. If `produce_element_meshes` ever emits an out-of-range index (the reason the guard exists elsewhere), the transfer path panics instead of refusing.
- Fix: `canonical::validate_mesh(&MeshData) -> Result<(), String>` (finite positions/normals/color/origin, `%3`, index range, optional UV length) used by all five; `transfer_target` uses `corner_position`.
- Effort: S

### PROCESSING-APP-7: Reserved-wire-token guard re-implemented with different semantics
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED (drift)
- Where: `rust/processing/src/appearance/wire_text.rs:10-24` (home, exact-token match after ECMAScript trim), `evaluated_replacement.rs:24-25` (`!label.trim().starts_with(['#','.','$','*'])`), `tests.rs:84-88` (copy of the predicate inside `step`)
- What: the layer-label check rejects any label *starting* with those characters, so `"#not_a_ref"` and `"* label"` — which `annotation_tests.rs:139` asserts are legal and preserved — make an otherwise convertible occurrence fail with "Layer label cannot be preserved". Rust `trim()` vs the ECMAScript whitespace set also differs at U+0085 (the exact case `wire_text.rs:8-9` calls out).
- Fix: `wire_text::validate(label, "Layer label")?` at `evaluated_replacement.rs:24`; expose a `is_reserved_token(&str) -> bool` for the test.
- Effort: S

### PROCESSING-APP-8: Authoring helpers and the textured-style entity chain exist twice
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/processing/src/appearance/evaluated.rs:22` `list` ≡ `authored.rs:15` `refs`; `evaluated.rs:33-37` `authored()` ≡ `authored.rs:91-100` `Author::add`; the ImageTexture→ColourRgb→Shading→WithTextures→SurfaceStyle→StyledItem chain at `mod.rs:210-296` (serde_json `Value`s) and `annotation.rs:36-45` (`A` values; drift: style Name `"Image appearance"` vs `"Registered image"`); `IfcCartesianPointList3D`+`IfcTriangulatedFaceSet` authoring at `annotation.rs:30-35` and `evaluated.rs:54-62,150-153`; IFC4X3-only slot logic at `annotation.rs:31`, `evaluated.rs:152` (TagList) and `annotation.rs:50-51`, `pdf_fill.rs:158-160` (PredefinedType).
- Why it matters: schema-layout knowledge (which slot is IFC4X3-only) is the kind of thing that must change in one place when IFC4X3_ADD3 or IFC5 lands.
- Fix: route `mod.rs::plan_with_source` through `Author` + `wire` (APP-1); add `authored::{point_list, face_set, textured_surface_style, annotation_attributes}` builders that take `schema: &str`.
- Effort: M

### PROCESSING-APP-9: Scope/schema/watermark/capacity gates re-spelled per entry point
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: schema gate `"IFC4"|"IFC4X3"`: `rust/processing/src/appearance/mod.rs:124`, `catalog.rs:47`, `evaluated.rs:65`, `transfer.rs:67`, `authored.rs:111`. Stale-watermark (`next_express_id <= max_id`): `mod.rs:140-147`, `authored.rs:154`, `evaluated.rs:73-75`. Capacity (`next + needed >= u32::MAX`): `mod.rs:201-209`, `atlas_plan.rs:47-50`, `evaluated.rs:144-146`, `authored.rs:155-158` — four different error strings for the same condition.
- Fix: `Source::check_watermark(next)`, `AppearancePlan::reserve_capacity(n)`; fold into APP-5's `validate_scope`.
- Effort: S

### PROCESSING-APP-10: Test scaffolding copy-paste (beyond the jscpd hits)
- Category: DRY (tests)
- Severity: Medium
- Confidence: CONFIRMED
- Where (all under `rust/processing/src/appearance/`):
  - PNG decode helper ×5: `page_tests.rs:22-26`, `transfer_tests.rs:164-168`, `transfer_tests.rs:422-428`, `transfer_acceptance_tests.rs:167-172`, `transfer_points_tests.rs:106-108`
  - `struct Baked {plan,wall,width,height,pixels}` + `new/expect`: `transfer_acceptance_tests.rs:136-205` vs `transfer_points_tests.rs:87-120` (jscpd 157-179↔101-111 is a subset)
  - Registration fixture (same 4 fit + 4 held-out points, `"a"/"b".repeat(64)`): `transfer_tests.rs:25-56` vs `transfer_acceptance_tests.rs:61-87`
  - 1-px page + 2×2 wood raster bytes and `AppearanceSourceRaster` spec: `page_tests.rs:9-18` vs `transfer_tests.rs:58-61,83-91`
  - Storey-injected `CONTROLLED_IFC` + GUIDs `0aaa…/0bbb…`, container 40: `annotation_tests.rs:7-10`, `captured_tests.rs:7-10`, `pdf_fill_tests.rs:14,37-41`
  - `issue_4441_authored_metadata_refuses_wire_tokens_and_preserves_ordinary_names`: `annotation_tests.rs:133-148` ≡ `captured_tests.rs:131-146` (only the planner call differs)
  - `CONTROLLED_IFC` (`tests.rs:7-44`) ≡ `rust/processing/tests/issue_1781_image_textures.rs:23-60` (jscpd)
  - 2-D barycentric formula: `page_tests.rs:31-37` is a copy of `page_atlas.rs:106-109`; manual UV interpolation `page_tests.rs:40`, `transfer_tests.rs:117-125` instead of `page_atlas::interpolate`
  - `pdf_stroke_tests.rs:163-176` ↔ `193-206` (jscpd)
- Fix: a `test_support.rs` under appearance with `decode_png`, `with_storey()`, `registration_fixture()`, `wood_rasters()`, generic `Baked`; ship the 1781 fixture as `tests/fixtures/issue_1781_image_texture.ifc` and `include_str!` it from both.
- Effort: M

### PROCESSING-APP-11: `valid_guid` duplicates the export crate's GlobalId check
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/processing/src/appearance/authored.rs:49-56` vs `rust/export/src/rooted_type.rs:87-91` (`is_global_id_shaped`); drift: appearance additionally requires first byte `'0'..='3'` (correct per the 128-bit→22-char packing), export does not.
- Fix: `ifc_lite_core::guid::is_valid_global_id` (core already owns `decode_ifc_string`/limits); both crates import.
- Effort: S

### PROCESSING-APP-12: Page/transfer pipeline repeats preflight, texture index and canonical meshing (5 mesh productions per product)
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/processing/src/appearance/atlas_plan.rs:41-43` calls `plan_with_source` (which runs `texture_budget::preflight` at `mod.rs:138`, `build_texture_index` at `mod.rs:139`, and `align_source_corners` = 2× `produce` per product at `canonical.rs:23,48`), then again runs `preflight` (`atlas_plan.rs:42`), `build_texture_index` (`:43`), one more `produce` (`:62`) and `align_source_corners` (`:109`, 2 more). Evaluated policy adds `produce_evaluated` + up to 2 `produce` (`evaluated.rs:107,182,188`).
- Why it matters: `produce_element_meshes` on CSG/mapped bodies is the dominant cost; the page/transfer planners pay it 5–8×. `texture_budget::preflight` decodes every map/list/texture entity each time.
- Fix: have `plan_with_source` return (or accept) `textures` and the `before` meshes; `align_source_corners` takes an optional precomputed `before`.
- Effort: M

### PROCESSING-APP-13: Five full-file scans per plan and two SHA-256 passes over the source
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/processing/src/appearance/source.rs:43-90` (scan+decode all), `context.rs:18-31` (scan for IFCPROJECT/IFCSITE — same loop shape as `processor/mod.rs:712`), `context.rs:33` (`MaterialLayerIndex::from_content`), `page_source.rs:12-15` (scan into `PrepassSpans`), `build_texture_index`; `transfer.rs:86` and `transfer.rs:204-205` hash `bytes` twice; `pdf_fill.rs:253`.
- Fix: collect the project/site hint and prepass spans in the `Source::new` scan; hash once and reuse.
- Effort: S

### PROCESSING-APP-14: `mapping::map_item` decodes the ExistingUv map/list entities twice
- Category: Perf/DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/processing/src/appearance/mapping.rs:103-109` (for `uv_count`) and `:121-135` (same `texture_maps.get`, `maps.len()!=1`, `entity(map)`, `entity(list)` sequence with duplicated error strings)
- Fix: resolve `(map, list)` once before `budget.reserve`.
- Effort: S

### PROCESSING-APP-15: World-corner reconstruction `f64::from(p) + origin + rtc` hand-rolled in 6 production and 7 test sites
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/processing/src/appearance/pdf_fill.rs:235`, `annotation.rs:78`, `captured.rs:49`, `transfer_target.rs:48`, `evaluated_source.rs:105`, `evaluated_precision.rs:34-35`; tests `annotation_tests.rs:36`, `pdf_fill_tests.rs:97,191,293`, `evaluated_tests.rs:32`, `page_tests.rs:29` (omits rtc), `transfer_tests.rs:111-113` (omits rtc)
- Fix: `MeshData::world_corner(vertex: usize, rtc: [f64;3]) -> [f64;3]` next to `vertex_count` in `types/mesh.rs:310`.
- Effort: S

### PROCESSING-APP-16: Length-unit-scale validity check repeated (and cross-crate)
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/processing/src/appearance/mapping.rs:249`, `canonical.rs:158`, `authored.rs:205`, `evaluated_source.rs:99`, `evaluated_precision.rs:11`; cross-crate `processing/src/analytic_export/transform.rs:24`, `geometry/src/analytic/helpers.rs:112`, `geometry/src/analytic/mod.rs:208`, `export/src/step_map_transform.rs:103`
- Fix: `EntityDecoder::checked_length_unit_scale() -> Result<f64, _>` in core.
- Effort: S

### PROCESSING-APP-17: Shared request metadata hand-copied into `authored::Metadata`; `captured` fakes a frame to reuse the planner
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: `AnnotationPlaneRequest` (`rust/processing/src/appearance/annotation_types.rs:19-31`), `CapturedMeshRequest` (`captured_types.rs:22-39`), `PdfFillAnnotationRequest` (`pdf_fill_types.rs:12-35`) share 7 identical fields; `Metadata` built by hand at `annotation.rs:21-23` and `pdf_fill.rs:46-55`; `captured.rs:35-38` constructs a dummy `AnnotationPlaneFrame { origin: positions[0], axis_u:[1,0,0], … size:[1,1] }` purely to satisfy `plan_textured_product`; `transfer.rs:120-135` likewise fakes an `AppearanceRequest` with `image_uri: "textures/prepared-transfer.png"`.
- Fix: `#[serde(flatten)] pub struct AuthoredMetadata` in the three requests; `plan_textured_product(bytes, &AuthoredMetadata, geometry: Captured|Plane, image, repeat)`.
- Effort: M

### PROCESSING-APP-18: `Source::context` is `Option` only for two-phase init; six `ok_or` sites with four different messages
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/processing/src/appearance/source.rs:16,91`; `canonical.rs:166`, `authored.rs:208-211`, `evaluated.rs:211`, `evaluated_source.rs:92`, `evaluated_openings.rs:29`, `transfer_target.rs:27-30`; `rtc_offset().into()` repeated at `authored.rs:212`, `evaluated.rs:212`, `evaluated_source.rs:103`, `transfer_target.rs:31`
- Fix: build `Context` before constructing `Source` (it only needs `bytes` + a decoder) and store it non-optional; add `Source::rtc_offset()`.
- Effort: S

### PROCESSING-APP-19: Stringly-typed errors everywhere
- Category: Best-practice
- Severity: Medium
- Confidence: CONFIRMED
- Where: every public fn in `rust/processing/src/appearance/mod.rs:109`, `page.rs:29`, `transfer.rs:19,28`, `pdf_fill.rs:21,30`, `annotation.rs:72`, `captured.rs:32`, `calibration.rs:59`, `catalog.rs:46`, `registration.rs:144` returns `Result<_, String>`; ~250 distinct literals; tests pin on substrings (`.contains("budget")`, `transfer_points_index.rs:171`); no error type is defined in the module.
- Why it matters: hosts cannot distinguish "stale revision / re-plan" from "budget / shrink scope" from "unsupported / exclude" without string matching; wasm wrappers just forward `JsError::new(&msg)`.
- Fix: `#[derive(Serialize)] pub struct AppearanceError { kind: AppearanceErrorKind, message: String }` (`Budget`, `Stale`, `Unsupported`, `Invalid`, `Internal`) with `From<&str>` shims so the migration is incremental.
- Effort: M

### PROCESSING-APP-20: Over-fragmented module layout
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: 61 files under `rust/processing/src/appearance/`; 20 under 60 lines (`page_source.rs` 17, `wire_text.rs` 24, `budget.rs` 29, `transfer_budget.rs` 31, `page.rs` 42, `annotation_types.rs` 44, `captured_types.rs` 49, `context.rs` 49, `page_types.rs` 53, `texture_budget.rs` 57, `page_raster.rs` 58, `evaluated_allocation.rs` 59…); `*_types.rs` splits where impl+types stay under 400 (`annotation` 91+44, `captured` 63+49, `registration` 232+91, `page` 42+53+17+58+101); only `transfer` (232+179) and `pdf_fill` (283+68+143) actually need a split; 13 `#[path = "..._tests.rs"]` mounts plus `page_atlas_guards.rs` mounted as `guards`; `refs` names opposite conversions (`source.rs:248` A→ids, `authored.rs:15` ids→A). No appearance file is in `module_size_allowlist.txt`.
- Fix: merge the sub-100-line pairs back (types next to their planner); rename `authored::refs` → `ref_list`; keep `*_tests.rs` as `mod tests;` siblings only where the parent would exceed 400.
- Effort: M

### PROCESSING-APP-21: `boundaries[0]` on a `FillShape` with zero rings
- Category: Bug
- Severity: Low
- Confidence: SUSPECT
- Where: `rust/processing/src/appearance/pdf_fill.rs:96` (`A::EntityRef(boundaries[0])`); producer `pdf_vector/fills.rs:136-144` only bounds `rings.len() > 64`, never `is_empty()`
- What: `pdf_fill.rs:90` defends against an empty *ring* but not an empty *ring list*. Whether `context.contours(...).shape(i)` can yield zero rings depends on the contour extractor; if it can, this is an index panic on a hostile display list.
- Fix: `let outer = *boundaries.first().ok_or("PDF fill has no outer boundary")?;` (and assert the invariant in `fills.rs`).
- Effort: S

### PROCESSING-APP-22: Textured sliver source triangles make `source_density` refuse the whole plan with a misleading message
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/processing/src/appearance/page_atlas.rs:62-86` (`determinant == 0.` short-circuits, but a near-zero determinant yields a huge Jacobian → `chart()` at `:54` errors "exceeds 4096 pixels … reduce source image resolution or requested density")
- What: a single degenerate-but-nonzero textured triangle in the *source* mesh (common in tessellated CSG output) rejects the product; the message blames the user's density. Refusal-not-silent is consistent with the module's policy, so this is a UX/diagnostic quirk, not a correctness bug.
- Fix: detect `determinant.abs() <= eps * (|x1 y2| + |x2 y1|)` and report "degenerate textured source triangle N" instead.
- Effort: S

## Parity gaps (what no test guards today)

- `tests/styling_parity.rs` is name-based: it greps for `fn get_default_color*` / `extract_color_from_rendering` / `extract_color_rgb`. A semantic copy under another name (`wasm-bindings/src/api/styling/color.rs::find_color_for_geometry`, `symbolic/color.rs:83-90`'s `IfcColourRgb` read) passes it. No test runs the native element-colour resolver and the wasm `resolve_element_color` over one fixture and compares (PROCESSING-3/4).
- Nothing pins `apps/server::detect_schema_version == processing::detect_schema_version` (PROCESSING-5), nor `/metadata.geometry_count == ModelMetadata.geometry_entity_count` (PROCESSING-23).
- `issue_2053_shard_scan_parity.rs` pins `classify_type_name` against `scan_shard`, but nothing pins the native scan loop's arms (`processor/mod.rs:598-827`) against `PrepassSpans::stash`/`classify_type_name` — the IFCMATERIALLAYERSET gate and the PRESENTATIONLAYER/PROPERTY arms are native-only by construction (PROCESSING-1).
- No test compares the native `mapped_item_plan` / `instantiated_type_ids` / `referenced_representation_maps` with the wasm `_from_spans` twins on one file (PROCESSING-2).
- `element_failure_parity.rs` covers "unsupported item does not kill the element" on the native path only; the wasm batch is exercised through `pnpm test:wasm-contract`, which AGENTS.md notes "skips clean if the wasm runtime isn't built".
- Symbolic vs mesh frame is pinned at 12 km in millimetres (`symbolic_rtc_frame.rs`) — below the f32 ulp that PROCESSING-SYM-4 needs (5,000 km case missing); symbolic vs geometry curve evaluation (`IfcTrimmedCurve` trims, `IfcIndexedPolyCurve.Segments`, operator `Scale=-1`) has no cross-check at all (SYM-1/3/15/17).
- The quick-metadata bootstrap's `elevation` unit is unpinned (PROCESSING-18).

## Concept inventory

Cross-cutting helpers defined in `rust/processing` (name — path:line). Sub-area inventories from the symbolic/pdf_vector and appearance reviews are folded in.

**Vector / matrix math**
- `simplify_math::{yup_to_zup, zup_to_yup, conjugate_yup_to_zup, matmul_row_major, transform_point_row_major, invert_affine_row_major, averaged_vertex_normals}` — src/simplify_math.rs:13,20,26,45,60,70,104
- `site_local::{apply_inverse_rotation_in_place, apply_inverse_rotation_point_f64, native_to_baked}` — src/processor/site_local.rs:112,165,70
- `MeshFrame::rotate_into_frame` — src/mesh_frame.rs:759
- `point_pca::symmetric_eigen_ascending` (nalgebra `SymmetricEigen`) — src/point_pca.rs:20
- `scan_proposals::frame::{V3, add, scale, norm, unit}` — src/scan_proposals/frame.rs:12-30; `scan_segmentation::normals::unit` — src/scan_segmentation/normals.rs:16; `extent::{turn, convex_hull, min_area_direction, axes}` — src/scan_segmentation/extent.rs:17-70; `refit::{median, plane_basis}` — src/scan_segmentation/refit.rs:21,135
- `appearance::transfer_math::{Point, sub, dot, cross, interpolate, normal, closest}` — src/appearance/transfer_math.rs:7-95 (declared home); duplicates `appearance/mapping.rs:31-36`, `authored.rs:18-27`, `calibration.rs:36-53`, `page_atlas.rs:29-46`, `captured.rs:21-24`, `evaluated_source.rs:98`
- `pdf_vector::strokes::{add, sub, cross, dot}` (2D) — src/pdf_vector/strokes.rs:14-26; `flatten::{distance, midpoint, bezier<N>}` — src/pdf_vector/flatten.rs:14,25,31; `strokes::signed_area` — strokes.rs:165
- `symbolic::transform::{Transform2D, compose_transforms, transform_point, scale}` (f32) — src/symbolic/transform.rs:51,114,106,102; `rebase::RenderFrameRebase::rotate_plan` — src/symbolic/rebase.rs:99
- `pdf_vector::{multiply, validate_matrix}` ([f64;6]) — src/pdf_vector/mod.rs:148,138; `extent::apply` — src/pdf_vector/extent.rs:9; `fill_paths::point` — src/pdf_vector/fill_paths.rs:12; `interpret::largest_scale` — src/pdf_vector/interpret.rs:135 (inline twin strokes.rs:39-47)
- `analytic_export::transform::{transform_disk, materialize_disk}` (nalgebra `Matrix4`) — src/analytic_export/transform.rs:11,71

**Transforms / placements**
- `MeshFrame::{select, for_overlay, rtc_offset, coordinate_space}` — src/mesh_frame.rs:702,732,739,778; `MeshCoordinateSpace` wire tags — mesh_frame.rs:795
- `site_local::publish_baked_basis`, `convert_mesh_to_site_local` — src/processor/site_local.rs:95,141
- `stream_meta::{resolve_stream_meta, resolve_partial_rtc, resolve_building_rotation}` — src/stream_meta.rs:83,142,189 (rotation via `ifc_lite_geometry::rotation_angle_about_z`)
- `symbolic::transform::{resolve_object_placement, resolve_placement_for_symbolic, parse_axis2_placement_2d}` — src/symbolic/transform.rs:133,152,193; `symbolic::operator::parse_cartesian_transformation_operator` — src/symbolic/operator.rs:33; `conic::conic_basis` — src/symbolic/conic.rs:21; context WCS compose — src/symbolic/mod.rs:293-327
- `analytic_export::placement::{validate_placement_chain, validate_axis2_placement_3d/2d, validate_optional_direction}` — src/analytic_export/placement.rs:11,114,126,137; `analytic_export::mapped::{resolve_mapped_item, MappedSourceCache}` — src/analytic_export/mapped.rs:128,29
- `appearance::mapping::positions_in_frame` — src/appearance/mapping.rs:247; rigid inverse `authored.rs:217-235`, `evaluated_source.rs:95-108`; `transfer_math::{validate_frame, transform}` — transfer_math.rs:40-63; Kabsch `registration.rs:144-228`; similarity `calibration.rs:59-126`; `scan_proposals::frame::Similarity::{from_row_major, direction, point}` — src/scan_proposals/frame.rs:43-78
- `processor::instancing::{finalize_instances, recover_occurrences_flat}` — src/processor/instancing.rs:20,133 (compose via `ifc_lite_geometry::{compose_instance_world_row_major, instance_rel_row_major_f32, bake_source_at_world}`)

**Tolerances / epsilons / limits**
- `PLACEMENT_IDENTITY_EPSILON = 1e-9` — src/mesh_frame.rs:607; `rotation_is_identity`, `translation_is_nonidentity` — mesh_frame.rs:625,651
- `TRANSPARENCY_ALPHA_THRESHOLD = 0.95` — src/style/mod.rs:59; glass alpha `0.65` — src/element/element_color.rs:263; `SATURATION_TINT_THRESHOLD = 0.08` — src/style/surface.rs:169; `MAX_MATERIAL_RESOLVE_DEPTH = 4` — src/style/material.rs:29
- `MAX_QUICK_SPATIAL_TREE_DEPTH = 60` — src/processor/quick_metadata.rs:164; `LARGE_COORD_THRESHOLD_METERS` (core) used at quick_metadata.rs:132
- `PARALLEL_MIN_BYTES = 8 MiB`, `MIN_CHUNK_BYTES = 2 MiB` — src/parallel_scan/native.rs:17,22; `PAGE_ROWS = 4096`, compact threshold 32 MiB, `len/50` — src/processor/entity_index.rs:59,70,78
- `WORST_HOSTS_LIMIT = 16` — src/processor/diagnostics.rs:85; `META`/batch sizes 50 — src/processor/mod.rs:206-207
- scan: `STEP_TOLERANCE = 0.15`, `MIN_STEP_TOLERANCE = 0.0349` — src/scan_segmentation/prism.rs:39-40; `ORTHONORMAL_TOLERANCE = 1e-6` — src/scan_proposals/frame.rs:39; `1e-4` eigen gate — src/scan_segmentation/cylinder_fit.rs:69
- symbolic: `0.001` closure (items.rs:172,209), `0.001/0.0001` identity (mod.rs:315-322), depth `50` (transform.rs:158), `0.0001` direction (transform.rs:249, operator.rs:95,127), `0.02` sagitta / `0.1` chord / `8..64` segments (trimmed_curve.rs:106-144), `0.05/32/64` (fill.rs:123), `MAX_ITEM_DEPTH 32`, `MAX_ITEM_REVISITS 200_000` (item_walk.rs:34,79), `MAX_SYMBOLIC_ELEMENTS 2_000_000`, `MAX_SYMBOLIC_BYTES 256 MiB` (output_cap.rs:38,72)
- pdf_vector: `MAX_OPERATIONS 100_000` (mod.rs:24), `MAX_PATH_NUMBERS 2M`, `MAX_PATHS 20_000`, `MAX_STACK 64` (interpret.rs:20-22), `MAX_DASH_RUNS 1024` (dashes.rs:11), `128ε/32/1024/1e8` (flatten.rs:43-73), `16ε/256ε/1e-8` (strokes.rs:46-206), budget `4_000_000` (fills.rs:69), `MAX_LISTED_OMISSIONS 4096` (report.rs:13)
- appearance: `1e-6` orthonormality (mapping.rs:62), `1e-10` (authored.rs:142,222; evaluated_source.rs:100; registration.rs:12,191; calibration.rs:80,100), `1e-24` degeneracy (mapping.rs:198, captured.rs:24), `1e-16` barycentric (page_atlas.rs:107), `0.999999` (authored.rs:224, transfer_surface.rs:157), `PAD 2.5` (page_atlas.rs:10), `QUANTUM_PER_METRE 1e6` (evaluated_mask.rs:19); caps `500_000/1_500_000/10_000/200_000/128 MiB/16 Mpx/8192/4096|256` — budget.rs:19-21, texture_budget.rs:23-53, source.rs:29,46, page_raster.rs:20, calibration.rs:64-65, catalog.rs:50, transfer.rs:46-69

**Unit conversion**
- `prepass::{UnitScales, resolve_unit_scales, find_ifcproject_id, starts_a_record}` — src/prepass.rs:319,353,407,494 (the sanctioned IFCPROJECT hunt); `EntityDecoder::seed_unit_scales` call sites — processor/mod.rs:1063, jobs.rs:176, stream_meta.rs:101
- `GeometryRouter::with_scale(unit_scale)` — processor/mod.rs:1068, stream_meta.rs:104, symbolic/mod.rs:189
- `symbolic`: `unit_scale as f32` — src/symbolic/mod.rs:190; `plane_angle_to_radians as f32` — trimmed_curve.rs:52
- positivity checks on `length_unit_scale` — appearance/mapping.rs:249, canonical.rs:158, authored.rs:205, evaluated_source.rs:99, evaluated_precision.rs:11, analytic_export/transform.rs:24
- `georeferencing::Georeferencing::{map_unit_scale, from_core}` — src/georeferencing.rs:39-55; `quick_metadata::extract_storey_elevation_from_args` (NOT scaled) — src/processor/quick_metadata.rs:116

**BBox / AABB / extent**
- `ProducedElementMeshes::geometry_aabb` (from `ifc_lite_geometry::GeometryHasher::world_aabb`) — src/element.rs:198; `MeshData::{local_bounds, with_local_bounds}` — src/types/mesh.rs:215
- `pdf_vector::extent::{bbox, union, intersects, rect_corners, quad_contains_rect, rectangle_path}` — src/pdf_vector/extent.rs:57,67,74,77,120,86; inline fold extent.rs:98-104, `curve_hulls.rs:53`
- `scan_segmentation::extent` (min-area rectangle) — src/scan_segmentation/extent.rs:46-70; `VoxelSet::for_each_in_box` — src/scan_segmentation/voxel.rs:196; `scan_proposals::frame::{z_range, span_along}` — src/scan_proposals/frame.rs:100,105
- `appearance::evaluated_precision::local_cast_bounds` — src/appearance/evaluated_precision.rs:10; `PointGrid::build` — src/appearance/transfer_points_index.rs:32

**Hashing / fingerprints**
- `determinism::{fnv1a_bytes, fnv1a_u32s, fnv1a_f32_bits, hex, compute_mesh_manifest, diff_report}` — src/determinism.rs:150,157,163,169,287,373
- Sha256 writers: pdf_vector/mod.rs:44, pdf_vector/report.rs:129, appearance/pdf_fill.rs:254, appearance/page.rs:8, appearance/registration.rs:194, appearance/evaluated_mask.rs:58, appearance/transfer.rs:201 (`Writer(Sha256)` adapter), appearance/atlas_plan.rs:7, analytic_export/definitions.rs:10
- `geometry_export::color_key` (bit-exact colour key), quantised weld key `(i64,i64,i64)` — src/geometry_export.rs:280,296
- `scan_segmentation::voxel::Key` — src/scan_segmentation/voxel.rs:20-33; `InstanceRecord::rep_identity: u128` — src/types/mesh.rs; `fold_u128_to_u32` lives in wasm-bindings (prepass_affinity.rs)

**Triangulation / polygon / curve ops**
- `style::indexed_colour::split_mesh_by_indexed_colour`, `FullIndexedColourMap::{dominant, has_multiple_colours}` — src/style/indexed_colour.rs:127,51,34
- `element_degenerate::clean` (wraps `Mesh::drop_degenerate_triangles`) — src/element_degenerate.rs:72; `geometry_export::weld_positions` — src/geometry_export.rs:287
- `symbolic`: `Conic::point_at` — conic.rs:81; samplers items.rs:246-252, fill.rs:125-131, trimmed_curve.rs:93-153; `resolve_trim`/`cartesian_trim_angle` — trimmed_curve.rs:180,215; `push_finite_point` — transform.rs:32; `output_cap_validate::all_finite` — output_cap_validate.rs:40
- `pdf_vector`: `curve_hulls::{convex, strictly_separated, shared_endpoint_only, shared_chord, qualify}` — curve_hulls.rs:14,52,92,129,157; `fill_paths::{rings, finish, qualify}` — fill_paths.rs:46,22,132; `strokes::{arc, join, outline, emit, rings}` — strokes.rs:29,122,170,94,296; `stroke_topology::{on_segment, touches, qualify}` — stroke_topology.rs:8-24; `dashes::{supported, has_capped_loop, subpath, expand, point_at}` — dashes.rs:16,36,130,243,111; boolean composition via `ifc_lite_geometry::{FixedGridComposition, BooleanOp2D, Ring2D}` — fills.rs:7,114-153
- `scan_segmentation`: `cylinder_fit::{axis_from_normals, fit_circle, refine, sphere_rms, arc_degrees, ransac}` — cylinder_fit.rs:57-230; `normals::{Accumulator::fit, estimate, canonical_sign}` — normals.rs:40-99; `refit::{robust_refit, merge_coplanar, bend}` — refit.rs:31,77,146; `grow`, `ring`, `prism`, `columns` modules
- `appearance`: `page_atlas::{weights, chart, layout, bake, interpolate}` — page_atlas.rs:104,47-166; `transfer_occlusion::inside` — transfer_occlusion.rs:87; `evaluated_mask::partition` — evaluated_mask.rs:85; PCA plane fit `transfer_points.rs:282-306`

**Entity attribute access / decoding**
- `quick_metadata::{parse_step_arguments, parse_step_string, parse_step_ref, parse_step_ref_list, extract_name_from_args, extract_storey_elevation_from_args}` — src/processor/quick_metadata.rs:85,90,101,108,114,116 (raw-byte tokenisers also used by the native scan loop)
- `processor::normalize_optional_string` — src/processor/mod.rs:305; `prepass::normalize_style_name` — src/prepass.rs:761; `properties::{normalize_ifc_property_name, collect_property_set_definition, collect_rel_defines_by_properties_link, attribute_value_to_string, extract_property_name_and_value, resolve_space_zone_properties_lazy}` — src/processor/properties.rs:22,44,65,113,132,~300
- `prepass::{PrepassSpans::stash, resolve_prepass, resolve_styled_item_spans, collect_geometry_style_info, extract_style_info_from_styled_item, surface_style_from_styled_item}` — src/prepass.rs:66,149,287,698,716,726; `prepass_styled::{resolve_styled_items_into, resolve_geometry_finishes}` — src/prepass_styled.rs:27,66; `prepass_type_material::propagate_type_material` — src/prepass_type_material.rs:22
- `shard_classes::{classify_type_name, classify_type_name_with_content, scan_shard_classified*}` — src/shard_classes.rs:463,439,370,398; `parallel_scan::{scan_shard*, build_entity_index_parallel}` — src/parallel_scan.rs:86,106,152,196
- `element_color::{find_geometry_item_style_source, product_shape_style_source, representation_map_style_source, find_indexed_colour_for_element, element_reaches_indexed_colour}` — src/element/element_color.rs:47,146,124,178,208; `color_layer::{collect_presentation_layer_assignments, resolve_presentation_layer_name}` — src/processor/color_layer.rs:10,140; `opening_filter::{scan_item_styles, has_glass_style}` — src/processor/opening_filter.rs:166,239
- `georeferencing::{georeferencing_candidate_type, extract_georeferencing_from_candidates}` — src/georeferencing.rs:119,141 (via `ifc_lite_core::GeoRefExtractor`); `schema_detection::detect_schema_version` — src/processor/schema_detection.rs:22
- `analytic_export::walk::{extract, extract_with_source_cache}` — src/analytic_export/walk.rs:51,65; `mapped::{load_source, validate_target, validate_origin}` — mapped.rs:103,143,161
- `appearance::source::{refs, numbers, Source::{entity, product_items, validate_world_placement, single_parent}}` — src/appearance/source.rs:248-272,94-246; `mapping::{rows, triangles}` — mapping.rs:9-30; `texture_budget::preflight` — texture_budget.rs:11; `catalog` type lookup — catalog.rs:64-98; wire builders `authored::{vector, refs, typed, wire}`, `evaluated::{list, wire, authored}`, `page_material::scalar`
- `symbolic`: coordinate reads (25 sites, SYM-6); `color::build_styled_item_index` — symbolic/color.rs:13; grid/text/trimmed attribute reads — grid.rs:32-42, text.rs:31-68, trimmed_curve.rs:54-80

**Colour / style resolution**
- `style::{default_color_for_type, fixed_display_color_for_type, Rgba::{to_rgba8, from_rgba8, is_transparent}, GeometryStyleInfo::from_color}` — src/style/mod.rs:153,228,116,126,110,88
- `style::material::{build_element_material_colors, flatten_material_color_index, pick_opaque_first, pick_material_style_for_submesh, resolve_submesh_color, build_material_style_index, resolve_material_ids}` — src/style/material.rs:38,73,85,104,138,160,183
- `style::surface::{read_colour_rgb, rendering_colours, extract_surface_style_colors, extract_surface_style_specular, SpecularMaterial}` — src/style/surface.rs:17,45,97,308,140; `style::fill::{extract_color_from_fill_area_style, fill_style_from_styled_item}` — src/style/fill.rs:9,34; `style::finish_join::{MeshFinishJoin, ModelFinishes, join_finish}` — src/style/finish_join.rs:116,159,51
- `prepass::{merge_indexed_colours, flat_styles_rgba8, flat_styles_with_finishes, style_finishes_for_ids, finish_to_wire, finish_from_wire, flat_voids, flat_material_colors, material_colors_from_flat}` — src/prepass.rs:306,519,567,580,593,600,615,637,660; `prepass_styled::flat_styles_rgba8_from_geometry_columns` — src/prepass_styled.rs:97
- `color_layer::resolve_element_color_for_product_definition_shape` — src/processor/color_layer.rs:30; `element_color::{find_geometry_item_color, resolve_color_for_representation_map, infer_opening_subpart_material_name}` — src/element/element_color.rs:30,115,245
- `symbolic::color::{resolve_color_via_styles, extract_color_from_style_ref, extract_color_from_text_style}` — src/symbolic/color.rs:52,66,75; defaults text.rs:109, fill.rs:54, grid.rs:118,133
- `appearance`: `canonical.rs:161-164` (delegates to `resolve_element_color_for_product_definition_shape` + `pick_opaque_first`), `page_material::preserve` — page_material.rs:30, `page_raster::{composite, Raster::sample}` — page_raster.rs:46,28
- `geometry_export::ColorMetadata` palette — src/geometry_export.rs:255

**Error types**
- None defined as enums in the orchestrator: decode failures are `Result<_, ifc_lite_core::Error>` swallowed with `let Ok(..) else { continue }`; `build_quick_spatial_tree_node -> Result<_, String>` — src/processor/quick_metadata.rs:170
- `scan_segmentation`/`scan_proposals`: `Result<_, String>` throughout (mod.rs:76,82,86; options.rs validation)
- `analytic_export`: `Result<_, String>` (placement.rs, mapped.rs) plus the typed `SweptDiskCheckError`/`SweptDiskFindingCode` — src/analytic_export/checks.rs
- `symbolic`: no error type; silent `return`/`continue`, `Transform2D::unresolved()` NaN sentinel, `SymbolicTruncation{reason}` + `SymbolicTruncationReason::as_wire_str` — src/symbolic/output_cap_types.rs:27,59-74; `nan_as_null` serde shim — primitives.rs:40
- `pdf_vector`: `Result<_, String>` everywhere (mod.rs:30,125; interpret.rs:80; flatten.rs:8; fills.rs:44; strokes.rs:296; dashes.rs:243) + `FidelityReport`/`Omission`/`OmissionSummary` non-fatal channel — report.rs:17,30,39
- `appearance`: `Result<_, String>` on every public fn (~250 literals); named strings only `budget::BUDGET_ERROR`, `texture_budget::ERROR`, `evaluated_mask::{STALE, DIRECT_BODY}`
- `simplify_session::SimplifySkip` is the one typed skip-reason enum — src/simplify_session.rs

## Target shape

Opinionated: what the crate boundaries and the single orchestration API should look like once the findings above collapse.

**1. Four crates, each with one job; processing stops being a bag.**
- `ifc-lite-core`: bytes → records. Owns the scanner, `EntityIndex` + **the one `IndexBuilder`** (paged → Dense/Columnar/Hash, with the reserve cap; PROCESSING-19), the decoder, `RecordView` raw-attribute readers (PROCESSING-15), `normalize_step_string`, `limits`, units, georef, `detect_schema_version` (header-scoped + case-insensitive; PROCESSING-5), GUID validation (APP-11).
- `ifc-lite-geometry`: records → meshes/curves, and **all** geometric math: `math::{v2, v3, rm4, Affine2, Rot3}` (PROCESSING-10/11/12, SYM-10, APP-3/4), the one placement/operator/curve evaluator (SYM-1/2/3/6), the one mapped-item resolver (SYM-14), weld + hasher (PROCESSING-13). Nothing above it parses an `IfcCartesianPoint`.
- `ifc-lite-processing` becomes two things and nothing else: (a) the **orchestrator** (`scan → plan → resolve → produce → finalize`), and (b) the **presentation/styling home** (`style`, `prepass` resolution, `symbolic` as a *projection* of geometry's curves, `appearance`, `pdf_vector`). `scan_segmentation`/`scan_proposals`/`analytic_export` are not orchestration; they are leaf feature crates and should move to `rust/features/*` (or stay as feature-gated modules) so the orchestrator's dependency surface is the pipeline only.
- Consumers (`wasm-bindings`, `apps/server`, `ffi`, `python`, `export`) own **transport only**: wire encoding, JS/HTTP/PyO3 bindings, caching. The rule that makes it checkable: a consumer crate may call `ifc_lite_core::EntityScanner` only inside `ifc_lite_processing::scan::*` closures, never in its own `while let Some(..) = scanner.next_entity()` loop. A parity test greps for that loop outside processing the way `styling_parity` greps for colour tables.

**2. One scan observer, one plan, one resolve.**
```text
processing::scan
  ScanClass::classify(type_name, record) -> ScanClass          // PROCESSING-1 (the only keyword table)
  ScanCollector::observe(id, class, span)                      // fills PrepassSpans + jobs + type candidates +
                                                               //   project/site/building + georef candidates + quick-metadata
  impl From<ScanClass> for u8 / TryFrom<u8>                    // the shard wire is a derived encoding
processing::plan
  TypeGeometryPlan::from_spans(..)                             // PROCESSING-2: referenced maps, instantiated types,
                                                               //   instance plan (count, min_id), candidates
processing::prepass
  resolve_prepass(spans, decoder, opts) -> ResolvedPrepass     // unchanged, plus `finishes` (PROCESSING-16)
  element_fallback_color(..)                                   // PROCESSING-4: the one "first opaque" rule
processing::element
  RepresentationWalk::items(entity, decoder, RepFilter)        // PROCESSING-6: the one graph traversal
  produce_element_meshes(..)                                   // unchanged
```
The native scan loop, `PrepassSpans::stash`, `classify_type_name`, both wasm pre-passes, `combined_pre_pass` and `discover_from_columns` are all `ScanCollector` drivers over `ScanClass`; the six keyword tables become one.

**3. One orchestration entry point.**
```rust
#[non_exhaustive]
pub struct ProcessingRequest {            // replaces OpeningFilterMode + StreamingOptions + PassScope + baked_basis
    pub opening_filter: OpeningFilterMode,
    pub quality: TessellationQuality,
    pub batching: Batching { initial, throughput, fast_first_batch },
    pub features: Features { properties, presentation_layers, quick_metadata, instancing, finishes },
    pub frame: FrameRequest,              // Auto | SiteLocal | ModelRtc | RawIfc
    pub entity_ids: Option<Arc<HashSet<u32>>>,
    pub entity_index: Option<Arc<EntityIndex>>,
    pub cancel: Option<Arc<AtomicBool>>,
}
impl ProcessingRequest { pub fn builder() -> .. }

pub trait ProcessingSink {               // default no-op methods
    fn on_frame(&mut self, frame: MeshFrame, baked_basis: [f64; 16]) {}
    fn on_bootstrap(&mut self, b: &QuickMetadataBootstrap) {}
    fn on_batch(&mut self, meshes: &[MeshData], processed: usize, total: usize) {}
    fn on_color_update(&mut self, updates: &[(u32, [f32; 4])]) {}
}

pub fn process(content: &[u8], req: &ProcessingRequest, sink: &mut dyn ProcessingSink) -> ProcessingResult;
pub fn process_geometry(content: &[u8]) -> ProcessingResult { process(content, &Default::default(), &mut ()) }
```
`ProcessingResult` gains `finishes: Arc<ModelFinishes>` (PROCESSING-16) and `type_plan`, so the server, symbolic extraction (`extract_symbolic_data_in(&result)`, SYM-30) and exporters consume the pass's own context instead of re-scanning. The twelve wrappers become `#[deprecated]` one-liners over `process` for one release of the published crate, then go.

**4. The pipeline function becomes five ≤300-line phases with named handoffs.**
`scan(content, req) -> ScanOutput` → `resolve(ScanOutput, decoder) -> ResolvedContext` (unit scales, frame, prepass, type plan, opening filter) → `GeometryPass::run(&ResolvedContext, jobs, sink) -> PassOutput` (the rayon loop; `process_entity_job(job, &PassContext)` with the 20 read-only arguments in one struct, PROCESSING-8) → `finalize(PassOutput) -> ProcessingResult` (instances, diagnostics, georef). The wasm batch is literally `GeometryPass::run` with `Serial` instead of `Rayon` and a `PassContext` built from the wire (PROCESSING-14 disappears because there is one metadata step with two schedulers, not two bodies).

**5. Parity is enforced structurally, not by grep.**
Replace the name-based `styling_parity` gates with behavioural ones: one fixture set run through (a) `process`, (b) the wasm batch path (`produce_batch` is already a plain Rust fn), (c) the server routes, asserting equal `MeshData` colours, `schema_version`, `geometry_entity_count`, element fallback colours and the symbolic frame — and a 5,000 km georeferenced fixture (SYM-4) alongside `mapped_operator_precision.rs`. Keep `module_size_ratchet`, but make `_tests.rs` siblings declarable only from their own module (PROCESSING-28) so the ratchet measures ownership, not line-shuffling.

**6. Error type discipline at the crate boundary.**
One `ifc_lite_processing::Error` (`thiserror`: `Decode`, `Budget`, `Stale`, `Unsupported`, `Invalid`, `Cancelled`) replacing the `Result<_, String>` surfaces of `appearance`, `pdf_vector`, `scan_*`, `analytic_export` (APP-19, SYM-23); `Display` keeps today's strings so wasm/HTTP consumers are unaffected, and hosts branch on the kind.
