# rust/export review

Scope: rust/export (~57k lines). Four sub-reviews:
- **GEOM**: glTF/GLB (gltf.rs + gltf/), USD, COLLADA, KMZ, OBJ, LandXML terrain, frame.rs, mesh_input.rs, color_space.rs, xml_text.rs, and their tests. This section is written below in full.
- **STEP**: STEP writer and log (step*.rs, step_log/, source_header, generated/step_log_tables.rs). Findings EXPORT-STEP-1..29. Full findings in 07a-export-step-writer.md.
- **MERGE**: merged/, schema_*, generated/ (slots, entity names, enum reconciliation), step_map_*, rooted_type. Findings EXPORT-MERGE-1..22. **Not merged here**, same reason.
- **DATA**: model*, quantity/rebar schedules, csv/json/jsonld/parquet/ifc5, HBJSON/DFJSON (rooms, openings, adjacency, shades, constructions, geom.rs, dfjson/). Findings EXPORT-DATA-1..28. **Not merged here**, same reason.

## Summary
- **(High bug) Only the glTF writers restore world coordinates.** OBJ and USD write `process_geometry` output as is, without adding the RTC shift or the IfcSite rotation back. Any model with a placed or rotated IfcSite, or with national-grid coordinates, therefore lands in a different place in OBJ/USD than in GLB, by kilometres for the ModelRtc tier (EXPORT-GEOM-1). The arithmetic already exists twice (gltf `site_restore`/`scene_root`, processing `geometry_export::build_elements`) but has no shared home.
- **(High DRY) gltf.rs holds three hand-synchronised glTF assemblers** (in-memory, multi-buffer streaming, bounded two-pass). About 1,300 lines repeat the scene-AABB fold, renderable gate, quantization frame and encoder, accessor triplets, material dedup, node placement, root and document literal, and GLB framing (EXPORT-GEOM-2). Drift has already happened twice, and the file's ratchet budget has 938 lines of slack (EXPORT-GEOM-10).
- **There is no shared export-pipeline core.** Every exporter re-decides mesh acquisition, renderability and finiteness (7 predicates, 3 non-finite policies, EXPORT-GEOM-4), frame conversion (~10 Z/Y-up copies across 3 crates with drifted affine-inverse NaN handling, EXPORT-GEOM-3), material colour keys (3 copies, drifted clamp, EXPORT-GEOM-5), number-to-text (8+ formatters including two disagreeing STEP REAL writers, EXPORT-GEOM-6), identifiers and unique names (EXPORT-GEOM-7), and fail-closed behaviour (GLB/COLLADA refuse empty models; USD/OBJ/multi-buffer glTF don't, EXPORT-GEOM-9/15).
- **From-meshes contracts live in two loops** (GLB and COLLADA) that already disagree on short normal buffers (EXPORT-GEOM-8). They are hidden behind 7-11 positional slice parameters plus a boolean trio (EXPORT-GEOM-13), and the public infallible GLB variant still wraps on wasm32 (EXPORT-GEOM-14).
- **Test code is heavily copy-pasted**: at least seven GLB readers, three node-world composers, identical STEP-file wrappers across unit and integration tests, and 20-field `MeshData` literals in four files. The only shared test helper is the fixture loader (EXPORT-GEOM-18/19).

## Cross-sub-area DRY themes (proposed shared export-pipeline core)
Each theme lists the concern, every site seen, and its proposed single home. GEOM sites were verified in this review. STEP/MERGE/DATA sites the GEOM reviewer saw while cross-checking are noted; the sub-review findings carry the full lists.

1. **Geometry acquisition + world restore**: `process_geometry*` is called separately by gltf.rs (3 variants), usd/instance.rs (`gather`, up to 2 passes), obj.rs, and by parquet_bos (DATA). World restore exists only in gltf.rs:1034-1092 and processing/geometry_export.rs:154-190. **Home:** `ExportSource { bytes, index: OnceCell<Arc<EntityIndex>>, result: ProcessingResult, frame: WorldRestore }` in a new `export/src/pipeline.rs`. Every geometry writer consumes it, so USD/OBJ/IFC5/JSON stop re-parsing the file 3-4 times (EXPORT-GEOM-15).
2. **Renderable/finite gate**: see EXPORT-GEOM-4. **Home:** `mesh_input::Renderable`.
3. **Frame/basis + 4x4 math**: see EXPORT-GEOM-3. step_map_* (MERGE) also composes placement matrices. **Home:** `ifc_lite_geometry` frame/affine module.
4. **Colour**: material key (EXPORT-GEOM-5), sRGB->linear (`color_space.rs`, already shared by glTF/USD; COLLADA deliberately sRGB), default grey 0.8 x3. **Home:** `color_space.rs`.
5. **Number formatting**: COLLADA, USD, LandXML, OBJ, KMZ, glTF (serde), STEP x2 (`step_map_transform_writer::real` vs `step_log::jsval::format_step_real`), `model_props::fmt_num` (DATA), `json::finite_json_number` (DATA). **Home:** `num_text.rs` (EXPORT-GEOM-6).
6. **String escaping**: `xml_text::escape` (KML, LandXML), `usd::fmt::escape_str`, `step_text::escape` (STEP), `csv_cell` (DATA), serde for JSON. These are format-specific and legitimately separate, but should live together in one `escape` module with one shared control-character policy (XML maps C0 to U+FFFD, USD drops it, STEP emits `\X2\`).
7. **Identifiers/names/GUIDs**: USD/IFC5 `prim_name` (identical), HBJSON `sanitize_identifier`, `Namer` vs LandXML `unique_names`, `ifc5::uuid_from_id`, merged `deterministic_global_id` (MERGE). Magic attribute indices (`get(0)` GlobalId, `get(2)` Name, `get_ref(6)` Representation) recur in landxml_terrain_tin.rs:62-70, ifc5.rs:133 and the DATA exporters. **Home:** `ident.rs` plus named attribute accessors in core.
8. **Provenance/header**: five generator spellings (EXPORT-GEOM-20). STEP header writers (STEP/MERGE) are a separate cluster.
9. **Fail-closed/error policy**: `ExportError` (GLB/COLLADA/KMZ/parquet), `LandXmlTerrainRefusal(String)`, `Result<_, String>` internals, infallible `String` returns (USD/OBJ/IFC5/JSON/HBJSON with `expect("serializes")`). **Home:** one `refuse_empty` rule plus `ExportError` for every writer. The `#[non_exhaustive]` concern noted at landxml_terrain.rs:134 is fixable by marking `ExportError` `#[non_exhaustive]` once.
10. **Instancing**: three implementations (EXPORT-GEOM-11).

## Findings: GEOM (glTF / USD / COLLADA / KMZ / OBJ / LandXML / frame)
### EXPORT-GEOM-1: OBJ and USD exporters drop the RTC shift and the IfcSite rotation, so georeferenced/site-placed models land in the wrong place
- Category: Bug
- Severity: High
- Confidence: CONFIRMED
- Where: rust/export/src/obj.rs:97-170 (`write_obj(&process_geometry(content).meshes, ..)`, header says "origin-folded world coords"); rust/export/src/usd.rs:59-234 + rust/export/src/usd/emit.rs:259-271 (`xformOp:translate` = `m.origin` only) + rust/export/src/usd/instance.rs:126-130 ("`A`'s translation is in the post-RTC frame"); compare rust/export/src/gltf.rs:1034-1092 (`site_restore` + `scene_root`) and rust/processing/src/geometry_export.rs:97-190 (`world = R * (position + origin) + rtc_offset`)
- What: `process_geometry` returns meshes in `MeshCoordinateSpace::{SiteLocal, ModelRtc, RawIfc}`: in SiteLocal the IfcSite translation is subtracted and its rotation removed; in ModelRtc a detected anchor is subtracted (`metadata.coordinate_info.origin_shift`). `rg 'origin_shift|site_transform|mesh_coordinate_space'` over rust/export finds hits only in gltf. OBJ folds `mesh.origin` and swaps to Y-up; USD writes `origin` as a translate. Neither adds `origin_shift` back or re-applies the site rotation.
- Why it matters: for `gltf.rs`'s own `ROTATED_SITE` fixture (site at (1000,2000,0), yaw 90 degrees), the GLB root carries the restored site translation and rotation (asserted at gltf.rs:3065-3089). OBJ/USD for the same file put the wall near the origin, unrotated. For a national-grid model (ModelRtc) they are off by the whole anchor, kilometres. That is the exact divergence glTF fixed ("the same file came out kilometres apart"), and it was fixed in only one writer. The OBJ header claims world coordinates it does not have.
- Fix: one "to world" home, either a pub helper in `ifc_lite_processing` (the arithmetic already exists inside `geometry_export::build_elements`) or `crate::frame::WorldRestore::from_result(&ProcessingResult)` returning `(rtc_zup, Option<site_rotation>)`. OBJ applies it per vertex in f64. USD authors it once on `/World` (`xformOp:transform`), which keeps the per-mesh f32 precision story. Extend `every_export_path_agrees_where_the_model_is` to OBJ and USD.
- Effort: M

### EXPORT-GEOM-2: three near-complete copies of the glTF assembler (in-memory, multi-buffer streaming, bounded two-pass)
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: rust/export/src/gltf.rs:1119-1495 (`build_gltf`), 1698-1908 (`export_gltf_streaming_impl`), 2139-2777 (`plan_bounded_glb`) + 2779-2939 (`write_bounded_glb`). Duplicated sub-concerns, every site:
  - world-AABB / scene-centre fold: 1135-1159, 1745-1777, 2236-2262 (via local bbox) + 2288-2296
  - "renderable mesh" gate: `VisibilityFilter::visible` 414-433, `view_ok` 996-1001, inline 2208-2214, inline 2827-2833 (plus collada.rs:162, obj.rs:69, usd.rs:240-265; see EXPORT-GEOM-4)
  - quantization frame (centre/half with degenerate-axis guard): push_mesh_quantized 763-780, plan 2449-2462
  - SHORT position/normal encoding with normal pre-scale and renormalise: push_mesh_quantized 788-830 and write_bounded_glb 2851-2878 (byte-identical by comment only)
  - accessor triplet (POSITION/NORMAL/indices) construction: 675-707, 851-882, 2479-2510, 2520-2553 (jscpd: 708-733 <-> 876-901)
  - material dedup `material_map.entry(color_key(..)).or_insert_with(make_material)`: 709-713, 884-888, 2555-2559
  - Mesh/Primitive push + `stats.meshes/vertices/triangles` bump: 715-728, 890-903, 2560-2571
  - flat-node placement (quantized `T(placement+center)·S(half)` / shared translation / singleton bake): 1262-1312, 1830-1850, 2632-2654
  - root node + `asset_extras` + `Gltf { .. extensions_used/required }` literal: 1413-1495, 1868-1907, 2700-2774 (jscpd 1462-1477 <-> 1881-1895, 1873-1890 <-> 2732-2749)
  - `stream_opts` closure: 1725-1730, 2146-2151, 2790-2795 (jscpd 1728-1746 <-> 2160-2177)
  - GLB container framing: `pack_glb` 2943-2985, `write_bounded_glb` 2800-2817, `glb_container_size` 1976-1980
- What: about 1,300 of gltf.rs's 3,090 lines are three hand-synchronised implementations of one layout. Their agreement rests on comments ("mirrors build_gltf's flat branch exactly", "identical to push_mesh_quantized", "the in-memory chunker pads ... mirror it") and on byte-identity tests that cover only flat models.
- Why it matters: the documented drift has already happened twice (the site-placement restore was fixed in one path first; #3666 verification exists in one path only). Every new glTF feature (extension, attribute, material flag) costs three edits plus a parity test.
- Fix: split into `gltf/layout.rs` (one `MeshLayout { f32 | Quantized{center,half,small} }` computing byte sizes, accessor min/max from a bbox, and the encoder `encode_into(&mut [u8], positions, normals, indices)`), `gltf/doc.rs` (`DocBuilder` owning accessors/meshes/materials/nodes/stats, `push_mesh(layout, view) -> mesh_idx`, `push_flat_node`, `finish(root, opts) -> Gltf`), and `gltf/scan.rs` (one `scene_center` fold and one `stream_opts`). The three drivers then differ only in where bytes go (Chunker vs preallocated slice) and when the plan is made.
- Effort: L

### EXPORT-GEOM-3: Z-up/Y-up basis change and 4x4 helpers are reimplemented across export and in two other crates, with drifted tolerances
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Z->Y point swap `(x,z,-y)`: rust/export/src/frame.rs:20,26 (`yup_f32`,`yup_f64`), 91-133 (`to_yup_into`/`to_yup_in_place`); rust/processing/src/simplify_math.rs:20 (`zup_to_yup`); rust/wasm-bindings/src/zero_copy/frame_swap.rs:25-34
  - Y->Z swap `(x,-z,y)`: rust/export/src/collada.rs:34 (`to_zup`); rust/export/src/geom.rs:12 (`zup`); rust/processing/src/simplify_math.rs:13 (`yup_to_zup`)
  - basis as matrix: rust/export/src/gltf/matrix.rs:33-45 (`S_YUP`/`S_YUP_INV`, row-major); rust/export/src/frame.rs:40-70 (`yup_matrix4`, column-major, permutation form); rust/processing/src/simplify_math.rs:26-43 (`S`/`ST` again); rust/wasm-bindings/src/zero_copy/frame_swap.rs:34-60 (with its own `matmul`)
  - 4x4 multiply: gltf/matrix.rs:54; simplify_math.rs:45 `matmul_row_major`; frame_swap.rs:49; test/example copies rust/export/src/gltf_tests.rs:318 and rust/export/examples/world_check.rs:33
  - affine inverse: gltf/matrix.rs:160 (`det.abs() < 1e-18`, no finiteness check) vs simplify_math.rs:70 (`!det.is_finite() || det.abs() < 1e-24`)
  - `IDENTITY16`: gltf/matrix.rs:47 and rust/geometry/src/instancing/collate.rs:9; `compose_world_meta` (gltf/matrix.rs:198, arrays) re-derives `collate::compose_world` (nalgebra) "the same product"
  - quaternion from rotation: rust/export/src/gltf.rs:1094
- What: one rotation, written about ten times in three conventions (row-major array, column-major array, nalgebra), and the two affine inverses use different singularity thresholds and different NaN handling.
- Why it matters: a NaN placement gives `det = NaN`. `NaN.abs() < 1e-18` is false, so gltf's `affine_inverse` returns `Some(NaN matrix)` where the processing copy returns `None`. The instanced group then ships NaN node matrices instead of falling back to flat. Separately, every new consumer picks a copy at random, so the row-major vs column-major mix (frame.rs is column-major, gltf/matrix.rs is row-major, inside the same exporter) is a standing transposition-bug hazard.
- Fix: one `ifc_lite_geometry::frame` (or `math::affine`) module: `Basis::ZupToYup` with `point/vector/matrix_conjugate`, `Affine4` (a row-major newtype, with `mul`, `inverse -> Option` rejecting non-finite, `to_col_major_f32`, `rotation_quaternion`). Export, processing and wasm-bindings call it. Keep `frame.rs` only for the bulk in-place buffer swaps.
- Effort: M

### EXPORT-GEOM-4: "is this mesh renderable/finite" is decided by seven predicates with three different non-finite policies
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED (drift) / SUSPECT (reachable NaN from the pipeline)
- Where: rust/export/src/gltf.rs:414-433 (`VisibilityFilter::visible`), 996-1001 (`view_ok`), 2208-2214, 2827-2833 (inline copies); rust/export/src/collada.rs:162 (`pslice.len() < 9 ...`, no normals check); rust/export/src/obj.rs:54-89 (`mesh_visible`, no `% 3`, no index-range check, finite gate); rust/export/src/usd.rs:240-265 (`mesh_emittable`, finite + index-range gate); rust/export/src/mesh_input.rs:63-131 (scrub-to-zero)
- What: the from-meshes GLB and COLLADA scrub non-finite values to 0. OBJ and USD drop the whole mesh. The from-bytes GLB paths (`push_mesh`, bounded writer) do neither: a NaN normal or position is copied into BIN verbatim (`bytemuck::cast_slice`), and NaN positions are skipped by the min/max fold. That is the "bounding box that lies about its own buffer" defect `mesh_input.rs:17-19` says was fixed. The `mesh_input.rs:30-31` docs claim the scrub "match[es] what the USD writer already does", which is stale: USD drops. OBJ also does not check `indices.len() % 3` or index < nverts, and OBJ indices are global (`vert_base + tri[k]`), so an out-of-range index silently references the NEXT mesh's vertex.
- Why it matters: the same model can be valid in one format and invalid or missing elements in another. Today `calculate_normals` (geometry/src/csg/normals.rs:80-86) guarantees finite normals, so the from-bytes NaN path needs a non-finite position from the kernel. That makes it latent, but the defence exists in only some writers.
- Fix: one `mesh_input::Renderable` policy: `fn check(mesh: MeshRef) -> Verdict {Ok, Drop(reason)}` covering triangle count, `%3`, normals parity, index range and finiteness, plus one declared non-finite policy (scrub or drop, chosen once with a reason). glTF (both front ends), COLLADA, OBJ and USD call it. `VisibilityFilter` keeps only the user filters (hidden/isolated/types).
- Effort: M

### EXPORT-GEOM-5: material colour key implemented three times in export, already drifted
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/gltf.rs:444-447; rust/export/src/collada.rs:27-30 ("matches the glTF exporter"); rust/export/src/usd/fmt.rs:14-20 (clamped to 0..=100, non-finite -> 0). Related: rust/processing/src/geometry_export.rs:280 (exact-bits key, intentionally different); default grey 0.8 at gltf/from_meshes.rs:168-173, collada.rs:149-154, usd/fmt.rs:30-33 (`linear_color`)
- What: glTF and COLLADA key `(v*100).round() as i32` unclamped. USD clamps to [0,100]. An out-of-gamut IFC colour such as RGB 1.3 gets key 130 in glTF/COLLADA and 100 in USD, so materials merge differently per format. The default fallback colour is hard-coded three times.
- Why it matters: material counts and grouping disagree across formats for the same model. A fourth writer will pick one of the three at random.
- Fix: `crate::color_space::{MaterialKey::from_rgba, DEFAULT_RGBA}` next to `srgba_to_linear`, with the clamp policy decided once (USD needs the clamp for identifier legality; glTF baseColorFactor must be in [0,1] anyway).
- Effort: S

### EXPORT-GEOM-6: number-to-text formatting has one implementation per exporter, with different -0, non-finite and precision rules
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/collada_fmt.rs:32-46 (`{:.4}` trimmed; `-0.00001` -> `"-0"`); rust/export/src/usd/fmt.rs:88-104 (shortest round-trip, non-finite -> `0`); rust/export/src/landxml_terrain.rs:280-289 (`{:.N}` trimmed, `-0` -> `0`); rust/export/src/obj.rs:135,144 (`{:.6}` untrimmed, `-0.000000` possible); rust/export/src/kmz.rs:128-133 (raw `{}`; NaN/inf unvalidated -> `NaN`/`inf` in KML); rust/export/src/collada_document.rs:106-132 (colours raw `{}`); STEP: rust/export/src/step_map_transform_writer.rs:87-93 (`real`, `to_string`, no exponent, `-0.`) vs rust/export/src/step_log/jsval.rs:109-132 (`format_step_real`/`to_step_real`, JS layout, `1.E+21`, `-0.0` -> `0.`, non-finite -> `0.` silently); rust/export/src/model_props.rs:20 (`fmt_num`)
- What: each writer invented trimming, negative-zero and non-finite rules. The two STEP REAL writers disagree: `real(1e21)` gives `"1000000000000000000000."` while `format_step_real(1e21)` gives `"1.E+21"`, and `real(-0.0)` gives `"-0."` while the other gives `"0."`. One refuses non-finite and the other writes `0.`. Both outputs are legal Part 21, but the same mutated value round-trips to different bytes depending on which STEP path wrote it.
- Why it matters: per-format quirks get fixed one at a time (the `-0` in LandXML was fixed and COLLADA/OBJ were not), and KMZ is the one exporter with no finiteness gate on its numeric inputs at all.
- Fix: `crate::num_text` with three explicit, tested functions: `fixed_trimmed(v, decimals) -> Result<String, NonFinite>` (LandXML/COLLADA/OBJ), `shortest(v)` (USD, JSON-ish), `step_real(v)` (one STEP REAL writer; the JS-parity layout lives here because step_log needs it). Each documents its -0 and non-finite rule. Use `std::fmt::Write` into the target buffer to drop the per-float `String` allocation (see EXPORT-GEOM-12).
- Effort: M

### EXPORT-GEOM-7: identifier/name helpers duplicated across USD, IFC5, HBJSON and LandXML
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/usd/fmt.rs:38-65 (`map_ident_chars`, `sanitize_ident`, `prim_name`); rust/export/src/ifc5.rs:88-99 (`prim_name`, byte-for-byte the same algorithm, written inline); rust/export/src/lib.rs:146-152 (`sanitize_identifier`, keeps Unicode alphanumerics and `-`, unlike the USD one); unique-name allocators rust/export/src/usd/fmt.rs:113-141 (`Namer`, `base_2`) and rust/export/src/landxml_terrain.rs:293-306 (`unique_names`, `name (2)`)
- What: the IFC5 and USD `prim_name` are the same function twice: `p_` prefix, `[A-Za-z0-9_]` map, `_id` suffix. The IFC5 copy also does `out.chars().next().unwrap()` guarded only by the `is_empty()` short-circuit, which is fine but needlessly fragile.
- Why it matters: IFCX children keys and USD prim names are meant to agree (IFCX is USD-flavoured). A fix to one (e.g. reserved words) will not reach the other.
- Fix: `crate::ident` with `sanitize(s, allowed, fallback_prefix)`, `prim_name`, and a generic `UniqueNames<F: Fn(&str, n) -> String>`. IFC5 imports USD's `prim_name`.
- Effort: S

### EXPORT-GEOM-8: from-meshes flat-array slicing, validation and defaulting written twice with drifted contracts
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/gltf/from_meshes.rs:38-104 (u64 sum checks up front) and 155-194 (slicing loop); rust/export/src/collada.rs:106-166 (per-mesh u64 check + identical slicing/defaulting loop; jscpd collada.rs:148-161 <-> gltf/from_meshes.rs:167-179)
- What: both walk `vertex_counts`/`index_counts` with running `vbase`/`ibase`, slice positions/normals/indices, and default colour (0.8 grey, alpha 1) and origin (0). They disagree on normals: glTF refuses `normals` shorter than `3*sum(vertex_counts)` (`MalformedMeshInput`), while COLLADA silently substitutes `[0,0,1]` per vertex for a short buffer. The same viewer payload therefore exports to KMZ with flat-up normals and is refused as GLB.
- Why it matters: #4684 already had to align these two by hand. The contract lives in two loops and one shared helper (`check_index_block`) that covers only part of it.
- Fix: a `mesh_input::FlatMeshes<'a> { positions, normals, indices, vertex_counts, index_counts, colors, origins }` with `fn validate(&self) -> Result<(), ExportError>` and `fn iter(&self) -> impl Iterator<Item = FlatMesh<'a>>` (slices, colour, origin already defaulted), owned by mesh_input.rs next to `scrub_nonfinite`. This also replaces the 7- to 11-positional-slice signatures behind `#[allow(clippy::too_many_arguments)]` (EXPORT-GEOM-13).
- Effort: M

### EXPORT-GEOM-9: `export_gltf_streaming` returns a schema-invalid empty glTF instead of failing closed
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/gltf.rs:1672-1908 (`export_gltf_streaming*` return `Vec<u8>`, never call `refuse_empty`); compare 1633-1639 and 2077 (`refuse_empty` on both GLB assemblers, #4685) and rust/export/src/error.rs:14-22
- What: every GLB and COLLADA entry point refuses a zero-mesh model with `ExportError::NoRenderGeometry`, because "an empty GLB has empty accessors/bufferViews/meshes/nodes (minItems: 1)". The multi-buffer glTF path builds the same `Gltf` with `meshes: []`, `scenes[0].nodes: []` and `buffers: []` and returns it as success. The size-projection API (`project_glb_size*`) recommends this path for models that are too big, so a large model whose meshes are all filtered out (e.g. `isolated: Some(vec![])`) gets an invalid artifact.
- Why it matters: it is the same failure #4685 removed from the GLB paths, and it survives on the one public path the fix did not touch. Note that none of `export_gltf_streaming*`, `project_glb_size*` or `try_export_glb_streaming_bounded*` has an in-repo caller outside tests (they are published API per scripts/rust-api-surface.json).
- Fix: change the return type to `Result<Vec<u8>, ExportError>` and call `refuse_empty(&stats)` before serialising. This is a semver-breaking change to the published crate, so batch it with the EXPORT-GEOM-2 refactor.
- Effort: S

### EXPORT-GEOM-10: gltf.rs is a 3,090-line god file and its ratchet budget has 938 lines of slack
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/gltf.rs (3,090 lines; `plan_bounded_glb` 2139-2777 is about 640 lines, `build_gltf` 1119-1495 about 380, `export_gltf_streaming_impl` about 210); rust/processing/tests/module_size_allowlist.txt (`4028 rust/export/src/gltf.rs`; also `420 rust/export/src/merged/mod.rs` vs 414 actual); inline test module gltf.rs:2994-3090 counted against the production budget
- What: the ratchet fails only when a file exceeds its recorded budget. gltf.rs shrank by about 900 lines as submodules were split out, but the budget was never lowered, so the file can regrow by 938 lines with a green gate. The inline `site_placement_tests` module (97 lines) also lives in the production file, while every other glTF test module is `#[path]`-split.
- Why it matters: the "existing debt is frozen" guarantee in module_size_ratchet.rs:9-17 does not hold for the largest export file. A 640-line function is unreviewable as a unit.
- Fix: lower the budgets to the measured counts (and add a "budget > actual + N" check so slack cannot accumulate). Move `site_placement_tests` to gltf_tests.rs. Splitting along EXPORT-GEOM-2's layout/doc/scan lines brings every piece under 400.
- Effort: S (ratchet) / L (split)

### EXPORT-GEOM-11: three different instancing implementations feed three writers
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/gltf.rs:1193-1243 (in-memory: `collate_refs_in_basis` + #3666 reconstruction check); rust/export/src/gltf.rs:2296-2400 (bounded: own rep-identity bucketing, no reconstruction check, documented KNOWN GAP); rust/export/src/usd/instance.rs:34-118 (processing `InstanceRecord`, don't-bake #1623 pass, its own safety gate, f32 transforms)
- What: each writer decides "which occurrences share a template and where each one goes" differently. glTF uses `InstanceMeta` (f64) with a basis conjugation. USD uses `InstanceRecord.transform` (f32, post-RTC) and re-runs the whole pipeline when unsafe (`gather` can mesh the model twice). The bounded glTF path documents a correctness gap vs the in-memory one (`unverified_instance_groups`).
- Why it matters: instancing correctness bugs (#3666 collisions, #4118 site yaw) must be fixed per writer. USD inherits neither guard.
- Fix: one export-side `InstancePlan` (template id, occurrences with f64 world placement in a declared frame, verified flag) built either from collated refs or streamed metadata. Writers only serialise it. Longer term, `produce_element_meshes`'s instancing output should be the single source.
- Effort: L

### EXPORT-GEOM-12: per-float `String` allocation in the text writers (USD, COLLADA, STEP escape)
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/usd/fmt.rs:88-104 (`fmt_f32`/`fmt_f64` return `String`), used per coordinate at rust/export/src/usd/emit.rs:163-181 (and the four temporary `String`s pts/nrm/counts/idx are copied again into `out`); rust/export/src/collada_fmt.rs:24-46 (`write!(s, "{}", fmt_f32(*v))` allocates then copies); rust/export/src/step_text.rs:84-87 (`push_str(&format!(..))` per non-ASCII char); rust/export/src/collada.rs:100,104 (std SipHash `HashMap` for the per-vertex dedup in a crate that already depends on `rustc_hash`)
- What: a 5M-vertex model is 30M+ heap allocations just to format floats, and USD holds every mesh's text twice.
- Why it matters: export wall time and peak memory on the large models the bounded GLB path was built for. USD/COLLADA have no bounded alternative.
- Fix: write directly with `write!(out, "{v}")` / `{v:.4}` into the destination buffer (trim in place). Build USD arrays straight into `out`. Use `FxHashMap` for COLLADA dedup/remap. Part of EXPORT-GEOM-6's `num_text` API.
- Effort: S

### EXPORT-GEOM-13: from-meshes public API is 7-11 positional slices plus a boolean trio
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/gltf/from_meshes.rs:22-35, 118-134 (`#[allow(clippy::too_many_arguments)]`, `include_metadata: bool, lit: bool, emissive: bool`); rust/export/src/collada.rs:69-79; rust/export/src/kmz.rs:147-157; rust/export/src/gltf.rs:631-642, 745-755, 1118-1130 (internal ones with the same allow)
- What: callers pass `..., &[1], false, true, false` (mesh_input.rs:240-242). The parallel-array contract (counts vs buffers) is the source of every #4684-class bug.
- Fix: take `&FlatMeshes` (EXPORT-GEOM-8) plus a `GltfMaterialOptions { lit, emissive }` / reuse `GltfOptions`. The `#[allow]`s then go away.
- Effort: S

### EXPORT-GEOM-14: infallible `export_glb_from_meshes` is public, wraps on wasm32, and ships truncated output as success
- Category: Bug
- Severity: Low
- Confidence: CONFIRMED (for direct callers)
- Where: rust/export/src/gltf/from_meshes.rs:122-160 (`(vbase + vc) * 3 > positions.len()` in `usize`, then slices); rust/export/src/lib.rs:84-90 (re-exported)
- What: the `try_` twin computes in `u64` precisely because "on wasm32 an absurd u32 count times 3 wraps usize". The infallible variant still does the `usize` arithmetic. A huge `vertex_counts[i]` wraps, the check passes, and `&positions[vbase*3..(vbase+vc)*3]` panics on start > end, which is an abort under panic=abort. On non-wrapping bad input it `break`s and returns a truncated GLB "successfully", which is exactly what its own doc warns about. In-repo callers: only tests and the try_ wrapper.
- Fix: make it `pub(crate)` (or delete it and inline into the try_ path). It is a semver break, so pair with EXPORT-GEOM-9.
- Effort: S

### EXPORT-GEOM-15: USD/OBJ export never fail closed on an empty model and re-parse the file several times
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/usd.rs:60-234 (`instance::gather` (1-2 full meshing passes) + `build_export_model(content)` + `spatial_children(content)` (relationships pass) + `project_name` (`decode_one` linear scan)); rust/export/src/obj.rs:97-171
- What: glTF/COLLADA/KMZ return `NoRenderGeometry` for zero meshes. USD returns a `World`-only stage and OBJ a header-only file, both as `String` (no `Result`). USD makes up to four independent passes over the same bytes (two meshing passes when the instancing gate fails), with no shared `EntityIndex` (glTF's `*_with_index` variants exist for exactly this).
- Fix: route both through the shared pipeline core (see Shared export-pipeline core below): one `ExportSource` (bytes + lazily built `Arc<EntityIndex>` + `ProcessingResult` + `ExportModel`) passed to each writer, and the one `refuse_empty` rule.
- Effort: M

### EXPORT-GEOM-16: KMZ numeric inputs are not validated
- Category: Bug
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/kmz.rs:94-135 (`lon = opts.longitude`, `lat`, `alt`, `heading` via `{}`)
- What: `KmzOptions.longitude/latitude/altitude` come over the wasm FFI (rust/wasm-bindings/src/api/export_glb.rs:175-191) and are formatted with Rust `Display`. NaN writes `NaN` and infinity writes `inf`, which is not even an xs:double lexical form (`INF`). Out-of-range latitude (|lat| > 90) passes too. Every other part of the KMZ path fails closed (`ZIP32` layout, empty COLLADA).
- Fix: validate in `try_export_kmz_collada_from_meshes` (finite, |lat|<=90, |lon|<=180) and return `ExportError::MalformedMeshInput`/a new variant. Format through `num_text`.
- Effort: S

### EXPORT-GEOM-17: two hand-rolled ZIP writers (KMZ stored-ZIP + `zip` crate for .bos) and a hand-rolled CRC32
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/kmz.rs:270-355 (`StoredZip`, `crc32`); rust/export/src/parquet_bos.rs (uses `zip` crate behind `parquet-bos`); rust/core/src/generated/*/schema.rs `crc32_hash` (string CRC, separate)
- What: the KMZ writer is justified ("avoids a zip/deflate crate dependency in the default/wasm build"), which is a legitimate reason. But the crate now carries two ZIP implementations with different ZIP64/limit behaviour, and the bitwise CRC loop is about 8x slower than a table-driven one on a large .dae.
- Fix: keep StoredZip but give it a 256-entry CRC table (or `crc32fast`, pure Rust, wasm-safe), and document in Cargo.toml why `zip` is not used for KMZ. Low priority.
- Effort: S

### EXPORT-GEOM-18: glTF test/inspection helpers copy-pasted across seven files
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where (GLB container split): rust/export/src/gltf_tests.rs:15-44 (`parse_glb`), rust/export/src/gltf_conformance_tests.rs:75-111 (`split_glb_checked`), rust/export/src/gltf.rs:3052-3055 (`glb_json`), rust/export/src/usd/tests.rs:905, rust/export/tests/nonfinite_mesh_input.rs:52,180,240,275 (inline four times), rust/export/examples/world_check.rs:15-31. Node composition / matrix helpers: gltf_tests.rs:318-355 (`mat_mul`, `transform_point`, `node_local`) and examples/world_check.rs:33-70 (`mat_mul`, `apply`, `ID`, `node_local`). Accessor decoding: gltf_tests.rs:356-386, 2107-2160 vs gltf_conformance_tests.rs:33-74 (`component_size`, `type_components`, `read_component`). Per-test `view` builders: gltf_tests.rs:2336, 2462, 2760
- What: at least seven GLB readers and three node-world composers, each slightly different (some assert chunk tags, some don't; world_check walks all chunks).
- Why it matters: a GLB layout change (padding, chunk order) needs seven test edits, and a lenient copy can hide a regression the strict copy would catch.
- Fix: a `#[cfg(test)] pub(crate) mod gltf_read` (in test_support.rs or `gltf/test_read.rs`) with `split_glb`, `accessor_values`, `world_triangles`. Integration tests and examples reach it through a `tests/common/mod.rs` that `include!`s the same file (or a tiny dev-only `[[example]]`-shared module).
- Effort: S

### EXPORT-GEOM-19: STEP-file wrapper and MeshData literal fixtures duplicated across test files
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where (identical `HEADER;..FILE_SCHEMA(('IFC4'))..DATA;{entities}ENDSEC;` wrappers): rust/export/src/merged/empty_claims_tests.rs:10, rust/export/src/merged/empty_tests.rs:39-47, rust/export/tests/issue_4660_merged_keyword_case.rs:22; (identical `FILE_DESCRIPTION..{lines.join}`): rust/export/tests/merged_single_parent_parity.rs:48 == rust/export/tests/merged_single_inverses.rs:17; variants: rust/export/src/schema_convert_tests.rs:315, rust/export/tests/issue_5365_enum_reconciliation.rs:11, rust/export/tests/issue_5307_ifc4_required_slots.rs:12, rust/export/tests/source_header_comments.rs:28 (381 `ISO-10303-21;` literals across export tests). MeshData literals with all 20 fields: rust/export/src/obj_tests.rs:251-273 == rust/export/src/usd/tests.rs:422-443 (jscpd), rust/export/src/gltf_tests.rs:1595, rust/export/src/parquet_bos_tests.rs:66. Flat-array one-triangle fixtures: rust/export/src/mesh_input.rs:233-249, rust/export/src/collada_tests.rs:9-18 (`MeshArrays` 7-tuple), rust/export/tests/nonfinite_mesh_input.rs:27. Cross-crate: rust/export/tests/issue_4118_site_rotation_instancing.rs:27-99 <-> rust/processing/tests/site_local_instancing.rs:31-102 (73 lines). Vector-file loaders: rust/export/tests/csv_cell_parity.rs:55-73 <-> rust/export/tests/step_escape_parity.rs:15-34
- What: test_support.rs (rust/export/src/test_support.rs) only provides the fixture-file loader. There is no STEP builder, no MeshData builder and no `tests/common/`.
- Why it matters: a new required MeshData field touches four literals. The `FILE_DESCRIPTION`-less wrappers silently test a header shape real files never have.
- Fix: add `test_support::{step_file(schema, data), mesh_data(id, positions, indices) -> MeshData}` (`..` from one builder) and a `tests/common/mod.rs` with the same plus `load_vectors(name)`. Consider `impl Default for MeshData` behind a `test-util` feature in processing so both crates share it.
- Effort: S

### EXPORT-GEOM-20: header/provenance strings differ per writer
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/gltf.rs:1443 (`generator: "IFC-Lite"`, no version); rust/export/src/collada_document.rs:93 (`authoring_tool IFC-Lite`, epoch timestamps); rust/export/src/usd/emit.rs:326 (`"ifc-lite {CARGO_PKG_VERSION}"` + FNV source fingerprint); rust/export/src/landxml_terrain.rs:213 (`Application name="ifc-lite" version=..`); rust/export/src/obj.rs:104 (`# ifc-lite OBJ export`)
- What: five spellings of the generator, version present in two, a source fingerprint in one.
- Fix: `crate::provenance::{GENERATOR_NAME, generator_with_version(), source_fingerprint(content)}`. Move the FNV fingerprint out of usd/emit.rs so glTF `asset.extras` and COLLADA `<asset>` can carry the same lineage.
- Effort: S

## Findings: STEP writer / log (EXPORT-STEP-1..29)
Full sub-review: [07a-export-step-writer.md](07a-export-step-writer.md) (29 findings).

## Findings: merged / schema / generated / step_map (EXPORT-MERGE-1..22)
Full sub-review: [07b-export-merge-schema.md](07b-export-merge-schema.md) (22 findings).

## Findings: model / data / energy exporters (EXPORT-DATA-1..28)
Full sub-review: [07c-export-data-model.md](07c-export-data-model.md) (28 findings).

## Concept inventory (GEOM slice; STEP/MERGE/DATA inventories are in their sub-reviews)
**Vector/matrix math**
- `mat4_mul` (row-major) rust/export/src/gltf/matrix.rs:54
- `affine_inverse` rust/export/src/gltf/matrix.rs:160 (det < 1e-18, no NaN check)
- `mat4_translation` rust/export/src/gltf/matrix.rs:137
- `row_major_f64_to_col_major_f32` rust/export/src/gltf/matrix.rs:147
- `IDENTITY16` rust/export/src/gltf/matrix.rs:47
- `quaternion_from_column_major` rust/export/src/gltf.rs:1094
- test/example copies: rust/export/src/gltf_tests.rs:318 (`mat_mul`), :327 (`transform_point`); rust/export/examples/world_check.rs:33 (`mat_mul`), :44 (`apply`)
- `dot` / `center` rust/export/src/geom.rs:222-231
- `degenerate` (cross product == 0) rust/export/src/landxml_terrain.rs:269

**Transforms/placements/frames**
- `yup_f32` / `yup_f64` rust/export/src/frame.rs:20,26
- `yup_matrix4` (column-major conjugation) rust/export/src/frame.rs:40
- `to_yup_into` / `to_yup_in_place` / `YUpScratch` rust/export/src/frame.rs:76-133
- `S_YUP` / `S_YUP_INV` rust/export/src/gltf/matrix.rs:33-45
- `baked_basis_yup` (+ `_inverse`) rust/export/src/gltf/matrix.rs:100,120
- `compose_world_meta` rust/export/src/gltf/matrix.rs:198 (mirrors geometry/src/instancing/collate.rs:17)
- `occurrence_node_matrix[_composed]` rust/export/src/gltf/matrix.rs:209,235
- `site_restore` / `scene_root` rust/export/src/gltf.rs:1034,1057
- `to_zup` rust/export/src/collada.rs:34
- `zup` / `xf` (column-major f32 profile transform) rust/export/src/geom.rs:12,17
- `usd_transform_rows` rust/export/src/usd/instance.rs:137
- `MapFrame::to_map_metres` rust/export/src/landxml_terrain_georef.rs:35
- inline column-major placement apply rust/export/src/landxml_terrain_tin.rs:45-53

**Tolerances/epsilons**
- `1e-9` root-translation/rotation-identity cutoffs rust/export/src/gltf.rs:1067,1075,1088,1301
- `1e-18` det rust/export/src/gltf/matrix.rs:166
- `1e-12` quaternion norm rust/export/src/gltf.rs:1113
- `1e-6` affine bottom row rust/export/src/usd/instance.rs:120-126
- `AREA_EPS = 1e-4` rust/export/src/geom.rs:9
- vertex-dedup quantum 1e-4 m / normal 1e-3 rust/export/src/collada.rs:45-48
- colour key 1e-2 rust/export/src/gltf.rs:444, collada.rs:27, usd/fmt.rs:14
- unit-ratio `1e-12` rust/export/src/landxml_terrain_georef.rs:117

**Unit conversion**
- `LandXmlLinearUnit::{horizontal,elevation}_metres` rust/export/src/landxml_terrain.rs:49-63
- `project_length_metres` / `length_unit_metres` rust/export/src/landxml_terrain_georef.rs:135,152 (on core `try_si_prefix_multiplier` / `get_conversion_based_unit_factor`)
- USD/glTF/OBJ assume `process_geometry` metres (documented at usd.rs:9-11)

**BBox/AABB**
- world AABB folds rust/export/src/gltf.rs:1135, 1745, 2236
- per-mesh quantization bbox rust/export/src/gltf.rs:763, 2449
- accessor min/max rust/export/src/gltf.rs:656-672
- USD extent rust/export/src/usd/emit.rs:161-167
- COLLADA XY re-centre rust/export/src/collada.rs:233-250
- LandXML elev min/max rust/export/src/landxml_terrain.rs:254
- `glb_container_size` rust/export/src/gltf.rs:1976

**Hashing**
- `geom_color_key` (XXH3-128) rust/export/src/gltf.rs:491
- `vert_key` (quantised i64 dedup) rust/export/src/collada.rs:45
- `source_fingerprint` (FNV-1a-64) rust/export/src/usd/emit.rs:337
- `crc32` (bitwise) rust/export/src/kmz.rs:345
- `uuid_from_id` (multiplicative) rust/export/src/ifc5.rs:61
- processing exact-bit colour key rust/processing/src/geometry_export.rs:280

**Triangulation/polygon ops**
- `newell_normal` / `polygon_area` / `is_simple_polygon` / `is_watertight` / `clean_ring` / `face_ok` rust/export/src/geom.rs:33-220
- `signed_area_2d` rust/export/src/dfjson/plates.rs:128
- `check_index_block[s]` rust/export/src/mesh_input.rs:150,177
- LandXML `faces` / `one_based` rust/export/src/landxml_terrain_tin.rs:125,142

**Entity attribute access/decoding**
- `ifc5::decode_one` (linear scan) rust/export/src/ifc5.rs:118
- `ifc5::project_name` rust/export/src/ifc5.rs:131
- `ifc5::spatial_children` rust/export/src/ifc5.rs:106 (shim over `relationships`)
- `georef::decode` / `georef::text` rust/export/src/landxml_terrain_georef.rs:126,131
- `ModelFacts::scan` rust/export/src/landxml_terrain_georef.rs:51
- `face_set` / `vertices` rust/export/src/landxml_terrain_tin.rs:68,101

**Colour/style resolution**
- `srgba_to_linear` rust/export/src/color_space.rs:29
- `make_material` rust/export/src/gltf.rs:454
- `color_key` x3 (gltf.rs:444, collada.rs:27, usd/fmt.rs:14)
- `linear_color` + `mat_name` rust/export/src/usd/fmt.rs:24-34
- `scrub_colors` (alpha -> 1) rust/export/src/mesh_input.rs:84
- COLLADA emission/transparency rust/export/src/collada_document.rs:103-145

**Escaping/number text**
- `xml_text::escape` rust/export/src/xml_text.rs:10
- `usd::fmt::escape_str` rust/export/src/usd/fmt.rs:70
- `step_text::escape` rust/export/src/step_text.rs:71
- `collada_fmt::fmt_f32` rust/export/src/collada_fmt.rs:32
- `usd::fmt::fmt_f32` / `fmt_f64` rust/export/src/usd/fmt.rs:89,98
- `landxml_terrain::number` rust/export/src/landxml_terrain.rs:280
- `step_map_transform_writer::real` rust/export/src/step_map_transform_writer.rs:87
- `step_log::jsval::{js_number_to_string, format_step_real, to_step_real}` rust/export/src/step_log/jsval.rs:69,109,126
- `model_props::fmt_num` rust/export/src/model_props.rs:20

**Error types**
- `ExportError` rust/export/src/error.rs:13
- `LandXmlTerrainRefusal` rust/export/src/landxml_terrain.rs:137 (wraps internal `Result<_, String>`)
- `zip32_error` -> `ExportError::Serialization` rust/export/src/kmz.rs:174
- infallible `String`/`Vec<u8>` returns: `export_usd`, `export_obj`, `export_gltf_streaming`, `export_glb_from_meshes`
- `assert!`/`expect` invariants: GLB 4 GiB rust/export/src/gltf.rs:573, 2956; bounded-pass determinism 2820-2856, 2929
