I found 28 issues in the slice, numbered EXPORT-DATA-1 to 28 below, plus the concept inventory at the end. Everything was found by reading code only; no cargo was run and no files were edited. The headline bug is a property-set drop in the main export path. Next come a DFJSON storey-ordering bug and three HBJSON/DFJSON output-validity issues: duplicate room identifiers, identifiers that break Honeybee's naming rules, and f32 precision loss in survey coordinates.

The jscpd clones and the two already-known items (`prim_name`, `zup`) are only cited where they belong to a larger concept.

### EXPORT-DATA-1: `RelatingPropertyDefinition` parsed three ways; the main export drops `IfcPropertySetDefinitionSet` entirely
- Category: DRY + Bug
- Severity: High
- Confidence: CONFIRMED
- Where:
  - rust/export/src/model.rs:194-197 (`rel.get(5).and_then(|a| a.as_entity_ref())`, then `continue`)
  - rust/export/src/quantity_analysis_relations.rs:13-31 (`property_definition_refs`: handles both the bare `(#a,#b)` list and the `IFCPROPERTYSETDEFINITIONSET((…))` wrapper)
  - rust/processing/src/processor/properties.rs:64-96 (`get_refs(5)`)
  - apps/server/src/services/data_model/relationships.rs:142-146 (`get_refs`)
  - rust/core/src/schema_gen.rs:336-343 (`get_refs`: bare list only; it yields `None` for the typed wrapper)
- What: IFC4 allows `#22=IFCRELDEFINESBYPROPERTIES(…,(#5),(#21,#23))` or `…,IFCPROPERTYSETDEFINITIONSET((#21,#23)))`. Pass 1 in model.rs only accepts a bare ref, so the whole relationship is skipped. Processing and the server fixed the bare-list case in #4773 but still miss the typed wrapper. Only `quantity_analysis_relations` handles both, and only its tests cover the case (quantity_analysis_tests.rs:390).
- Why it matters: every row from CSV, JSON, JSON-LD, IFCX, Parquet and the Python binding silently loses all psets/qsets attached that way. The opt-in quantity analysis does report them for the same file, so the two outputs disagree.
- Fix: move `property_definition_refs` into core as `DecodedEntity::relating_definition_refs()` (or teach `get_refs` the typed-wrapper form). Call it from model.rs, quantity_analysis_relations, processing and the server, and add a model_tests case for both shapes.
- Effort: S

### EXPORT-DATA-2: Property-value decoding exists twice and has drifted (kinds supported, enum and ref rendering)
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/export/src/model_props.rs:40-59 (`render_value`), 152-170 (`decode_property_set`: SingleValue only)
  - rust/processing/src/processor/properties.rs:112-129 (`attribute_value_to_string`), 131-160 (`extract_property_name_and_value`: Single, Enumerated, List, Bounded, Reference)
  - rust/core/src/georef_pset.rs:85-90 (hand-walks `HasProperties` index 4)
- What: export renders `.T.` as `"true"`; processing gives `"T"`. Processing renders refs as `"#id"`; export drops them. Lists are joined with `"; "` in processing and dropped in export. Export ignores `IfcPropertyEnumeratedValue`, ListValue and BoundedValue (comment: "P-next"), although a working decoder exists one crate down.
- Why it matters: the same `IfcSpace` pset reads differently in viewer properties (`MeshData.properties`) and in CSV/JSON. Enumerated psets such as Pset_*Common `Status` and Revit enumerations never appear in any tabular export.
- Fix: one property decoder in processing (or core) that returns a typed value plus its type tag. `model_props` consumes it, and processing renders its strings from it.
- Effort: M

### EXPORT-DATA-3: `IfcRelDefinesByType` is resolved four times with three different conflict policies
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/export/src/model.rs:214-245 (`or_insert`: first wins)
  - rust/export/src/relationships.rs:87-99 (`out.type_of.insert`: last wins)
  - rust/export/src/quantity_analysis_relations.rs:101-115 (a conflict removes the type entirely)
  - rust/export/src/rebar_schedule_build.rs:49-81, 109-127 (first valid wins, with a diagnostic)
- What: a file that types one object twice gets a different type from each API.
- Why it matters: the public `relationships().type_of` reports type B for an occurrence while `inherit_type_properties` merges type A's psets into the same row. A consumer joining the two sees mismatched data.
- Fix: one scan in `relationships.rs` that returns occurrence to type with an explicit policy (first wins, matching TS) plus a conflict list. model.rs pass 1 and rebar consume it; quantity analysis reads the conflict list.
- Effort: M

### EXPORT-DATA-4: DFJSON story order mixes unscaled absolute `Elevation` with rebased metric floor heights
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/export/src/dfjson/spatial.rs:113 (`row.get(ATTR_ELEVATION).and_then(|a| a.as_float())`, file units, not scaled)
  - rust/export/src/dfjson/stories.rs:59-91 (sort key `a.0.unwrap_or(a.1)`)
  - rust/export/src/dfjson/mod.rs:106-110 (re-sorts the first bucket by geometric `floor_height` only)
- What: the sort key is the declared `Elevation` (file units, absolute) when present. Otherwise it is `min_floor` (metres, rebased to the lowest space). Loose clusters always use the second.
- Failure input: a millimetre file with storeys at Elevation 0 / 3000 / 6000 plus one uncontained space at 3 m gets order 0, 3.0 (loose), 3000, 6000. Even in metres, with a basement at -3.5, a loose ground-floor cluster has rebased key 3.5 and sorts above "Level 2" (3.0). `is_ground_contact`, `is_top_exposed` and `floor_to_floor_height` are then assigned to the wrong stories. Separately, mod.rs:106 re-orders by a different key whenever orphans exist.
- Why it matters: the comment at spatial.rs:40-44 ("used only to ORDER stories") only holds if every key comes from the same frame, and they don't.
- Fix: sort only by geometric `min_floor`, using declared elevation as a tie-break. Alternatively scale it by the length unit and rebase it with the same origin. Use one comparator in both places.
- Effort: S

### EXPORT-DATA-5: An `IfcSpace` with more than one extruded item gives duplicate HBJSON/DFJSON identifiers
- Category: Bug
- Severity: Medium
- Confidence: LIKELY
- Where:
  - rust/export/src/rooms.rs:174, 177 (`format!("R{}", fp.express_id)`, `R{id}_F{fi}`)
  - rust/export/src/dfjson/stories.rs:148
  - rust/export/src/lib.rs:221 (`spaces` counts profiles)
  - Source: rust/geometry/src/profile_extractor.rs:150-190 (pushes one profile per extruded item)
- What: an L-shaped space modelled as two `IfcExtrudedAreaSolid` items yields two `FloorProfile`s with the same `express_id`. That produces two `Room`s named `R{id}` with identical face ids. `dedupe_colliding` only drops near-identical copies, so both survive. `HbjsonStats.spaces` / `DfjsonStats.spaces` also over-count, which breaks the documented `spaces == rooms + skipped` invariant.
- Why it matters: Honeybee/Dragonfly reject models with duplicate identifiers (duplicate-room check), so the whole export fails to load.
- Fix: group profiles by `express_id` first. Either skip multi-item spaces with a reason, or suffix the ids (`R{id}_{k}`) and count spaces by distinct id.
- Effort: S

### EXPORT-DATA-6: HBJSON/DFJSON coordinates already passed through f32; the "rebase keeps survey precision" comment is wrong
- Category: Bug (stale justification)
- Severity: Medium
- Confidence: LIKELY
- Where:
  - rust/export/src/rooms.rs:8-9 (doc), 45-55 (origin)
  - rust/export/src/geom.rs:17-24 (`xf` reads `t[12..14]` from `[f32; 16]`)
  - rust/geometry/src/profile_extractor.rs:68 (`transform: [f32; 16]`, no RTC)
  - Also openings.rs:32 and shades.rs:44
- What: the world translation is stored in f32 before export sees it. At LV95 magnitudes (E about 2.6e6) the f32 step is 0.25 m. Rebasing in f64 afterwards cannot recover that, and the JSON output is f64 anyway. The origin is then thrown away (`_origin` in dfjson/plates.rs:68), so no georeference survives.
- Why it matters: each space, window and railing is shifted rigidly by up to about 0.125 m relative to the others. That is the same order as `MAX_LATERAL = 0.15` (adjacency.rs) and the opening placement windows, so on national-grid models adjacencies go unmatched and windows are misplaced. rust/AGENTS.md's RTC note applies directly here.
- Fix: add an f64 translation (or an RTC offset) to `ExtractedProfile`, or call `extract_profiles` after setting an RTC offset. Correct the rooms.rs comment and consider emitting the origin.
- Effort: M

### EXPORT-DATA-7: Two Honeybee identifier sanitizers, drifted from each other and from honeybee-schema
- Category: DRY + Bug
- Severity: Medium
- Confidence: LIKELY
- Where:
  - rust/export/src/lib.rs:164-170 (`sanitize_identifier`: `is_alphanumeric() || '_' || '-'`, fallback "model")
  - rust/export/src/constructions.rs:43-46 (`sanitize`: `is_alphanumeric()` only, fallback "Material")
  - Related: ifc5.rs:88-99 `prim_name` (known)
- What: both use Unicode `is_alphanumeric`, neither caps length, and they differ on `-`. honeybee-schema `IDdBaseModel.identifier` requires `^[.A-Za-z0-9_-]+$` with max length 100; energy objects allow max length 100.
- Failure input: `HbjsonOptions { name: "Bürogebäude" }` gives a Model identifier containing `ü`/`ä`, and a 120-character material name gives an identifier over 100 characters. Both fail `Model.from_hbjson` validation.
- Why it matters: valid IFC input produces an HBJSON file Honeybee refuses to load.
- Fix: one `ladybug_identifier(s, fallback)` in a small shared module (ASCII `[A-Za-z0-9_.-]`, truncated to 100) used by lib.rs (HBJSON and DFJSON) and constructions.rs.
- Effort: S

### EXPORT-DATA-8: The JSON number allowlist misses most IFC measure types, so numbers become strings
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/export/src/json.rs:40-54 (`typed_value`, an 11-tag allowlist)
  - Consumers: jsonld.rs:89 and ifc5.rs:153
- What: `IFCPROPERTYSINGLEVALUE('ThermalTransmittance',$,IFCTHERMALTRANSMITTANCEMEASURE(0.24),$)` is emitted as `"value":"0.24"`. The same happens for `IFCPLANEANGLEMEASURE`, `IFCPOWERMEASURE`, `IFCPOSITIVERATIOMEASURE`, `IFCTIMEMEASURE`, `IFCMONETARYMEASURE` and more. The numeric/boolean information is lost when `render_value` flattens to a String, and has to be guessed back from the tag.
- Why it matters: it breaks the "numbers stay numbers" contract (json.rs:2-4) for common Pset_*Common values, so consumers get mixed string/number types for the same property across files.
- Fix: carry the primitive kind on `PropValue` (an enum such as `Number`/`Bool`/`Text`) set in `render_value` from the `AttributeValue` variant, and drop the tag allowlist.
- Effort: S

### EXPORT-DATA-9: Unit scales come from three different resolvers, with mixed units in single outputs
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/export/src/model.rs:293 (`resolve_unit_scales`, documented as "the only sanctioned place that hunts for IFCPROJECT")
  - rust/export/src/constructions.rs:117 and rust/export/src/rebar_schedule_build.rs:18 (`decoder.length_unit_scale()`: its own O(file) IFCPROJECT scan, silent fallback to 1.0)
  - rust/export/src/rebar_schedule_build.rs:85-87 and rust/export/src/quantity_analysis.rs:281 (`ProjectUnits::resolve`)
  - rust/export/src/quantity_analysis_derived.rs:164-204 (swept-disk quantities in `"m"`, extrusion quantities in `"ifc_file_length_units"` within one product)
  - rust/export/src/dfjson/spatial.rs:113 (Elevation unscaled; see #4)
- What: the rebar schedule takes its length scale from one resolver, which silently falls back to 1.0, and its area scale from another, which reports a diagnostic when unresolved.
- Why it matters: an unresolved length unit yields bar lengths in mm labelled as m with no diagnostic, while the area path in the same function refuses. It also adds extra full-file scans.
- Fix: use `ProjectUnits` everywhere: `unit_for_measure("IfcLengthMeasure")` for length, and the `UnitScales` already resolved in model.rs. Drop `length_unit_scale()` from exporters.
- Effort: M

### EXPORT-DATA-10: Duplicate-space dedupe cloned between HBJSON and DFJSON with literal thresholds
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/export/src/rooms.rs:188-247 (`Sig`, `room_signature`, `is_duplicate`, `dedupe_colliding`)
  - rust/export/src/dfjson/plates.rs:139-203 (same four items; jscpd only flagged 188-201 vs 232-245)
- What: `0.3`, `0.3` and `0.05` are repeated literally. The doc comments say the two are "deliberately the SAME thresholds", which is enforced only by comments. The two signature functions already differ: one uses the area of the 3D Newell polygon, the other the 2D shoelace area.
- Why it matters: a one-sided tweak makes HBJSON and DFJSON disagree on room counts for the same file, which is exactly what dfjson/mod.rs:27-30 promises won't happen.
- Fix: a generic `dedupe::dedupe_by_signature<T>(items, sig: Fn(&T)->Option<Sig>)` with named `DUP_CENTROID_M` / `DUP_AREA_FRAC` constants in geom.rs (or a new `dedupe.rs`).
- Effort: S

### EXPORT-DATA-11: Profile-to-ring, extrusion and vector helpers re-implemented across the energy exporters
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Ring from profile (`xf` over `outer_points`, minus origin): rooms.rs:47-55, 78-83; openings.rs:25-37; shades.rs:36-47
  - Extrude (`p + dir*depth`): rooms.rs:111-114; dfjson/plates.rs:94-103; openings.rs:34; shades.rs:58-60
  - `avg_z` closure: rooms.rs:119; dfjson/plates.rs:85
  - `sub`: openings.rs:18 and adjacency.rs:24
  - `norm` (openings.rs:19-22) duplicates the normalisation inside `geom::newell_normal` (geom.rs:61-65)
  - `dist`: adjacency.rs:25, geom.rs:26, plus an inline copy in geom.rs:74-83 (`min_edge`)
  - 2D area: dfjson/plates.rs:128 (`signed_area_2d`) vs geom.rs:68 (`polygon_area`)
  - Cross-crate counterparts: rust/geometry/src/triangulation.rs:482 `calculate_polygon_normal`, rust/geometry/src/bool2d.rs:201 `compute_signed_area`
- What: the copies already treat rings differently. Rooms merge vertices at `2*tol`, shades at a hard-coded `1.0e-4`, and openings not at all.
- Why it matters: frame or rebase fixes (for example #6) have to be applied at three or four sites.
- Fix: in geom.rs, add `profile_ring(&ExtractedProfile, origin) -> Vec<[f64;3]>`, `extrude(ring, dir, depth)`, and `pub(crate) sub/norm/dist/avg_z`. Have openings, adjacency, shades and plates import them.
- Effort: S

### EXPORT-DATA-12: Single-pass scans use the caching decoder (unbounded cache plus a clone per entity)
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/export/src/relationships.rs:63, 76, 89
  - rust/export/src/rebar_schedule_build.rs:50 (every `IFCRELDEFINESBYTYPE` in the file)
  - rust/export/src/constructions.rs:56
  - rust/export/src/dfjson/spatial.rs:95
  - Cache insert: rust/core/src/decoder.rs:222-223
- What: `decode_at_with_id` goes to `decode_at`, which inserts an `Arc` copy into the cache and returns a clone. Each entity is visited exactly once, so the cache is never hit. `decode_at_uncached` exists for exactly this (core decoder.rs:227-244), and model.rs and quantity_analysis_relations already use it.
- Why it matters: `relationships()` (used by IFCX, spatial CSV, USD and DFJSON) keeps every relationship's attribute vector alive and doubles allocations on large models. Its own comment carefully counts a 57 ms index saving while paying this cost.
- Fix: switch these call sites to `decode_at_uncached`.
- Effort: S

### EXPORT-DATA-13: Flattened entity CSV is O(entities x columns x properties)
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/csv.rs:177-181 (`e.lookup(pset, prop)` per column), rust/export/src/model_types.rs:94-114 (`lookup` linear scan)
- What: each cell does a linear search over the entity's property sets and their values. With 100k entities, 400 flattened columns and about 100 properties each, that is about 4e9 string comparisons.
- Why it matters: `--include-properties` CSV export on large models can take minutes.
- Fix: build a `HashMap<(pset, prop), col>` once, allocate `vec![String::new(); C]` per row, and fill it in a single pass over the entity's psets.
- Effort: S

### EXPORT-DATA-14: Each export rescans the file several times
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - IFCX / spatial CSV / USD: `build_export_model` (index plus two passes) + `relationships()` (rust/export/src/ifc5.rs:106-109) + `decode_one` (ifc5.rs:118-127), and csv.rs re-decodes the project at 84 separately from `project_name`
  - HBJSON: `extract_profiles` builds its own index (profile_extractor.rs:88), `build_constructions` builds a second (constructions.rs:115), and `length_unit_scale` plus `material_names` each scan again
  - DFJSON: `spatial_index` runs `relationships()` and then a second scan (dfjson/spatial.rs:77, 88)
  - Clones: model.rs:344 `defs_by_object.get(&id).cloned()` (could be `remove`, which also frees memory); ifc5.rs:168-171 and usd.rs:128-131 clone every name and type into `name_of`; parquet_bos.rs:79-87 and 107-116 clone every string into `Vec<Option<String>>`
- What: pass 1 in model.rs already visits every `IFCRELDEFINESBYTYPE` and `IFCPROJECT`. Collecting aggregates and containment there would remove the extra scan.
- Why it matters: export time grows with each redundant full-file pass.
- Fix: have `stream_export_model_with_options` optionally return `Relationships`. Fold the storey/building decode into the relationships pass. Share one index between `extract_profiles` and constructions.
- Effort: M

### EXPORT-DATA-15: `stream_export_model_with_options` is a 326-line function
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/model.rs:138-464 (pass 1 is inline at 186-281 with five keyword arms; pass 3 repeats the cache-cap logic from 399-401 at 458-460); model_tests.rs is 1303 lines
- What: pass-1 bookkeeping, unit resolution, placement, inheritance and type-product emission all live in one body.
- Why it matters: fixing #1 and #3 means editing the middle of it.
- Fix: split into `Pass1Index::scan(content, decoder, opts)`, `emit_product_row` and `emit_type_rows`, and add a `maybe_trim_cache(&mut decoder)` helper.
- Effort: M

### EXPORT-DATA-16: Spatial-tree walk and project-node decode duplicated in CSV, IFCX and USD; already drifted
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - DFS walks: rust/export/src/csv.rs:107-134 (pushes reversed, so siblings come out in source order) vs rust/export/src/ifc5.rs:175-194 (pushes in order, so siblings come out reversed); BFS at rust/export/src/dfjson/spatial.rs:157-175
  - id to (name, type) maps: rust/export/src/ifc5.rs:168-180 vs rust/export/src/usd.rs:128-136
  - Project decode: rust/export/src/csv.rs:81-88 (real GlobalId and Name) vs rust/export/src/ifc5.rs:131-136 (Name only) plus path via `uuid_from_id`
- What: the IFCX project node gets a synthetic UUID path, while spatial CSV uses its real GlobalId.
- Why it matters: the ifc5.rs:58-60 comment says the fallback is used "when the entity has no GlobalId (e.g. the IfcProject root)". IfcProject always has a GlobalId, so the comment is stale, and the project node's IFCX identity is not stable across conversions.
- Fix: put `Relationships::walk_spatial(root, visit)` (source order, cycle-safe) and `project_header(content) -> (gid, name)` in relationships.rs, and use the project GlobalId for its IFCX path.
- Effort: S

### EXPORT-DATA-17: Quantity kind is a stringly-typed round-trip mapped in four places
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - rust/export/src/model_props.rs:124-137 (`IfcType` to `"Length"`)
  - rust/export/src/quantity_analysis_units.rs:8-30 (`"Length"` to `"IfcQuantityLength"` to measure/unit type)
  - rust/export/src/jsonld.rs:109 (`format!("ifc:IfcQuantity{}", q.kind)`)
  - rust/export/src/parquet_bos.rs:141 (`format!("IfcQuantity{}", …)`)
  - rust/export/src/quantity_analysis.rs:205 (`quantity.origin == "occurrence"`, comparing the string that was converted from the `QuantityOrigin` enum at :42)
- What: `"Number"` is handled in one mapping and silently skipped in others.
- Why it matters: adding a kind needs coordinated edits in four files.
- Fix: a `QuantityKind` enum in model_types.rs with `as_str()`, `ifc_entity()` and `measure()`; keep `QuantityOrigin` as an enum through to conflict grouping.
- Effort: S

### EXPORT-DATA-18: Magic attribute indices instead of named schema slots
- Category: Maintainability (DRY)
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - rust/export/src/model.rs:194, 198, 210, 225, 228, 265, 273-277, 327-331, 338, 362
  - rust/export/src/model_props.rs:153-154, 159, 163, 208-209, 220-231
  - rust/export/src/csv.rs:85-86
  - rust/export/src/ifc5.rs:133
  - rust/export/src/relationships.rs:64-91
  - rust/export/src/constructions.rs:57
  - rust/export/src/rebar_schedule_build.rs:51, 130-131
  - rust/export/src/quantity_analysis.rs:145, 150, 315
  - rust/export/src/quantity_analysis_relations.rs:62, 71, 77
- What: only dfjson/spatial.rs:33-36 names its slots (`ATTR_NAME` and so on). rebar_attributes.rs:28-30 already resolves positions by schema name through `attribute_names_for_schema`.
- Why it matters: each site re-derives offsets from comments, and a wrong index fails silently.
- Fix: a `rooted` module (or constants in core) such as `ROOT_GLOBAL_ID=0`, `ROOT_NAME=2`, `REL_RELATED=4`, `REL_RELATING=5`, `TYPE_HAS_PSETS=5`, `TYPE_REP_MAPS=6`.
- Effort: S

### EXPORT-DATA-19: About 70 inline STEP fixtures and no shared builder
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - Counts of `ISO-10303-21` in this slice: model_tests.rs 31, rebar_schedule_tests.rs 12, quantity_analysis_derived_tests.rs 8, quantity_analysis_tests.rs 6, jsonld.rs 4, relationships.rs 4, csv_tests.rs 3, and json.rs, dfjson/tests.rs, dfjson/spatial.rs, rebar_fabrication_tests.rs 2 each
  - Known clones: json.rs:156-174 vs jsonld.rs:238-256; dfjson/spatial.rs:182-200 vs dfjson/tests.rs:245-263; model_tests.rs:260-273 vs 345-358; model_tests.rs:866-884 vs processing/tests/issue_3187_legacy_type_product_gate.rs:23-41
  - A builder already exists privately at rust/export/src/schema_convert_tests.rs:315 (`step_file(schema, data)`)
- What: rust/export/src/test_support.rs only provides `fixture_or_skip!`.
- Why it matters: header boilerplate is copied everywhere, and the json/jsonld non-finite tests are byte-identical.
- Fix: move `step_file(schema, data)` into test_support.rs and convert the files above.
- Effort: M

### EXPORT-DATA-20: Parquet geometry folds the origin in f32 and skips the finiteness gate the other exporters apply
- Category: Bug / DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - rust/export/src/parquet_bos.rs:214-219 (`v[0] as f64 as f32 + ox as f32`)
  - Compare rust/export/src/obj.rs:82 and 129-133 (f64 add, rejects non-finite origin/positions) and rust/export/src/usd.rs:240-260 (`mesh_emittable`)
  - `geometry_class == 2` repeated at parquet_bos.rs:207, obj.rs:56, gltf.rs:415, usd.rs:241
- What: the `as f64 as f32` is a no-op, so the addition happens in f32 (two roundings). A NaN or infinite origin is written straight into the column.
- Why it matters: precision is worse than necessary, and a non-finite origin corrupts the geometry tables.
- Fix: compute `(v as f64 + ox) as f32`. Add one `mesh_input::is_exportable(&MeshData)` (instanced-type check, finiteness, triangle-whole) used by all four exporters, and a `GEOM_CLASS_INSTANCED_TYPE` constant.
- Effort: S

### EXPORT-DATA-21: Stringly-typed enums in the energy and analysis models
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `face_type` `"Wall"|"Floor"|"RoofCeiling"`: rust/export/src/hbjson.rs:232, rust/export/src/rooms.rs:136-141, 160, 173, 198, rust/export/src/lib.rs:232-236, rust/export/src/openings.rs:56
  - Boundary-condition strings: hbjson.rs:29, openings.rs:56
  - Status strings: quantity_analysis_derived.rs:178, 205, 220 (`status == "complete"`)
- What: a typo such as `"Roofceiling"` compiles and silently skips construction assignment.
- Why it matters: errors of this kind are invisible until output is inspected.
- Fix: `#[derive(Serialize)] enum FaceType` / `enum Bc` with serde renames; same for analytic status.
- Effort: S

### EXPORT-DATA-22: HBJSON and DFJSON scaffolding duplicated
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `TypedProps`: rust/export/src/hbjson.rs:44-48 and rust/export/src/dfjson/schema.rs:18-27
  - Version `"1.0.0"` / `"Meters"` / `angle_tolerance: 1.0`: hbjson.rs:327-333 vs dfjson/schema.rs:15 and dfjson/mod.rs:143-148
  - `HbjsonOptions` / `DfjsonOptions` with identical `Default` (`tolerance: 0.01` at lib.rs:182, 265, and again at examples/dump_hbjson.rs:12)
  - `export_*` / `*_with_stats` wrappers: lib.rs:213-288
- What: the two Ladybug formats share the same header fields and options but define them separately.
- Why it matters: a version bump has to be made twice.
- Fix: a `ladybug` module holding `TypedProps`, `LADYBUG_SCHEMA_VERSION`, `DEFAULT_TOLERANCE_M` and one `LadybugOptions`.
- Effort: S

### EXPORT-DATA-23: Tolerance and threshold literals scattered with no named home
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - rust/export/src/openings.rs:85, 93-97 (`0.7`, `0.5`, `0.05`, `0.1` metres)
  - rust/export/src/shades.rs:48 (`1.0e-4`, the same value as `AREA_EPS` but a different meaning)
  - rust/export/src/geom.rs:9, 124, 198 (`AREA_EPS`, `1e-9`, `1e-6`)
  - rust/export/src/constructions.rs:104 (`0.001`)
  - rooms.rs and plates.rs duplicate thresholds (see #10)
  - Contrast: adjacency.rs:15-22, plates.rs:26 and stories.rs:22 do name theirs
- What: about half the thresholds are named and documented; the rest are bare literals.
- Why it matters: tuning or auditing tolerances means hunting through files.
- Fix: a `consts` block in geom.rs with doc comments, referenced from each site.
- Effort: S

### EXPORT-DATA-24: Bounded-diagnostics collector and rebar limit validation each written several times
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - rust/export/src/quantity_analysis_diagnostics.rs:9-35 (cap 1024, record and static sets)
  - rust/export/src/quantity_analysis_derived.rs:69-94 (`JoinedDiagnostics`, cap 1024, dedup)
  - rust/export/src/rebar_schedule_links.rs:5-14 (cap 128)
  - `RebarPreflightLimits::validate` (rebar_preflight.rs:32-46) vs `RebarFabricationPolicy::validate` (rebar_fabrication.rs:30-52), with two near-identical error structs and two identical wrapper enums
- What: the collectors differ in truncation wording and dedup semantics.
- Why it matters: behaviour around caps is inconsistent across closely related features.
- Fix: one `BoundedDiagnostics { cap, dedup }` type and one `validate_nonneg_finite(name, v)` helper.
- Effort: S

### EXPORT-DATA-25: "Is this a product?" logic duplicated; quantity analysis has drifted
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - rust/export/src/model.rs:311-317 (product, or `EXPORTER_STRATUM_ALIASES` matched with a hand-rolled `.any(keyword_eq)`)
  - rust/export/src/quantity_analysis.rs:266-267 (product only)
  - core `is_exporter_stratum_alias` exists (core/src/compatibility.rs:20), but it is case-sensitive
- What: `IFCSOLIDSTRATUM` rows exist in the attribute export but never in authored-quantity analysis.
- Why it matters: the two features disagree on which entities count as products.
- Fix: `ifc_lite_core::is_exportable_product(keyword)` (case-insensitive) used by both.
- Effort: S

### EXPORT-DATA-26: Rebar schedule falls back to IFC4 layout while the attribute export fails closed
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - rust/export/src/rebar_schedule_build.rs:15-16 (`detect_schema` defaults to `"IFC4"`, rust/export/src/schema_detect.rs:13-17)
  - Contrast rust/export/src/model.rs:144-151 ("must fail closed rather than assign IFC4 names to unknown slots")
  - Also rebar_attributes.rs:28 looks up by PascalCase `ifc_type.name()`, while model_props uses the raw keyword
- What: a file with an unreadable `FILE_SCHEMA` gets IFC4 attribute positions in the rebar schedule but no attributes in the main export.
- Why it matters: the two features apply opposite policies to the same uncertainty.
- Fix: share model.rs's `declared_schemas(...).find(recognised)` probe and fail closed in both.
- Effort: S

### EXPORT-DATA-27: Error handling is inconsistent across sibling exporters
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `String` plus `.expect("… serializes")`: rust/export/src/json.rs:115-117, rust/export/src/jsonld.rs:129-131, rust/export/src/ifc5.rs:249-251, rust/export/src/lib.rs:251, 286
  - `Result<_, ExportError>`: rust/export/src/parquet_bos.rs:282
  - Per-feature error types: `SweptDiskCheckError`, `RebarPreflightError`, `RebarFabricationPolicyError` plus two wrapper enums
  - Diagnostics as `Vec<String>`: quantity_analysis
- What: rust/export/src/error.rs:34-39 says `Serialization` "replaces panicking .unwrap()/.expect()" calls, which is only true for parquet. The expects are unreachable today (serde_json maps non-finite floats to `null`, which is a silent issue of its own for HBJSON coordinates).
- Why it matters: callers cannot handle failures uniformly across exporters.
- Fix: return `Result<String, ExportError>` from the `try_` variants, or document the infallibility once.
- Effort: S

### EXPORT-DATA-28: Flattened CSV header names can collide
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/csv.rs:159-161 (`format!("{pset}_{prop}")`)
- What: `("Pset_A", "B_C")` and `("Pset_A_B", "C")` both produce the header `Pset_A_B_C`.
- Why it matters: spreadsheet and pandas imports silently merge or rename the columns.
- Fix: use a separator that cannot appear in names (`.`), or de-duplicate headers.
- Effort: S

CSV injection check: every CSV cell in the slice goes through `csv_cell::escape_csv_cell` (csv.rs:46-58), headers included. The rebar schedule and quantity analysis emit serde structs, not CSV, so there is no bypass.

## Concept inventory
- **Vector math / polygon ops**
  - `zup` rust/export/src/geom.rs:12
  - `xf` (column-major 4x4 then Z-up) geom.rs:17
  - `dist` geom.rs:26
  - `clean_ring` geom.rs:33
  - `newell_raw` / `newell_normal` geom.rs:47 / 61
  - `polygon_area` geom.rs:68
  - `min_edge` geom.rs:74
  - `planarity_dev` geom.rs:86
  - `face_ok` geom.rs:98
  - `orient2d` / `segments_cross` / `collinear_overlap` geom.rs:103 / 108 / 120
  - `is_simple_polygon` geom.rs:143
  - `is_watertight` geom.rs:197
  - `center` geom.rs:222
  - `dot` geom.rs:231
  - `sub` / `norm` openings.rs:18-22
  - `sub` / `dist` adjacency.rs:24-28
  - `signed_area_2d` dfjson/plates.rs:128
  - `is_vertical` / `is_horizontal_ring` dfjson/plates.rs:32 / 44
  - wall u/v frame `collect_exterior_walls` / `project` openings.rs:52 / 75
- **Transforms**
  - `xf` geom.rs:17
  - `Placement` (column-major, metres, no RTC, Z-up) model_options.rs:29-39
  - placement resolve via `GeometryRouter::with_scale` model.rs:300-342
- **Tolerances**
  - `AREA_EPS` geom.rs:9
  - `MAX_GAP` / `MAX_LATERAL` / `MAX_AREA_DIFF` adjacency.rs:15-22
  - `MAX_TILT_RATIO` dfjson/plates.rs:26
  - `STORY_GAP` dfjson/stories.rs:22
  - Literals at rooms.rs:218-221, plates.rs:170-173, openings.rs:85-97, shades.rs:48
  - Default 0.01 at lib.rs:182, 265
  - Equality tolerance `1e-12 + 1e-9·max` quantity_analysis_units.rs:90
  - Work budgets quantity_analysis.rs:24-32
- **Unit conversion**
  - `resolve_unit_scales` (model.rs:293)
  - `decoder.length_unit_scale` (constructions.rs:117, rebar_schedule_build.rs:18)
  - `ProjectUnits::resolve` / `unit_for_measure` (quantity_analysis.rs:281, rebar_schedule_build.rs:85-87)
  - `resolve_quantity_unit` / `quantity_measure` quantity_analysis_units.rs:21, 37
  - rebar `attribute` scaling rebar_attributes.rs:39-60
  - `UnitScales` re-export lib.rs:106
- **Bbox**
  - Origin min-corner rooms.rs:45-55
  - Ring AABB `is_horizontal_ring` dfjson/plates.rs:44-54
  - `room_signature` z-extent rooms.rs:206-210
- **Hashing / ids**
  - `uuid_from_id` (golden-ratio mix) ifc5.rs:61
  - Edge-grid keys in `is_watertight` geom.rs:199-205
  - `color_key` usd.rs (adjacent to this slice)
- **Property / attribute access**
  - `render_value` / `map_enum` / `fmt_num` model_props.rs:40 / 29 / 20
  - `render_attributes` model_props.rs:91
  - `opt_string` / `ref_list` model_props.rs:139 / 145
  - `decode_property_set` model_props.rs:152
  - `decode_quantity_records` model_props.rs:204
  - `resolve_pset_defs` model_props.rs:243
  - `merge_inherited` / `NamedSet` model_inherit.rs:20-122
  - `EntityRow::lookup` model_types.rs:94
  - `typed_value` / `finite_json_number` json.rs:40 / 35
  - `property_definition_refs` quantity_analysis_relations.rs:13
  - `relationships()` relationships.rs:48
  - `spatial_children` / `decode_one` / `project_name` ifc5.rs:106 / 118 / 131
  - `spatial_index` / `descendants` dfjson/spatial.rs:76 / 157
  - `material_names` constructions.rs:49
  - rebar `attribute` rebar_attributes.rs:21
  - `detect_schema` schema_detect.rs:13
  - CSV escaper `escape_csv_cell` csv_cell.rs:203
  - Identifier sanitisers lib.rs:164, constructions.rs:43, ifc5.rs:88
- **Colour**: none in this slice (only the USD `color_key` noted above).
- **Error types**
  - `ExportError` error.rs:13
  - `RebarPreflightError` / `RebarSchedulePreflightError` rebar_preflight.rs:50 / 62
  - `RebarFabricationPolicyError` / `RebarScheduleFabricationError` rebar_fabrication.rs:56 / 69
  - `LeafBudgetError` quantity_analysis_budget.rs:39
  - `Diagnostics` quantity_analysis_diagnostics.rs:10
  - `JoinedDiagnostics` quantity_analysis_derived.rs:73
  - Rebar `links::report` rebar_schedule_links.rs:7