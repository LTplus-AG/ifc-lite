### EDGE-1: The browser keeps its own copy of the element-colour / IfcMappedItem colour chase from `processing`
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/styling/color.rs:10-17, 47-108, 134-148, 154-179 · rust/processing/src/element/element_color.rs:29-36, 43-50, 70-114, 161-187 · rust/processing/src/processor/color_layer.rs:29-35, 239-250 · rust/processing/src/appearance/canonical.rs:162-164 · justification comment at rust/processing/src/style/material.rs:124-126
- What: `find_color_for_geometry_at` (62 lines) is the same algorithm as `find_geometry_item_style_source_at`: same depth cap, same depth-keyed visited map, same attribute 0→1→3 walk. `walk_representation_for_direct_color` is the same as `product_shape_style_source`. Processing already takes `has_style: &dyn Fn(u32)->bool` so that "a caller holding the colour map in another shape (the wasm batch's `id -> rgba`) walks exactly the same path" (element_color.rs:40-42). It is `pub(crate)`, so the binding cannot call it and still uses its own copy. The batch even has the `GeometryStyleInfo` index in hand (batch.rs:335). `styling_parity` only checks names (`get_default_color*`, `extract_color_*`), so this clone gets past it. The comment at material.rs:124 ("data layout differs, so that one step stays at the boundary") is out of date now that the predicate form exists. There is also a small difference: the browser's element fallback is the *first* material colour (`flat_styles_rgba8`, prepass.rs:538-541). Native falls back to the type default colour, and appearance falls back to `pick_opaque_first`.
- Why it matters: the #2863/#2864/#2868 cycle and cap fixes had to be made twice. color_cycle_tests.rs (198 lines) and `shared_cap_tests` exist only to keep the copies in step.
- Fix: make `processing::style::resolve_element_color(entity, has_style, colour_of, decoder)` public, built on `product_shape_style_source` plus the element-id fallback. Delete color.rs:10-179 and its cycle tests, and have batch.rs:447-453 call it.
- Effort: S

### EDGE-2: Per-batch orchestration (router arming + per-job loop) lives in the binding and has drifted from native
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/gpu_meshes/batch.rs:143-263 (decoder/router setup), 393-520 (per-job loop), 274-300 (style cache) vs rust/processing/src/processor/jobs.rs:160-245 and rust/processing/src/processor/mod.rs:1063-1105, 1181, 1246-1258
- What: `produce_batch` is 579 lines (71-649). It rebuilds what processing's job runner does: seed unit scales, `with_scale_and_quality`, content-dedup cache, mapped-item cache, output instancing, material-layer index, RTC, then decode → `ifc_type_from_record` → colour → `plan_type_geometry` → `produce_element_meshes` → diagnostics. Two differences:
  - native also arms `enable_shared_brep_signature_cache` (jobs.rs:188); the browser never does;
  - native arms `enable_indexed_colour_split_guard` (jobs.rs:196-197); the browser never does (see EDGE-5).
- Why it matters: AGENTS.md says "a fix applied to only one pipeline silently diverges". `produce_element_meshes` is shared, but the router setup around it is not, and it has already split.
- Fix: add `processing::element::BatchRouterConfig { unit_scale, quality, rtc, skip_small_cuts, dedup, mapped_cache, brep_sig_cache, instancing: Option<(plan, batch_local, indexed_split_ids)>, layer_index }` with `fn build(&self) -> GeometryRouter`, used by both jobs.rs and batch.rs. Also add `processing::element::run_job(id, span, …)` for the decode/type/plan step, leaving the binding to wire decoding and `MeshDataJs` conversion.
- Effort: M

### EDGE-3: Geometry-job discovery is written six times and they disagree
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/styling/prepass.rs:53-92 (`combined_pre_pass`) · rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:347-407 (serial streaming scan) · rust/wasm-bindings/src/api/gpu_meshes/prepass_discovery.rs:78-168 (columns) · rust/processing/src/shard_classes.rs:129-190 (class byte) · rust/processing/src/processor/mod.rs:598-830 (native) · rust/wasm-bindings/src/api/parsing.rs:122-162 (`scanGeometryEntitiesFast`)
- What: each one re-implements "IFCPROJECT / IFCSITE (always a job) / has_geometry / #1910 representationless container with attr 6 present / type candidate / IFCMAPPEDITEM / layer set". The styling/prepass.rs:77-88 comment admits it is "a third geometry-job discovery path". Differences:
  - (a) `scanGeometryEntitiesFast` uses only `has_geometry_by_name`, so it has no #1910 exception and no type geometry.
  - (b) the IFCSITE branch skips `is_disabled` in both browser paths (EDGE-25).
  - (c) native uses `geometry_flags_by_name` (one lookup) while the browser uses separate predicates.
- Why it matters: #1910 had to be fixed three times ("third instance, Greptile-flagged"), and every new rule repeats that.
- Fix: one `processing::prepass::Discovery` visitor (`fn visit(&mut self, id, kw, start, end, content)`) holding jobs, spans, project/site, mapped/type spans and has_layer_set, plus a `from_class(class_byte)` twin next to shard_classes.rs. The three browser loops and native mod.rs feed it. Delete `scanGeometryEntitiesFast` (no TS caller).
- Effort: L

### EDGE-4: Type-geometry sets (referenced RepresentationMaps, instantiated type ids, mapped-instance plan, type candidates) have three implementations, and they treat bare refs differently
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/styling/prepass.rs:139-188, 198-231, 236-272, 282-302, 309-342 · rust/wasm-bindings/src/api/gpu_meshes/batch.rs:461-465 · rust/processing/src/processor/mod.rs:788-826, 836-866 · rust/export/src/model.rs:205-273 + rust/export/src/model_props.rs:145-149
- What: three walks collect `MappingSource` (attr 0), `RelatingType` (attr 5) and `RepresentationMaps` (attr 6), using three different readers:
  - browser: `get(6).and_then(as_list)` (styling/prepass.rs:171-175, 215-219; batch.rs:461-465);
  - export: `ref_list` = `as_list` only;
  - native: `parse_step_ref_list`, which accepts a bare `#n` (quick_metadata.rs:108-113).
  
  So a type whose `RepresentationMaps` is a bare ref is drawn natively but dropped by the browser and the export. `ifc_lite_core` already has a bare-tolerant `get_refs` (schema_gen.rs:336-343, the #4694 fix). The native mapped plan also tracks the minimum id per source, while the browser keeps counts only (styling/prepass.rs:286-301).
- Why it matters: geometry and attribute rows can disagree (the #1518 bug class), and native vs browser output differs on malformed files.
- Fix: one `processing::type_geometry::{TypeGeometrySets, collect_from_spans, collect_from_content}` that uses `get_refs`. Native, export and wasm all consume it. The browser keeps only the wire encoding.
- Effort: M

### EDGE-5: The browser's don't-bake path does not arm the #858 indexed-colour split guard
- Category: Bug
- Severity: High
- Confidence: LIKELY
- Where: rust/wasm-bindings/src/api/gpu_meshes/batch.rs:232-241, 331 vs rust/processing/src/processor/jobs.rs:192-198, rust/processing/src/processor/mod.rs:1246-1256, rust/geometry/src/router/mod.rs:437-445, 455-461
- What: native arms `enable_indexed_colour_split_guard(ids of multi-colour IfcIndexedColourMap sources)` whenever instancing is armed, so those sources are not turned into don't-bake placeholders. Without it, an instance placeholder "would collapse it to one colour" (router doc). `processGeometryBatchPartitioned[FromSource]` is the live worker path (packages/geometry/src/geometry.worker.ts:1182-1196). It arms `enable_output_instancing` + batch-local mode and already has `indexed_colour_full` (batch.rs:331), but never arms the guard. I found no other guard in `produce_element_meshes` (element.rs:268-273 only keeps triangle order).
- Why it matters: repeated mapped face sets with per-triangle palettes (the metering-station / CATIA exports the native comment cites) would render in one colour in the viewer, while server and export keep the palette.
- Fix: when `instance_plan.is_some()`, build the multi-colour id set from `indexed_colour_full` (cache it next to `cached_indexed_colour_maps`) and call `router.enable_indexed_colour_split_guard`. Better, put it in the shared builder from EDGE-2. Add a wasm-contract fixture.
- Effort: S

### EDGE-6: The CSG console logger re-aggregates diagnostics with different rules from the typed aggregate it returns
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/csg_diagnostics.rs:79-87, 121-139, 147-160 vs rust/geometry/src/router/diagnostics.rs:265-276, 281-293, 295-318
- What: about 105 lines recompute by-reason counts, worst hosts and silent no-ops, then call `aggregate_diagnostics` on the same data. Differences:
  - the console's silent no-op count has no `csg_failure_count == 0` filter, so it disagrees with the returned `silent_no_ops`;
  - the console shows the top 10, the typed result 16 (`WORST_HOSTS_LIMIT`);
  - the console sorts by count only, over `std::collections::HashMap` with a random seed, so tie order varies from run to run; the typed path breaks ties by id.
- Why it matters: the console and `getPipelineDiagnostics` give users two different numbers for the same batch.
- Fix: build `GeometryDiagnostics` first, then format the console lines from it (`fn log_diagnostics(&GeometryDiagnostics)`). Keep host-type rollups as a `GeometryDiagnostics` field if they are needed.
- Effort: S

### EDGE-7: The IfcIndexedColourMap full-palette collection loop is duplicated
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/mod.rs:951-985 vs rust/processing/src/prepass.rs:183-196
- What: both do scan/span → decode → `resolve_indexed_colour_map_full` → `entry(geometry_id).or_insert(full)`. The doc at mod.rs:930 points to "processor.rs ~905", which is stale.
- Why it matters: a change to precedence (first-wins) or to the keyword gate has to be made twice.
- Fix: `processing::prepass::collect_indexed_colour_full(content: &[u8], decoder) -> FxHashMap<u32, FullIndexedColourMap>` (with the memmem bail-out), shared with `resolve_prepass`.
- Effort: S

### EDGE-8: Unit-scale resolution has four implementations
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/alignment_lines.rs:77-88 · rust/wasm-bindings/src/api/grid_lines.rs:55-56 · apps/server/src/services/data_model/mod.rs:152-162 · canonical rust/processing/src/prepass.rs:353 (`resolve_unit_scales`) / rust/processing/src/stream_meta.rs:96-101
- What: alignment walks the scanner to the first IFCPROJECT and does `extract_length_unit_scale(..).ok()`, falling back to 1.0. Its comment says "resolved the same way the mesh pipeline does", which it doesn't. Grid uses `GeometryRouter::with_units`. The server data model uses `extract_length_unit_scale(..).unwrap_or(1.0)`. The mesh pipeline uses `resolve_unit_scales`, which handles a missing project hint and partial-index chains.
- Why it matters: a millimetre model whose project fails to resolve renders overlays or reports quantities 1000× off, with no warning (the `.ok()` / `unwrap_or(1.0)` swallow the error).
- Fix: every site calls `processing::prepass::resolve_unit_scales(content, None, &mut decoder)`. Overlays could take the pre-pass `unitScale` alongside the `RtcFrame`.
- Effort: S

### EDGE-9: The Z-up → Y-up basis, 4×4 multiply and render-frame point transform are copied, and two copies differ on -0.0
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/zero_copy/frame_swap.rs:35-61 · rust/processing/src/simplify_math.rs:11-56 (jscpd 28-41 vs frame_swap 35-48) · rust/export/src/frame.rs:18-27 · rust/export/src/gltf/matrix.rs:32-66 · rust/wasm-bindings/src/api/grid_lines.rs:176-203 · rust/wasm-bindings/src/api/alignment_lines.rs:125-127, 153-161 · identity: grid_lines.rs:77-79
- What: the same `S` / `S^T` constants and a row-major matmul appear four times. Grid and alignment both do "scale → column-major placement → subtract RTC → (x,z,-y) → f32". Grid adds `+ 0.0` to turn -0.0 into +0.0 (it documents the parity with symbolic `RenderFrameRebase`); alignment emits `-my as f32` without it. Two copies of the identity matrix.
- Why it matters: frame bugs are hard to see (the frame_swap.rs doc says as much), and the overlays already differ on the sign of zero.
- Fix: an `ifc_lite_geometry::frame` module (lowest crate common to processing, export and wasm) with `ZUP_TO_YUP`, `mat4_mul_row_major`, `conjugate_zup_to_yup`, `IDENTITY4`, and `to_render_frame(p, unit_scale, placement, rtc) -> [f32;3]`. Grid and alignment call the last one.
- Effort: M

### EDGE-10: Prepass wire encoders live in `processing`, but the browser decodes some of them itself
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/gpu_meshes/batch_partition.rs:206-227 (style colour decode) vs rust/processing/src/style/mod.rs:135-149 (`Rgba::to_rgba8` / `from_rgba8`) · rust/wasm-bindings/src/api/gpu_meshes/void_index.rs:16-36 vs rust/processing/src/prepass.rs:615 (`flat_voids`) · signature: rust/wasm-bindings/src/api/gpu_meshes/style_finishes.rs:35-41 vs inline copy rust/wasm-bindings/src/api/gpu_meshes/batch.rs:275-277 and the tuple typed again at rust/wasm-bindings/src/api/mod.rs:252-262
- What: `style_colors_from_wire` re-codes `/255.0` instead of calling `Rgba::from_rgba8`. The voids inverse sits in wasm while the encoder is in processing. By contrast `material_colors_from_flat` and `finish_from_wire` are already in processing.
- Why it matters: neither round trip can be tested in one crate. A quantisation change in `to_rgba8` would leave the decoder out of step.
- Fix: `processing::prepass::{style_colors_from_flat, voids_from_flat}` next to their encoders, with round-trip tests there. Reuse `style_wire_signature` in batch.rs.
- Effort: S

### EDGE-11: Cache lifecycle is hand-copied: eight lazy getters and three diverging reset paths
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED (stale-finish case LIKELY)
- Where: lazy getters at rust/wasm-bindings/src/api/mod.rs:733-760, 768-822, 841-865, 871-895, 900-924, 935-986, 995-1017 and rust/wasm-bindings/src/api/gpu_meshes/batch.rs:143-162, 190-217 · resets at rust/wasm-bindings/src/api/mod.rs:344-437 (`clearPrePassCache`) and rust/wasm-bindings/src/api/entity_index.rs:63-140 (`install_entity_index`) · index installed with no reset at rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:40-45, 501-507
- What: each getter repeats lock → check → unlock → build → lock → store. 13 caches are listed by hand in two clear functions:
  - `install_entity_index` clears `cached_geometry_styles` because "the (len,first,last) signature would otherwise collide" (entity_index.rs:115-121), but not `style_finishes`, which uses the same signature (style_finishes.rs:153-158);
  - `buildPrePassOnce` and `buildPrePassStreaming*` install a new index without clearing any content-scoped cache. They rely on JS calling `clearPrePassCache` in a `finally`.
- Why it matters: a new cache added to one list and not the others carries over stale data into the next file (texture index, plane angle, finishes) on a reused `IfcAPI`.
- Fix: a `ContentCaches` struct (one `Mutex<ContentState>`, or a small `LazySlot<T>` with `get_or_build`) with a single `reset()` that every content-swap path calls, including both pre-pass entry points.
- Effort: M

### EDGE-12: 16-argument batch signatures copied at five entry points (plus 12-argument finalize ×2)
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/gpu_meshes/batch.rs:71-100, 661-679, 718-736, 808-826 (calls 683-687, 744-748, 834-838) · rust/wasm-bindings/src/api/gpu_meshes/batch_from_source.rs:74-91, 118-135 (calls 93-110, 137-154) · rust/wasm-bindings/src/api/gpu_meshes/prepass_sharded.rs:238-252 vs rust/wasm-bindings/src/api/gpu_meshes/prepass_from_source.rs:31-50
- What: these are the jscpd hits (batch 661-679 / 718-736 / 808-826; batch 663-680 vs batch_from_source 75-92; batch_from_source 74-91 vs 118-135; prepass_from_source 32-44 vs prepass_sharded 240-252), all confirmed. There is no `processGeometryBatchInstancedFromSource`, which is an asymmetry.
- Why it matters: adding a wire field (as #407 / #5582 did) means editing 10 places plus the committed `.d.ts`.
- Fix: a `#[wasm_bindgen] struct BatchWire` (or one `setBatchContext(unitScale, rtc, voids, styles, materials)` stored on `IfcAPI`, like `setSourceBytes`), so batch calls take `(jobs)` or `(data, jobs)`. A `Source` enum (`Bytes(&[u8])` | `Held`) would fold the `*FromSource` twins together.
- Effort: M

### EDGE-13: `exportMerged` uses `throw_str` inside a `&self` method
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/export_step.rs:79-100 (throws at 86, 89, 95); the explanation is at rust/wasm-bindings/src/api/export_step.rs:57-62
- What: the comment on the sibling `exportStep` says a throw from inside a `&self` method "leaves the instance's borrow flag held, so the host's later `free()` fails". `exportMerged` does exactly that on malformed `lengths`. The unwind also skips destructors, so the `models` Vec leaks.
- Why it matters: one bad call leaves the `IfcAPI` unusable and impossible to free.
- Fix: return `Result<Vec<u8>, JsError>` and use `?` with `JsError::new`, as `exportStep` does.
- Effort: S

### EDGE-14: FFI rejects IFC files that are not valid UTF-8
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/ffi/src/lib.rs:110 vs rust/python/src/lib.rs:73-88 (Vec<u8>), rust/processing/src/processor/mod.rs:416-424 (`AsRef<[u8]>`)
- What: `std::fs::read_to_string(path)` returns error code 2 ("cannot read") for any Latin-1 byte, which real exporters write. The pipeline, Python, server and wasm all accept raw bytes.
- Why it matters: the Rhino/C# host fails on files every other front-end loads.
- Fix: `std::fs::read(path)` and pass `&[u8]`.
- Effort: S

### EDGE-15: The streaming pre-pass copies the whole partial FxHashMap index to emit the meta event
- Category: Perf
- Severity: Medium
- Confidence: LIKELY
- Where: rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:445-447, 473 (`EntityDecoder::with_index(content, entity_index.clone())`; `with_index` takes the map by value, rust/core/src/decoder.rs:136)
- What: the mid-scan meta fires after 50 buffered jobs. Exporters that write representation items before products reach 50 products late in the file, so this deep-copies most of the id→span map inside the 4 GB wasm address space. The tail path copies the full map for files with fewer than 50 jobs.
- Why it matters: hundreds of MB of transient memory on large files, in the place where OOM was already hit (see the `PREPASS_INDEX_RESERVE_CAP` comment, prepass.rs:219-227).
- Fix: keep the scan map in an `Arc` and use `with_arc_index`, or add a borrowed-index decoder constructor.
- Effort: S

### EDGE-16: Overlay parsers re-transcode and re-index the whole file on every call
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/grid_lines.rs:48-50, 305, 317, 338, 346 · rust/wasm-bindings/src/api/alignment_lines.rs:51, 58, 70-75 · rust/wasm-bindings/src/api/symbolic.rs (`content: String`)
- What: each binding takes `content: String` (JS UTF-16 → UTF-8 copy of the whole file), then runs `build_entity_index`, a project scan and a second full scan. `parseGridLines` and `parseGridAxes` repeat all of it, even though `IfcAPI` already holds `cached_source_bytes` and `cached_entity_index`.
- Why it matters: several full-file passes per overlay toggle on large models.
- Fix: `*FromSource` / index-reusing variants (`&[u8]` + cached `ColumnarEntityIndex`), and one grid extraction returning both the vertices and the axes.
- Effort: M

### EDGE-17: God functions, a 22-field `IfcAPI` and boolean-flag soup
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/gpu_meshes/batch.rs:71-649 (`produce_batch`, 579 lines) · rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:185-746 (`pre_pass_streaming_impl`, 562 lines; flags at 192-194, `let have_prebuilt = external_styles; // sharded mode always passes both` at 498) · rust/wasm-bindings/src/api/mod.rs:63-291 (22 fields, 17 Mutex/atomic caches; `#[allow(clippy::type_complexity)]` at 251, 268) · call matrix at prepass.rs:172-181, rust/wasm-bindings/src/api/gpu_meshes/prepass_owned_columns.rs:93-145, rust/wasm-bindings/src/api/gpu_meshes/source_fingerprint_prepass.rs:16-17
- What: `columns: Option<…>, external_styles: bool, compute_source_fingerprint: bool` are coupled (sharded always means external styles), and four `#[wasm_bindgen]` pre-pass variants plus two borrowed Rust twins exist only to pass combinations. All three files are allowlisted debt (module_size_allowlist.txt:421, 426, 444).
- Why it matters: hard to review, and the cache-reset drift in EDGE-11 comes from this shape.
- Fix: `enum PrepassMode { Serial, Sharded(ShardedColumns) }` plus `PrepassOptions { fingerprint }`. Split `pre_pass_streaming_impl` into scan → meta → post-scan emitters. Group the caches (EDGE-11).
- Effort: L

### EDGE-18: The browser don't-bake finalize repeats processing's grouping and template scan
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/gpu_meshes/instancing.rs:73-78 and rust/wasm-bindings/src/api/gpu_meshes/batch.rs:568-587 vs rust/processing/src/processor/instancing.rs:27-49
- What: group by `rep_identity` → sort by rep → template-by-rep from `instanceable` meshes with non-empty positions. Only the recovery step (`recover_occurrences_flat`) was shared. The `TemplateInfo` doc mentions a transform field that does not exist (instancing.rs:28-32).
- Why it matters: the next eligibility rule has to be applied twice, the same history as #2985.
- Fix: `processing::instancing::{group_occurrences_by_rep, templates_by_rep(meshes, eligible: impl Fn)}`.
- Effort: S

### EDGE-19: JSON-request binding helpers are only partly shared, and limits are hard-coded per file
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/appearance.rs:9-41 (`decode_request`, `encode_bounded`) vs hand-written copies at rust/wasm-bindings/src/api/scan_registration.rs:8-16, rust/wasm-bindings/src/api/appearance_calibration.rs:8-16, rust/wasm-bindings/src/api/scan_segmentation.rs:8-17, rust/wasm-bindings/src/api/scan_proposals.rs:9-25, rust/wasm-bindings/src/api/captured_mesh.rs:15-19, rust/wasm-bindings/src/api/pdf_vector.rs:26-43, rust/wasm-bindings/src/api/appearance_transfer.rs:52-56
- What: the same size check → `from_str` → call → `to_vec` / `encode_bounded` pattern, with inline limits (512 KiB, 8 KiB, 64 KiB, 64 MiB, 256 KiB). `decode_request`'s message "Appearance request exceeds…" is also returned for annotation and page requests.
- Why it matters: the messages and DoS limits are inconsistent across endpoints.
- Fix: `fn json_call<Req, Res>(json: &str, max: usize, what: &str, f: impl FnOnce(Req) -> Result<Res, String>) -> Result<Vec<u8>, JsError>`, with named limit constants.
- Effort: S

### EDGE-20: The ring-set wire format (coords / ringLengths / shapeOffsets) is encoded six times
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/bool2d.rs:89-99, 150-195 · rust/wasm-bindings/src/api/scan_outline.rs:121-138 · rust/wasm-bindings/src/api/mesh_outline.rs:115-125 · rust/wasm-bindings/src/api/space_plate.rs:116-121, 159-165, 174-179, 273 · rust/wasm-bindings/src/api/zone_split.rs:213
- What: `flat_map(|p| [p[0], p[1]])`, `chunks_exact(2)`, ring lengths and shape-offset casts written per binding.
- Why it matters: small, but the checked-arithmetic hardening in bool2d.rs:76-80 is not applied in the other decoders.
- Fix: a wasm-local `ring_wire` module (`flatten(&[Ring2D])`, `lengths`, `offsets_u32`, `decode(coords, lens) -> Result`), or `ContourSet::to_flat` / `from_flat` in geometry.
- Effort: S

### EDGE-21: Small clones inside batch.rs and grid_lines.rs
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/gpu_meshes/batch.rs:768-782 vs 922-936 (MeshData→`InstanceMeshRef`) · batch.rs:128-132, 588-592, 787, 950 (`if needs_shift {rtc} else {0}`) · rust/wasm-bindings/src/api/grid_lines.rs:307-311 vs 326-330 (vertex flattening)
- What: identical literals and blocks within the same file.
- Why it matters: the #2985 `item_id` field had to be added to both `InstanceMeshRef` sites.
- Fix: `fn instance_ref(m: &MeshData) -> InstanceMeshRef`; compute `rtc` once in `produce_batch` and return it; `fn axes_to_vertices(&[GridAxis3D])`.
- Effort: S

### EDGE-22: Flat mesh-wire slicing is written three times with different overflow handling
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/simplify.rs:81-139 (u64) vs rust/export/src/gltf/from_meshes.rs:153-195 (`(vbase + vc) * 3` in usize) vs rust/export/src/collada.rs:106-140 (u64)
- What: three walks over `vertex_counts` / `index_counts` slicing concatenated positions, normals and indices. Only two use u64 arithmetic (the collada comment notes the GLB twin's wasm32 wrap risk).
- Why it matters: the hardening is uneven.
- Fix: `ifc_lite_export::mesh_input::slice_meshes(...) -> Result<Vec<MeshSlice>, MalformedMeshInput>`, used by simplify.
- Effort: S

### EDGE-23: Test fixtures are copied across crates
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/gpu_meshes/prepass_discovery_tests.rs:238-258 = rust/wasm-bindings/src/api/styling/prepass_orphan_type_tests.rs:95-115 · rust/processing/tests/issue_1910_shard_class_ci_coverage.rs:89-101 = rust/wasm-bindings/src/api/gpu_meshes/prepass_discovery_tests.rs:84-96 · rust/geometry/tests/ifc4x3_sectioned_linear_positions.rs:37-58 ≈ rust/wasm-bindings/src/api/alignment_lines_tests.rs:66-87 · about 25 inline `FILE_SCHEMA` headers across wasm tests
- What: verbatim STEP fixtures and `find_storey_idx` closures.
- Why it matters: when a fixture is corrected (for example the IFC2X3 DoorStyle), the copies drift.
- Fix: `ifc_lite_core::test_support::{step_file(schema, data), fixtures::LEGACY_DOORSTYLE_ORPHAN, …}` behind a `test-support` feature; geometry already has that feature pattern.
- Effort: S

### EDGE-24: Small duplicates across front-ends
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/ffi/src/lib.rs:51 vs rust/python/src/lib.rs:51 (256 MiB stack, "Mirrors rust/ffi") · rust/wasm-bindings/src/api/mod.rs:632-642 vs rust/python/src/lib.rs:60-69 (quality-label error text) · rust/wasm-bindings/src/api/export_hbjson.rs:28, 49 and rust/wasm-bindings/src/api/export_dfjson.rs:24 (`tolerance: 0.01`) · FNV-1a in rust/wasm-bindings/src/api/gpu_meshes/source_fingerprint.rs:6-11, rust/export/src/usd/emit.rs:338-343, rust/processing/tests/module_size_ratchet.rs
- What: magic numbers and helpers repeated across crates.
- Fix: `processing::GEOMETRY_STACK_BYTES`; `TessellationQuality::parse_label_or_err`; `HbjsonOptions::default_tolerance()` or `Default`; a shared `fnv1a` in core.
- Effort: S

### EDGE-25: An `IFCSITE` job is emitted even when the caller disables `IFCSITE`
- Category: Bug
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:358-364 · rust/wasm-bindings/src/api/gpu_meshes/prepass_discovery.rs:92-98
- What: the site branch pushes a job before `is_disabled` is checked (the generic branch at prepass.rs:381 does check it). `CLASS_TOGGLED_TYPES` lists `IfcSite`, so it is a valid thing to disable.
- Why it matters: the load-time filter (today only the perf flag in packages/geometry/src/perf-flags.ts:45) does not apply to terrain/site.
- Fix: guard the job push with `!is_disabled(&disabled_types, type_name)` but keep `site_position` (it is needed for RTC/rotation). Fold this into EDGE-3.
- Effort: S

### EDGE-26: Cache keys and decoder seeding that are wrong but currently harmless
- Category: Quirk
- Severity: Low
- Confidence: SUSPECT
- Where: rust/wasm-bindings/src/api/gpu_meshes/batch.rs:274-300 · rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:544 · rust/wasm-bindings/src/api/gpu_meshes/prepass_sharded.rs:287
- What:
  - The style cache key is `(len, first_id, last_id)` of `style_ids` and ignores `style_colors`, so a re-colour that keeps the same ids is served stale.
  - Pre-pass decoders are seeded with `seed_unit_scales(1.0, …)` regardless of the real length unit. Today nothing on those decoders reads length units (MaterialLayerIndex keeps raw thickness), but any future consumer would silently get metres.
- Fix: hash the colour bytes into the signature (cheap FxHash), and seed with `meta.length_unit_scale`.
- Effort: S

### EDGE-27: Mixed error shapes at the boundary, and silent conversion fallbacks
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: string errors (`JsValue::from_str`, not `Error`) at rust/wasm-bindings/src/api/mod.rs:637, rust/wasm-bindings/src/api/gpu_meshes/prepass_sharded.rs:172, 256, 284, rust/wasm-bindings/src/api/space_plate.rs:93, 271, 309 · `JsError` in scan_*/appearance*, `js_sys::Error` + `set_name` at space_plate.rs:316-320 · silent fallbacks at rust/wasm-bindings/src/api/parsing.rs:104, 161 (empty array), rust/wasm-bindings/src/api/pipeline_diagnostics.rs:38, rust/wasm-bindings/src/api/diagnose.rs:27, rust/wasm-bindings/src/api/export_hbjson.rs:60 (`undefined`)
- What: thrown strings have no stack and fail `instanceof Error`. A failed `to_value` looks the same as "no entities" or "no diagnostics".
- Fix: standardise on `JsError` (or `js_sys::Error` with a stable `name`), and turn serialisation failures into errors instead of empty values.
- Effort: S

### EDGE-28: Result getters copy whole buffers on every access
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/simplify.rs:174-251 (14 getters) · rust/wasm-bindings/src/api/clash.rs:136-174 · rust/wasm-bindings/src/api/clash_solid.rs:94-103
- What: `self.render_positions.clone()` and similar: a Rust clone plus the bindgen copy into JS, repeated on each property read.
- Fix: take-once accessors like `PartitionedBatch::take_shard` (partitioned_batch.rs:31-34), or return views and document `.slice()`.
- Effort: S

### EDGE-29: Stringly-typed and inconsistent boundary inputs
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/export_data.rs (exportCsv `mode` falls back to `Entities` on any unknown string) vs rust/wasm-bindings/src/api/mod.rs:630-643 (throws on an unknown quality) · RTC passed three ways: loose `rtc_x, rtc_y, rtc_z, needs_shift` with no finiteness check (batch.rs:76-79, 261-263), `RtcFrame` object validated strictly (rust/wasm-bindings/src/api/overlay_frame.rs:39-56), and `rtc_x/y/z` without `needs_shift` (simplify.rs:285-287) · layer-slice diagnostics parsed by an `"ok:"` string prefix (batch.rs:535, 545)
- What: a typo in a CSV mode silently produces the wrong export, and a NaN RTC silently corrupts every vertex.
- Fix: reject unknown enum labels; one `RtcFrame` decoder (`parse_overlay_frame`) for all mesh paths; a typed layer-slice outcome enum in geometry.
- Effort: S

### EDGE-30: Dead or duplicated public surface
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/parsing.rs:122 (`scanGeometryEntitiesFast`, no non-test TS caller and its discovery differs, EDGE-3) · rust/wasm-bindings/src/api/gpu_meshes/batch.rs:716-790 (`processGeometryBatchInstanced`, only apps/viewer/src/test/source-actions-fixture.ts) · `version()` at rust/wasm-bindings/src/lib.rs:118 and rust/wasm-bindings/src/api/mod.rs:551 · `set_panic_hook` re-exported twice (rust/wasm-bindings/src/lib.rs:55, 82)
- Fix: remove, or mark deprecated in `ifc-lite.d.ts`.
- Effort: S

### EDGE-31: Stale comments and justifications
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - rust/wasm-bindings/src/api/styling/color.rs:127, 183 and rust/wasm-bindings/src/api/styling/prepass.rs:131 point to `gpu_meshes.rs`, which was deleted;
  - rust/wasm-bindings/src/api/mod.rs:930 ("processor.rs ~905");
  - rust/wasm-bindings/src/api/gpu_meshes/instancing.rs:140 ("lines ~826-850"; the code is now at 885-893);
  - rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:144-145 says jobs flush every `chunk_size` during the scan, but 455-458 buffers them until after the scan;
  - rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:398 and rust/wasm-bindings/src/api/styling/prepass.rs:84 say "`IfcBuilding` et al.", but IfcBuilding is now exempt class-wide (rust/core/src/schema_helpers.rs:180-185);
  - rust/processing/src/style/material.rs:124-126 (see EDGE-1).
- Fix: update or remove them.
- Effort: S

### EDGE-32: Inconsistent hostile-input policy for JS mesh operands
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/zone_split.rs:172-186 vs rust/wasm-bindings/src/api/clash_solid.rs:146-166
- What: `splitMeshByZones` silently drops bad triangles (documented). On wasm32, `(i as usize) * 3` wraps for indices ≥ 2^30, so a hostile index can read a *wrong* in-range vertex rather than being dropped. `clashIntersectionSolid` rejects the same malformations explicitly. No reachable u32 truncation otherwise: `start as u32` casts (prepass.rs:81-82, 309-310; prepass_sharded.rs:112-113) are bounded by wasm32's 4 GiB, though they would truncate if the rlib were used natively on files over 4 GiB.
- Fix: one shared `mesh_from_js(positions, indices) -> Result<…>` (checked index ≤ vertex count) for both.
- Effort: S

### EDGE-33: Two opacity cutoffs
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/api/gpu_meshes/batch_partition.rs:27 (`INSTANCED_ALPHA_CUTOFF = 0.99`, mirrors the renderer) vs rust/processing/src/style/mod.rs:59 (`TRANSPARENCY_ALPHA_THRESHOLD = 0.95`)
- What: alpha in [0.95, 0.99) counts as opaque for the material alternation but transparent for routing. The 0.99 value is documented as mirroring the renderer, so this is deliberate, but there is no single constant tying the two together.
- Fix: put both in `processing::style` with a doc explaining why they differ.
- Effort: S

---

**Concept inventory (in scope)**
- Vector/matrix math: `swap_zup_to_yup_mat4` zero_copy/frame_swap.rs:35 · `swap_zup_to_yup_aabb` frame_swap.rs:25 · `to_render_frame` api/grid_lines.rs:176 · inline transform api/alignment_lines.rs:153-161 · `IDENTITY` alignment_lines.rs:125 / grid_lines.rs:77 · cross-crate: processing/src/simplify_math.rs:11-56, export/src/frame.rs:18-60, export/src/gltf/matrix.rs:32-66
- Transforms / frames: `parse_overlay_frame` api/overlay_frame.rs:39 · `set_stream_meta_props` gpu_meshes/prepass_sharded.rs:35 · RTC triples in batch.rs:128, 588, 787, 950 · `MeshFrame::for_overlay` grid_lines.rs:61, alignment_lines.rs:95
- Tolerances / limits: `INSTANCED_ALPHA_CUTOFF` batch_partition.rs:27 · `INSTANCE_MIN_OCCURRENCES` batch_partition.rs:41 · `DEFAULT_GEOM_HASH_TOLERANCE` use mod.rs:318 · `TESSELLATION_QUALITY_MEDIUM` mod.rs:59 · `WORST_HOSTS_LIMIT` csg_diagnostics.rs:9 · `SAMPLE_STEP_FILE_UNITS` / `MAX_SAMPLES` alignment_lines.rs:37-38 · `MAX_INPUT_SEGMENTS` / `RECTS` space_plate_input.rs:31-32 · `PREPASS_INDEX_RESERVE_CAP` prepass.rs:227 · `META_EMIT_JOB_THRESHOLD` prepass.rs:273 · `FIRST_WAVE_JOBS` prepass.rs:668 · `chunk_size.max(1024)` prepass.rs:204 · `MIN_INTERVAL_MS` progress_hook.rs:17 · `MAX_OPTIONS_BYTES` scan_segmentation.rs:8, scan_proposals.rs:9, 11 · inline limits appearance.rs:10, 30, scan_registration.rs:9, appearance_calibration.rs:9, captured_mesh.rs:16 · `tolerance: 0.01` export_hbjson.rs:28, 49, export_dfjson.rs:24
- Unit conversion: alignment_lines.rs:77-88 · grid_lines.rs:55-56 · `get_or_resolve_plane_angle` mod.rs:995 · `seed_unit_scales` batch.rs:171, prepass.rs:544, prepass_sharded.rs:287 · `resolve_stream_meta` prepass.rs:61, 451, 475
- Bbox: `Contours2D::bounds` bool2d.rs:200 · `swap_zup_to_yup_aabb` frame_swap.rs:25 · `ElementMeshOutput::geometry_aabb` batch.rs:30
- Hashing / keys: `source_fingerprint` (FNV-1a 32) gpu_meshes/source_fingerprint.rs:6 · `fold_u128_to_u32` prepass_affinity.rs:13 · `style_wire_signature` style_finishes.rs:35 (inline copy batch.rs:275-277) · `geometry_routing_key` use prepass.rs:688
- Triangulation / polygon ops: `union_2d` / `difference_2d` / `intersection_2d` / `resolve_2d_js` bool2d.rs:209-246 · `Contours2D::new` bool2d.rs:69 · `split_mesh_by_zones_js` zone_split.rs:164 · `mesh_from` clash_solid.rs:146 · `meshOutline2d` mesh_outline.rs:~100 · `SpacePlateHandle` space_plate.rs:70 · `build_segments` / `build_wall_rects` space_plate_input.rs:52, 88
- Entity attribute access: `get_ref(0)` / `get_ref(5)` / `get(6).as_list` styling/prepass.rs:164, 171, 206, 215, 266, 290, 336 · batch.rs:448, 461-465 · color.rs:79, 85, 93, 159, 161 · grid_lines.rs:98-122, 149-163 · `keyword_at` prepass_discovery.rs:29 · `is_disabled` prepass_discovery.rs:44 · `ifc_type_from_record` use batch.rs:440
- Colour / style resolution: `find_color_for_geometry` color.rs:10 · `resolve_element_color` color.rs:134 · `walk_representation_for_direct_color` color.rs:154 · `style_colors_from_wire` batch_partition.rs:206 · `style_finishes_from_wire` style_finishes.rs:49 · `BatchFinishes` style_finishes.rs:65 · `mesh_js_with_finish` style_finishes.rs:106 · `get_or_build_indexed_colour_maps` mod.rs:935 · `styles_payload` / `styles_payload_with_flat` prepass_sharded.rs:330, 342 · `check_rgba_columns` prepass_sharded.rs:18 · `combined_pre_pass` styling/prepass.rs:34 · `is_class_toggled` / `CLASS_TOGGLED_TYPES` batch_partition.rs:140-155
- Error types: `refuse` prepass_owned_columns.rs:23 · `edit_error_parts` space_plate_input.rs:109 / `edit_err` space_plate.rs:316 · `ColumnLengthMismatch` entity_index.rs:54-66 · `throw_str` export_step.rs:86-95 · `JsValue::from_str` vs `JsError::new` vs `js_sys::Error::new` used side by side (EDGE-27) · String-error cores: `group_and_slice_records` simplify.rs:49, `segment_json` scan_segmentation.rs:10, `decode_request` appearance.rs:9

I ran nothing (no cargo, no tests); every finding comes from reading the code. The two I'd confirm first with a run are EDGE-5 (missing #858 guard on the live partitioned path; a wasm-contract fixture with a repeated multi-colour mapped face set would show it) and EDGE-15 (index copy at meta emission; a memory profile on a large Revit-style file).