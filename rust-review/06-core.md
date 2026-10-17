# rust/core review (parser, decoder, units, georef, generated, fuzz)

## Summary
- **Core has about nine hand-written STEP readers for one grammar, and they have drifted.** There is the nom tokenizer, `EntityScanner` with `find_entity_end`, `close_step_record`, `StepListItems`, the header `Lex`, `data_section_start`, the `fast_parse` family, the decoder `*_fast` accessors, and `model_bounds`. Between them they hold five string-literal walks, four numeric grammars, four type-name extractors, three "first `#ref`" readers and four ref-list readers that follow three different policies. `StepListItems` and `parse_step_numeric` exist as the shared rules, but the fast accessors, `fast_parse` and `model_bounds` predate them and were never moved over (CORE-1, -6, -8, -9, -10, -13).
- **Units are resolved at least seven times, with different policies.** The sites are four walks in `units.rs`, `ProjectUnits`, the georef MapUnit reader and an exporter copy. Some read the name table first and others the factor first. Only some check that the factor is finite. Only `ProjectUnits` follows `UnitComponent` chains. Some return `1.0` on an unreadable factor and others return `None`. Separately, the "scan for IfcProject, then the length scale" loop is hand-rolled in about 15 places across crates, even though `EntityDecoder::length_unit_scale()` already does this and caches the result (CORE-2, -3, -15).
- **`AttributeValue` flattens typed values (`IFCLABEL('x')`) into `List([String("IFCLABEL"), String("x")])`.** That shape cannot be told apart from a genuine list of strings. As a result 12 downstream sites hand-unwrap typed values with three different predicates, and a two-string list such as `('A','B')` is read as the typed value "B" (CORE-4).
- **A malformed record gets a very large error message.** The nom tokenizer's error `Display` writes the whole unparsed rest of the record as a decimal byte list (`[35, 49, …]`), about 5× the record's size. That is built for every failed decode on every walk, so a corrupt multi-MB faceset allocates tens of MB of error text each time it is touched (CORE-5).
- **The numeric grammars disagree on real input.** The raw-byte readers accept `.5` and `1E5`, but the nom tokenizer rejects them and drops the whole entity. So `get_cartesian_point_fast` returns a point that `decode_by_id` cannot decode (CORE-6). Two `CoordIndex` grammars also disagree on index `0` (CORE-12).
- **The generated code is about 5× larger than it needs to be.** There are five full `IfcType` enums, each with about 10 parallel 1000-arm matches, plus five CRC32 tables and five `type_ids` files, all under `#![allow(dead_code)]`. They account for 14,610 of the crate's 14,905 pedantic warnings. The four schema registries only need name → (parent, abstract, attrs) tables (CORE-7).
- **Dead public surface:** `streaming.rs` (and the futures deps it pulls in), most of the `fast_parse` triangulated-faceset (TFS) fast path, `IfcSchema.geometry_types` (threaded through 43 signatures but read nowhere), 4 of the 6 `Error` variants, and the unused `smallvec` dependency (CORE-20, -21, -22).
- **Fuzzing covers almost nothing.** There is one target (`parse_entity`) with four seeds. Nothing fuzzes the scanner, `StepListItems`, `decode_ifc_string` or the header reader, and nothing runs the grammars differentially against each other, which would have caught most of the drift above (CORE-30).

## Findings

### CORE-1: Raw-byte attribute walkers in the decoder and fast_parse are hand-rolled 12 times, ignore comments and strings, and have three different policies for bad refs
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - "skip to the first/second `(`" prelude: `rust/core/src/decoder.rs:493-499` (get_first_entity_ref_fast), `rust/core/src/decoder.rs:556-571` (get_polyloop_point_ids_fast), `rust/core/src/decoder.rs:719-734` (parse_cartesian_point_inline), `rust/core/src/decoder/fast_buffers.rs:197-213` (get_entity_ref_list_fast_into), `rust/core/src/decoder/fast_buffers.rs:281-297` (get_polyloop_coords_cached_into). jscpd only caught one pair.
  - `#ref` list readers: `rust/core/src/decoder.rs:576-608`, `rust/core/src/decoder/fast_buffers.rs:218-252`, `rust/core/src/decoder/fast_buffers.rs:304-363`, `rust/core/src/fast_parse.rs:301-333`
  - "first `#` after the first `(`" readers: `rust/core/src/decoder.rs:487-527`, `rust/core/src/fast_parse.rs:232-255`, `rust/core/src/model_bounds.rs:277-301`
  - Positional attribute walks: `rust/core/src/decoder.rs:623-708` (face bound), `rust/core/src/fast_parse.rs:140-184` (extract_face_indices_from_entity, a comma counter), `rust/core/src/fast_parse.rs:111-132` (coordinate_list_span, ignores strings)
  - Downstream twin: `rust/geometry/src/processors/mod.rs:76-145` (`extract_coord_index_bytes`, which flips an `in_string` flag on every `'`, so it misreads `\S\'` and `''`)
- What: these walks find structure by scanning for the next `(`, `#` or `,`. None of them uses the shared rule, `StepListItems::of_record(..).nth(i)` / `StepListItems::of_list`, which correctly skips comments and handles `''` and `\S\'`. The policies have drifted:
  - Oversized ref: `get_polyloop_point_ids_fast` refuses the whole loop (`point_ids.push(id?)`), `get_entity_ref_list_fast_into` silently drops it (`if let Some(id)`), and `get_polyloop_coords_cached_into` refuses through `expected_count`.
  - Minimum length: coords require `>= 3` points, ids only require non-empty.
  - Id 0: `extract_entity_refs_from_list` drops `#0`; the others keep it.
  - "First ref" means the first `#` anywhere in the record, not the first attribute. A `$` first attribute yields attribute 2's ref, and `'a#12'` yields 12.
- Why it matters: every fix has to be repeated at each site, and the #3421/#4687 history shows how they diverge. A comment containing `(` or `#` inside a polyloop or point record shifts the read: `#5=IFCCARTESIANPOINT(/* (9.) */(1.,2.,3.));` makes `parse_cartesian_point_inline` read `9.)` and refuse the point. `StepListItems` already solved this.
- Fix: write one internal `RecordView<'a>` in `parser/scanner_attributes.rs`, with `attr(i) -> Option<&[u8]>`, `ref_at(i)`, `ref_list_at(i, RefPolicy::{RefuseAll, Skip})` and `numbers_at(i)`, built on `StepListItems` and `parse_step_numeric`. Express every decoder `*_fast` accessor, `fast_parse::extract_*` and `model_bounds::extract_*` as calls to it. Keep `memchr` fast paths only behind a measured benchmark.
- Effort: M

### CORE-2: Length and plane-angle units are resolved in seven or more places with drifted policies
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - `rust/core/src/units.rs:31-229` (extract_length_unit_scale), `rust/core/src/units.rs:249-332` (try_extract_length_unit_scale), `rust/core/src/units.rs:346-426` (try_extract_plane_angle_to_radians), `rust/core/src/units.rs:442-532` (extract_plane_angle_to_radians). jscpd flagged `units.rs:264-282` against `361-378`.
  - `rust/core/src/project_units/mod.rs:60-367` (ProjectUnits, `conversion_factor_scale`)
  - `rust/core/src/georef.rs:285-316` (resolve_measure_with_unit), `rust/core/src/georef.rs:493-548` (MapUnit)
  - Downstream: `rust/export/src/landxml_terrain_georef.rs:144-176` (project_length_metres / length_unit_metres)
- What: every site repeats the same walk, IFCPROJECT → attr 8 → IFCUNITASSIGNMENT → attr 0 list → SI/ConversionBased → IFCMEASUREWITHUNIT, and each makes different choices:
  - Factor source: length (`units.rs:159-166`) and the georef MapUnit (`georef.rs:528-533`) use the **name table first, then the factor**. `ProjectUnits` (`project_units/mod.rs:267-273`) uses the **factor first, then the name table** (LENGTHUNIT only). Plane angle ignores the name table entirely.
  - `UnitComponent`: only `ProjectUnits` follows a conversion-based or derived `UnitComponent`. `units.rs` and georef only apply an SI prefix, so YARD defined as 3 FOOT comes out as 3 m unless the name table catches it. The plane-angle functions ignore `UnitComponent` altogether.
  - Unreadable factor: `extract_length_unit_scale` falls back to `1.0` and returns metres (`units.rs:191-198`). `ProjectUnits` returns `None` (#4690). `try_extract_length_unit_scale` returns `None` for **every** conversion-based length unit, even FOOT, which the full path resolves by name.
  - Finite check: missing from `extract_length_unit_scale` (CORE-15), present in the others.
- Why it matters: geometry, display and georef scale the same file differently. Take a file whose FOOT unit carries a US-survey factor of 0.3048006096. The viewer label (`ProjectUnits`) uses the survey factor, while geometry and georef use the 0.3048 international foot, about 2 ppm apart, which is roughly 5 mm over a 2.5 km model. Every bug fix (#820, #1367, #4690) had to be applied up to four times.
- Fix: keep a single resolver in `project_units`, e.g. `ProjectUnits::resolve_with(decoder, project, Mode::{Strict, PartialIndex})` returning `Option<ResolvedUnit>` per unit type. Turn the four `units.rs` functions into thin wrappers: `.resolved_for_unit_type("LENGTHUNIT").map(|u| u.si_scale)`, plus a partial-index flag that turns "undecodable ref" into `None`. Have georef MapUnit call `resolve_unit_by_ref`. Pick one name-versus-factor precedence and document it.
- Effort: M

### CORE-3: "Find IfcProject, then get the unit scale" is hand-rolled about 15 times although `EntityDecoder::length_unit_scale()` already exists
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - Core: `rust/core/src/decoder.rs:331-339` and `rust/core/src/decoder.rs:362-369` (twice inside the decoder itself)
  - Wasm and geometry: `rust/wasm-bindings/src/api/alignment_lines.rs:80-88`, `rust/geometry/src/router/mod.rs:298-307` (scan_unit_scale), `rust/geometry/src/profile_extractor.rs:748-757` (detect_unit_scale), `rust/geometry/src/alignment_sampling.rs:108-115`, `rust/geometry/src/alignment_sampling.rs:241`
  - Project-id discovery loops: `rust/wasm-bindings/src/api/styling/prepass.rs:57`, `rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:354`, `rust/export/src/rebar_schedule_build.rs:30`, `rust/export/src/model.rs:246`, `rust/export/src/relationships.rs:59`, `rust/export/src/quantity_analysis.rs:264`, `rust/processing/src/processor/mod.rs:710`, `rust/processing/src/appearance/context.rs:22`, `apps/server/src/services/data_model/mod.rs:156`, `apps/server/src/services/data_model/spatial.rs:189` (`to_uppercase() == "IFCPROJECT"`, which allocates per entity)
- What: each site runs a full `EntityScanner` walk to find the singleton project. Some take the first match (`get_or_insert`, `is_none()`) and some break on the first. `length_unit_scale()` / `plane_angle_to_radians()` already do the scan and cache it, yet they themselves duplicate the scan once per quantity.
- Why it matters: this is O(file) work repeated per call site; the doc comment on `seed_unit_scales` measures 135 ms per element on a 75 MB file. It also gives the "which IfcProject wins" policy many owners.
- Fix: add `pub fn find_project_id(content) -> Option<u32>` to core, using the `find_keyword(b"IFCPROJECT")` prefilter and then a scan. Cache `project_id` on the decoder and make both scale methods use it. Replace the geometry and wasm copies with `decoder.length_unit_scale()`.
- Effort: S

### CORE-4: Typed values are flattened into an ambiguous `List([String(TYPE), value])` shape, and 12 downstream sites unwrap it differently
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - Producer: `rust/core/src/schema_gen.rs:94-109`. Core consumers: `rust/core/src/schema_gen.rs:151-163` (`as_float`), `rust/core/src/georef_pset.rs:27`.
  - Downstream: `rust/processing/src/processor/properties.rs:121-123`, `rust/processing/src/style/surface.rs:231`, `rust/processing/src/appearance/page_material.rs:18`, `rust/geometry/src/processors/sectioned_positions.rs:86`, `rust/geometry/src/processors/advanced_face/curves.rs:63`, `rust/geometry/src/profiles/curves_2d.rs:34-36`, `rust/geometry/src/profiles/curves_3d.rs:362-364`, `rust/export/src/model_props.rs:46-53`, `apps/server/src/services/data_model/property_value.rs:164`, `apps/server/src/services/data_model/property_value.rs:243`
- What: `Token::TypedValue` is lost on conversion. A typed value becomes a list whose first element is a `String`. The unwrapping predicates differ by site:
  - `items.len() == 2` with no type check (server)
  - `len() >= 2 && first is String` (processing)
  - `first is String`, any length (export)
- Why it matters: a genuine list of strings is indistinguishable from a typed value. `IfcPerson.MiddleNames ('Anne','Marie')` renders as value "Marie" with type tag "Anne" in `model_props::render_value`, and processing's `attribute_value_to_string` returns only "Marie". `as_float` likewise reads `('x', 1.5)` as 1.5.
- Fix: add `AttributeValue::Typed { name: String, value: Box<AttributeValue> }` (or a `Vec` of args), with `as_typed() -> Option<(&str, &AttributeValue)>` and `unwrap_typed() -> &AttributeValue`. Make `as_float`, `as_string`, `as_int` and `as_enum` see through it. Delete all 12 hand-unwraps.
- Effort: M (touches downstream crates)

### CORE-5: A nom parse failure builds an error string 5-10× the size of the record
- Category: Bug
- Severity: High
- Confidence: CONFIRMED
- Where: `rust/core/src/parser/tokenizer.rs:336`, `rust/core/src/decoder.rs:263-274`
- What: `format!("Failed to parse entity: {}", e)` with `e: nom::Err<nom::error::Error<&[u8]>>`. nom 7's `Display for Err<E>` writes `{:?}` of the inner error (verified in nom-7.1.3 `internal.rs:213-224`), so the output is `Error { input: [35, 49, 61, ...], code: Char }`: the **entire remaining record** as decimal bytes, about 4-5 characters per byte. `parse_at` then formats the result again with `{:?}`. The "bounded, lossy debug info" comment at `decoder.rs:264` only bounds the second half.
- Why it matters: every walk does `let Ok(..) = .. else { continue }`, so the message is built and thrown away. A 20 MB IfcTriangulatedFaceSet that fails to parse (for example on a `.5` literal, see CORE-6) allocates about 100 MB of text per decode attempt, and nothing caches failures. On wasm32 that can OOM-abort the instance.
- Fix: map the nom error to `(offset = input.len() - e.input.len(), kind)` and format only the offset, the kind, and at most 64 lossy bytes of context. Add a test asserting `err.to_string().len() < 512` for a 1 MB malformed record.
- Effort: S

### CORE-6: There are four STEP numeric grammars, and the tokenizer rejects literals the fast readers accept
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - `rust/core/src/parser/tokenizer.rs:116-146` (nom `integer`/`float` plus `lexical_core`)
  - `rust/core/src/parser/numeric_literal.rs:417-459` (`step_numeric_literal_len` plus `fast_float2`)
  - `rust/core/src/model_bounds.rs:201-206` (`str::parse::<f64>`)
  - `rust/core/src/fast_parse.rs:69-90` (`parse_index_value`, digits only, which reads `-3` as 3 and `1.5` as 1 and 5)
- What: `numeric_literal.rs` calls itself "the one STEP numeric-literal grammar every Rust raw-byte reader shares", and it accepts `.5`, `1E5` and `+1`. The nom `float` requires a digit before `.` and a `.` before any exponent, so for `.5` or `1E5` every `alt` branch fails and the **whole entity** fails to decode. `model_bounds` accepts both but treats a trailing `/* c */` as unparseable.
- Why it matters: for `#7=IFCCARTESIANPOINT((.5,0.,0.));`, `decoder.get_cartesian_point_fast(7)` (used by `geometry/src/transform.rs:145,191`) returns `(0.5,0,0)`, while `decode_by_id(7)` errors and every full-decode walk silently drops #7. The two halves of the geometry pipeline therefore disagree about whether the point exists. The crate also carries two float-parsing dependencies (`lexical-core` and `fast-float2`) for the same job.
- Fix: make the tokenizer's number branch a hand-written combinator that calls `parse_step_numeric::<f64>` (and an integer variant on the same length function), then drop `lexical-core`. Route `model_bounds` through `parse_step_numeric` too (CORE-13). Add a differential test that feeds the shared vectors through all readers.
- Effort: S

### CORE-7: The generated code duplicates the type universe five times; the registries need only tables
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/core/src/generated/schema.rs` (16,817 lines)
  - `rust/core/src/generated/{ifc2x3,ifc4,ifc4x1,ifc4x2}/schema.rs` (6.9k-8.6k lines each)
  - Six `type_ids.rs` files (about 4.3k lines)
  - Generator: `packages/codegen/src/rust-generator.ts:53`
  - Consumers: `rust/core/src/generated/schema_registry.rs:114-226`
- What:
  - Each generated file emits an enum plus `from_canonical_name`, `from_id`, `id`, `as_str`, `known_as_str`, `name`, `parent`, `is_abstract`, `attribute_names` and `declared_by_canonical_schema`: about ten 776-1021-arm matches that all encode one table.
  - `as_str` and `known_as_str` are the same table twice.
  - The four crate-private copies also emit `crc32_hash` (a five-times-duplicated 256-entry table), `UnknownIfcType`, `ALL`, `from_id`/`id` and `type_ids`, all hidden behind `#![allow(dead_code)]`. Per `schema_registry.rs`, consumers use only `from_str`, `known_as_str`, `parent`, `is_abstract` and `attribute_names`.
  - Generated files produce 14,610 of the 14,905 pedantic warnings for the crate.
  - `schema_registry.rs:7` says "the three registry modules", but there are four plus the canonical one (stale).
  - The generator/output split itself is sound: `scripts/check-codegen-sync.mjs:266-284` byte-checks every Rust output against regeneration.
- Why it matters: about 53k lines are compiled on every core build, and every new per-type fact means another parallel 1000-arm match across five files. Unknown-name lookups in the registries also allocate a `String` and compute a CRC (`UnknownIfcType::new`) just to answer `None`.
- Fix:
  - Change the generator to emit, per schema, a sorted `static ENTITIES: &[EntityRow { upper, pascal, id, parent: Option<u16>, is_abstract, attrs: &[&str] }]` and look names up by binary search or phf.
  - For the canonical enum, keep the variants but derive `as_str`, `name`, `id`, `parent` and the rest from `ENTITIES[self as usize]` (split `KnownIfcType` as `#[repr(u16)]` from `Unknown`).
  - Drop `type_ids` and CRC from the crate-private registries.
  - Emit a `#![allow(clippy::pedantic)]` header.
- Effort: M (generator change plus regeneration)

### CORE-8: The STEP string-literal end rule is implemented five times in core, and the copies disagree on unterminated literals
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/core/src/step_encoding.rs:63-75` (canonical `step_string_literal_end`)
  - `rust/core/src/parser/lexical.rs:229-252` (`close_step_record`)
  - `rust/core/src/parser/scanner_record_end.rs:121-144` (`find_entity_end`)
  - `rust/core/src/parser/scanner_header.rs:231-247` (`data_section_start` state machine)
  - `rust/core/src/parser/header_scan.rs:47-60` (`Lex::skip_lexical_at`)
  - Downstream naive copies: `rust/geometry/src/processors/mod.rs:93-97`, `rust/export/src/rooted_type.rs:79`, `rust/export/src/merged/guid.rs:108,149-150,164-168` (plain "next `'`")
- What: each copy repeats the `is_page_quote_operand` / `''` loop. `Lex` returns `Some(len)` for an unterminated literal, the canonical function returns `None`, and the scanner returns `RecordClose::Unreadable`. Only `close_step_record` and `find_entity_end` apply the #7541 stray-quote rule. The geometry copy flips an `in_string` flag on every `'`, so `''` and `\S\'` invert its state.
- Why it matters: #7540, #7541 and #7589 each had to patch several copies, and another copy will be missed next time.
- Fix: have every walker call `step_string_literal_end` and then, when needed, `string_parameter_end`. Express `Lex::skip_lexical_at` as `step_string_literal_end(..).unwrap_or(len)` and keep its deliberate "run to end" answer in one line at the call site.
- Effort: S

### CORE-9: The scanner's DATA-section skip and the header reader disagree on where `DATA;` is
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/core/src/parser/scanner_header.rs:219-272` against `rust/core/src/parser/header_scan.rs:119-147`, `rust/core/src/parser/header.rs:14`
- What: the two locators differ in four ways:
  - Matching: `data_section_start` matches the exact bytes `DATA;`. It is case-sensitive, does not allow trivia before the `;`, and does not check for an identifier boundary before `D`. `find_section_marker` is case-insensitive, skips trivia and checks the boundary.
  - Window: the header reader looks at 64 KiB, the scanner at 256 KiB.
  - ISO 10303-21 ed.3: `DATA('name',(…));` matches neither.
- Why it matters: `DATA ;`, `data;` or a long header makes `data_section_start` return 0, so the scanner walks the HEADER for entities. That is exactly the #654 failure the function exists to prevent, where a CATIA `'…\X0\2#.ifc'` string flips quote parity. Meanwhile the header reader finds the schema fine, so nothing reports a problem.
- Fix: implement `data_section_start` as `find_section_marker(bytes[..limit], b"DATA")` plus the skip past `;`, with one shared `MAX_HEADER_BYTES`. Also accept the parenthesised ed.3 form.
- Effort: S

### CORE-10: Entity type names are extracted four ways and normalised two ways
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Extraction: `rust/core/src/parser/scanner.rs:273-301`, `rust/core/src/parser/tokenizer.rs:310-334`, `rust/core/src/fast_parse.rs:212-226` (`extract_entity_type_name`, used by `ifc_type_from_record` at `schema_helpers.rs:298`), `rust/core/src/decoder.rs:628-653` (the "OUTER" scan), plus `rust/export/src/merged/guid.rs:115`
  - Normalisation: `rust/core/src/schema_helpers.rs:38-44,243-246` (`normalise_uppercase`, ASCII) against `rust/core/src/generated/schema.rs:1242-1254` (`IfcType::from_str`, Unicode `to_uppercase`)
- What: `extract_entity_type_name` splits at the first `=` and the next `(`, so it ignores comments: `#1=IFCWALL/* x */(` gives `"IFCWALL/* x */"`, which resolves to Unknown, while the scanner handles comments. `ifc_type_from_keyword` claims to be the one normalisation rule (#4203), yet it ASCII-uppercases and then calls `from_str`, which upper-cases again with Unicode rules. For non-ASCII keywords the two give different `Unknown` names and CRCs.
- Fix: expose one `parser::record_keyword(record) -> Option<&str>` (reusing the scanner logic) and use it everywhere. Make `ifc_type_from_keyword` simply `IfcType::from_str`, or the reverse.
- Effort: S

### CORE-11: `get_face_bound_fast` tests "OUTER" case-sensitively, so CamelCase files lose outer-bound detection
- Category: Bug
- Severity: Medium
- Confidence: LIKELY
- Where: `rust/core/src/decoder.rs:642-653`. Consumers: `rust/geometry/src/processors/brep/faceted.rs:299-318`, `rust/geometry/src/processors/brep/surface_model.rs:108-123`, `rust/geometry/src/router/content_hash.rs:175-177`
- What: it looks for the bytes `O U T E R` in the raw type name. Per #4497, keyword case is not significant and `keyword_eq` exists for exactly this; that sweep missed this site.
- Why it matters: in a file that writes `IfcFaceOuterBound`, `is_outer` is always false. The faceted-brep code then takes the **first** bound as the outer one. A face whose hole loop is listed before its outer loop is triangulated with the hole as the boundary, which inverts the face.
- Fix: read the keyword through the scanner (CORE-10) and compare with `keyword_eq(kw, "IFCFACEOUTERBOUND")`.
- Effort: S

### CORE-12: IfcTriangulatedFaceSet `CoordIndex` is parsed by two core grammars with different index rules, after already being decoded
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/core/src/fast_parse.rs:48-90` (`parse_indices_direct`, where `0` becomes `0` via `saturating_sub`)
  - `rust/core/src/schema_gen.rs:239-269` (`parse_index_list`: `0` becomes `u32::MAX`, a missing index becomes `1-1 = 0`)
  - Caller: `rust/geometry/src/processors/tessellated/triangulated.rs:47-73`
  - Locators of attribute 3: `rust/core/src/fast_parse.rs:140-184` (dead) and `rust/geometry/src/processors/mod.rs:76-145`
- What: index `0`, which is invalid for 1-based IFC, aliases vertex 1 on the fast path but is dropped as out of range on the slow path. A short face `(1,2)` becomes `(0,1,0)` on the slow path, a degenerate triangle that looks valid. Negative indices are read as positive on the fast path. The comment at `schema_gen.rs:246-248` acknowledges the two sentinels differ. The fast path also re-parses bytes that `decode` already turned into `entity.get(3)`, so it saves only the AttributeValue walk.
- Fix: keep one index grammar, `RecordView::index_lists_at(3)` from CORE-1, which refuses `0`, negatives and short faces consistently. Delete `parse_index_list`, `extract_face_indices_from_entity` and geometry's `extract_coord_index_bytes`.
- Effort: S

### CORE-13: `model_bounds` has its own point, ref and number readers; the placement filter uses an unscaled `1000.0`; and it scans the file up to three times
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/core/src/model_bounds.rs:178-210`, `rust/core/src/model_bounds.rs:217-273`, `rust/core/src/model_bounds.rs:277-301`
- What:
  - Point reading: `extract_point_coordinates` requires the literal `((`, so `IFCCARTESIANPOINT( (1.,2.,3.))` is skipped. It splits on `,` and uses `str::parse` (a third grammar, see CORE-6). A bad z becomes `0.0`, the silent default #5266 removed elsewhere. It accepts 4+ components, and a trailing comment drops the point.
  - Placement filter: `scan_placement_bounds` includes non-placement points with `x.abs() > 1000.0` measured in **raw file units**. #4934 explicitly moved `has_large_coordinates` to metres, so in a millimetre file every point beyond 1 m passes the "large" filter and the filter does nothing.
  - Passes: two full scans plus a fallback third (`scan_model_bounds`), using std `HashSet` instead of `FxHashSet`.
  - `extract_first_reference` is the third copy of "first ref" (CORE-1).
- Why it matters: this feeds the RTC offset decision (`geometry/src/router/rtc_offset.rs:435`, `processing/src/stream_meta.rs:183`), and points the decoder reads fine can be missing from the bounds.
- Fix: read points with `decoder::parse_point_coordinates` (already strict and comment-aware) or the CORE-1 `RecordView`. Compute both passes in one scan by collecting point spans keyed by id. Express the threshold as `LARGE_COORD_THRESHOLD_METERS / length_unit_scale`.
- Effort: S

### CORE-14: The ePSet_MapConversion fallback accepts non-finite Eastings, Northings and Height; the IfcMapConversion path refuses them
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/core/src/georef_pset.rs` `parse_pset_map_conversion` (Eastings/Northings/OrthogonalHeight arms) against `rust/core/src/georef.rs:401-404`
- What: `parse_map_conversion` refuses the whole conversion if any of attributes 2..=10 is non-finite. The pset path assigns `get_float(2)` straight in. `sanitize_transform` resets only the axis, scale and factors, not the translations.
- Why it matters: an IFC2x3 file with `IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(1.E400),$)` yields `eastings = inf` and `has_georef() == true`. Every `local_to_map` result is then infinite, and the result is served as valid georef (the TS twin refuses it).
- Fix: put the finite check in `sanitize_transform`, or refuse in the pset path with the same rule. Better still, build both paths from one `MapConversionFields` struct validated in one place.
- Effort: S

### CORE-15: `extract_length_unit_scale` accepts infinite conversion factors and invents 1.0 for unreadable ones
- Category: Bug
- Severity: Medium
- Confidence: LIKELY (the infinite value depends on `lexical_core` returning inf for `1E400`; the georef comment at `georef.rs:397-400` relies on the same behaviour)
- Where: `rust/core/src/units.rs:191-223`
- What: `conversion_value > 0.0` has no `is_finite()` check (both plane-angle twins have one). If the value is not readable, the code falls back to `1.0` and then returns `1.0 * unit_component_scale`.
- Why it matters: an unknown-named conversion unit with factor `1E400` gives a length scale of inf, so every vertex is inf or NaN. An unreadable factor makes a FOOT-like custom unit silently metres (a 3.28× error), the exact case #4690 made `ProjectUnits` refuse.
- Fix: subsumed by CORE-2. Until then, add `value.is_finite()` and return `continue`/`None` instead of `1.0`.
- Effort: S

### CORE-16: Raw STEP literal decoding is implemented four times, and downstream code double-decodes already-decoded strings
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Raw literal to text: `rust/core/src/schema_gen.rs:61-87` (from_token), `rust/core/src/parser/header.rs:68-75` (decode_literal), `rust/processing/src/processor/quick_metadata.rs:90-99`, `rust/export/src/step_log/extract.rs:212-215`
  - Double decode of `get_string()` output: `rust/export/src/landxml_terrain_georef.rs:140`, `rust/geometry/src/alignment_sampling.rs:146,149`
- What: each site does "strip quotes, un-double `''`, then `decode_ifc_string`" by hand. Because `decode_ifc_string` is public and `get_string()`'s docs do not say the value is already decoded, two callers decode twice.
- Why it matters: a name authored as `'C:\\X\\41'` (literal `C:\X\41`) is decoded to `C:\X\41` and then re-decoded to `C:A` in the LandXML export and alignment output.
- Fix: add `step_encoding::decode_step_literal(raw_with_quotes: &[u8]) -> Cow<str>` as the single funnel and use it at the four sites. Document on `DecodedEntity::get_string` that the value is decoded, and remove the second decode at the two sites.
- Effort: S

### CORE-17: The decoder does up to six independent full-file scans for singletons, and the styled-item index is rebuilt per decoder for Hash and Dense indexes
- Category: Perf
- Severity: Medium
- Confidence: LIKELY
- Where:
  - Scans: `rust/core/src/decoder.rs:326-377` (project scan ×2), `rust/core/src/decoder/precision.rs:15-34`, `rust/core/src/decoder/schema_layout.rs:84-104`, `rust/core/src/decoder/styled_items.rs:16-30`
  - Cache placement: `rust/core/src/dense_index.rs:43-48`, `rust/core/src/columnar_index.rs` (only `Columnar` carries `styled_item_index`), `rust/processing/src/processor/entity_index.rs:20-53`
- What: `IFCPROJECT` is located twice, once each for the length and plane-angle scales. Geometric contexts, IfcGrid owners and IfcStyledItem each get their own `EntityScanner` walk. `GridAxisIndex` is shared through all three index stores, but `styled_item_index` lives only on `ColumnarEntityIndex`. With Hash or Dense, which is what native processing uses, every per-element decoder that reaches `styled_item_ids` (annotation validation, `geometry/src/router/annotation_style.rs:11`) rebuilds the inverse index with a full scan.
- Fix: have one source-scoped `SourceFacts` (an `Arc`, built lazily in a single scan) hold the project id, precision range, grid-axis owners and styled-item inverse. Carry that object in every `EntityIndexStore` variant instead of separate fields.
- Effort: M

### CORE-18: Every decode builds a `Token` tree and then an `AttributeValue` tree
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/core/src/decoder.rs:208-244`, `rust/core/src/schema_gen.rs:58-113`
- What: `Token` is used only inside core (no downstream user of `parse_entity` or `Token::`). Every decode allocates a `Vec<Token>` tree (48-byte nodes) and then converts it node by node into a `Vec<AttributeValue>` tree. For big list entities such as point lists or faceset indices, peak memory is about 2.5× the final tree. Strings also go through lossy → replace → decode, up to three allocations.
- Fix: have the nom combinators produce `AttributeValue` directly, or make the token tree an arena. Keep `Token` only if the transient Name read in `caches.rs:22` needs it, which `RecordView` could serve instead.
- Effort: M

### CORE-19: There is no typed attribute layer: about 1,400 magic positional reads downstream, and two `attribute_index` APIs with different semantics
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Counts: `.get(N)` 910, `.get_ref(N)` 331, `.get_float(N)` 170 across rust/ and apps/, against 18 uses of `attribute_index(`
  - `rust/core/src/generated/schema.rs:15707-15709` (`IfcType::attribute_index`: IFC4X3 layout, case-sensitive)
  - `rust/core/src/decoder/schema_layout.rs:49-55` (`EntityDecoder::attribute_index`: follows FILE_SCHEMA, case-insensitive)
  - `IfcProject` attribute 8 is hard-coded at `units.rs:50,257,356,448`, `project_units/mod.rs:69` and `export/src/landxml_terrain_georef.rs:145`
- What: the main way to read an attribute is `entity.get(8)` with a comment naming the slot. The schema-aware lookup exists but is rarely used, and its name collides with the IFC4X3-only one. Some layouts genuinely differ by schema; the decoder's own test shows IfcGridPlacement shifting by one between IFC4 and IFC4X3 (`schema_layout.rs:120-142`).
- Why it matters: every new reader re-derives slot numbers by hand, and schema-dependent slots silently read the wrong attribute in the other schema.
- Fix: have codegen emit per-entity slot constants (e.g. `slots::IFCPROJECT::UNITS_IN_CONTEXT`), with schema-dependent ones resolved through `EntityDecoder::attribute_index`. Rename `IfcType::attribute_index` to `ifc4x3_attribute_index`. Add `DecodedEntity::get_by_name(&mut decoder, "UnitsInContext")` for cold paths.
- Effort: L (incremental)

### CORE-20: `IfcSchema` is threaded through 43 signatures, but only `profile_category` is ever read
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/core/src/schema_gen.rs:346-459`. `schema: &IfcSchema` appears 43 times in rust/; its only read is `rust/geometry/src/profiles/mod.rs:171`.
- What: `geometry_types`, `GeometryCategory`, `geometry_category`, `is_geometry_type` and `is_profile_type` are never read outside core. A std (SipHash) `HashMap<IfcType, _>` is rebuilt for each `IfcSchema::new()`. The file is called `schema_gen.rs` and its header says "Generated from IFC4 EXPRESS schema", but it is hand-written.
- Fix: replace it with `pub fn profile_category(&IfcType) -> Option<ProfileCategory>` (a `match`), drop the `schema` parameter from the processor trait, and rename the module to `attribute_value.rs`.
- Effort: M (cross-crate signature churn, mechanical)

### CORE-21: Dead public surface and dependencies: streaming, fast_parse TFS path, scanner helpers, smallvec
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/core/src/streaming.rs` (whole module; `ParseEvent` and `StreamConfig` have no use outside core; the server's `parse_stream` is an unrelated route)
  - `rust/core/src/fast_parse.rs:140-197,228-333` (`extract_face_indices_from_entity`, `should_use_fast_path`, `extract_first_entity_ref`, `FastMeshData`, `process_triangulated_faceset_direct`, `extract_entity_refs_from_list`: no external callers)
  - `rust/core/src/parser/scanner.rs:312-333` (`find_by_type`, `count_by_type`)
  - `rust/core/src/decoder.rs:487-527` (`get_first_entity_ref_fast`)
  - `rust/core/src/schema_gen.rs:219-233` (`parse_coordinate_list_2d`)
  - `rust/core/Cargo.toml` (`smallvec` is never imported; `futures-core`/`futures-util` and dev `tokio` exist only for streaming)
  - `rust/core/src/lib.rs:5-60` (crate docs advertise nom-only parsing, lexical-core number parsing and the streaming parser)
- What: streaming emits `Progress { percent: 0.0, total_entities: 0 }` and never emits `GeometryReady`. Its wasm timestamp is a hard-coded `0.0`. The `fast_parse` TFS path is a second, string-blind TFS parser that geometry does not use (geometry has its own, see CORE-12).
- Fix: delete these items, the three dependencies and the stale docs. If streaming is kept for external SemVer reasons, put it behind a non-default `streaming` feature.
- Effort: S

### CORE-22: Error type is mostly dead variants, and every error is `ParseError { position: 0 }`
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/src/error.rs` (`InvalidEntityRef`, `InvalidIfcType`, `UnexpectedToken`, `Io`, `Utf8` and `Error::unexpected` have no users), `rust/core/src/decoder.rs:254,266,311`, `rust/core/src/decoder/styled_items.rs:16-30`, `rust/core/src/decoder/precision.rs:12`, `rust/core/src/decoder/caches.rs:30`
- What: "Entity #99 not found" comes out as `Parse error at position 0: …`, and tests pin that exact string (`transient_projection_tests.rs:102`). The styled-item and precision caches store `String` errors and re-wrap them as `Error::parse(0, …)`. `parse_entity` has an unreachable UTF-8 error branch (`tokenizer.rs:331`): the type name is already ASCII alphanumeric.
- Fix: use `NotFound(u32)`, `MalformedRecord { offset, kind }`, `InvalidSpan` and `Budget(&'static str)` variants. Drop the unused ones and carry real offsets.
- Effort: S

### CORE-23: `decode_by_id` never checks that the parsed id matches the requested id
- Category: Bug
- Severity: Low
- Confidence: SUSPECT
- Where: `rust/core/src/decoder.rs:297-314`, `rust/core/src/decoder.rs:280-293`
- What: the index span supplied for X is parsed, and the decoder returns whatever id the bytes contain, caching it under that parsed id. Indexes come from caller-supplied columns (wasm `from_owned_columns`, built by the TS scanner, which is known to diverge from Rust, #4573), so a misaligned span silently hands back entity Y as the answer for X.
- Fix: `if parsed_id != entity_id { return Err(NotFound/SpanMismatch) }` in `decode_by_id` and `decode_at_with_id`. It is one compare.
- Effort: S

### CORE-24: `ColumnarEntityIndex::from_scan` and `from_hashmap` truncate offsets to u32 with only a `debug_assert`
- Category: Bug
- Severity: Low
- Confidence: SUSPECT (latent: the current `from_scan` callers are wasm32)
- Where: `rust/core/src/columnar_index.rs:153,190-191,220-221`
- What: `start as u32` and `(end-start) as u32` are guarded only in debug builds. A native caller with more than 4 GiB of content gets wrapped spans in release, which then decode the wrong bytes (and CORE-23 means that goes unnoticed). Processing guards this itself (`processing/src/processor/entity_index.rs:62-65`), but the public constructors do not.
- Fix: return `Result` or `Option` (e.g. `u32::try_from(end).ok()?`), as `DenseEntityIndex::try_from_columns` does.
- Effort: S

### CORE-25: Three `EntityDecoder` constructors each spell out all 12 fields
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/src/decoder.rs:113-133`, `rust/core/src/decoder.rs:136-156`, `rust/core/src/decoder.rs:159-179` (compare `rust/core/src/columnar_index.rs` `with_arc_columnar_index`, which correctly does `Self::new` plus a setter)
- Fix: `with_index` = `new` + `set_entity_index(Arc::new(index))`, and `with_arc_index` = `new` + `set_entity_index`.
- Effort: S

### CORE-26: Unit label tables are duplicated: SI prefix ×3, conversion symbols ×2, US survey foot ×2
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/src/unit_labels.rs:24-44` against `rust/core/src/project_units/symbols.rs:16-36` against `rust/export/src/step_log/units.rs:4-7`; `rust/core/src/project_units/symbols.rs:111-140` against `rust/export/src/step_log/units.rs:9-35`; `rust/core/src/unit_labels.rs:76-157` against `rust/export/src/step_log/units.rs:50-115`
- What: these are parallel `match` tables that normalise input differently. `try_si_prefix_multiplier` does not trim or upper-case its input; `si_prefix_symbol` does both. The export copy strips every `'` with `replace`, while core uses `trim_matches`. `get_conversion_based_unit_factor` allocates with `to_uppercase()` on every call and carries quoted-name arms (`"'FOOT'"`) that no decoded value can produce. Export copied these because `unit_labels` is `pub(crate)`.
- Fix: keep one `SI_PREFIXES: &[(name, symbol, factor)]` table and one conversion-unit table `(names…, symbol, metres)` in `unit_labels`, and make `normalize_map_unit_name` public so export can use it.
- Effort: S

### CORE-27: A georef MapUnit comment claims the name table holds the US survey foot; it does not
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/src/georef.rs:525-527` against `rust/core/src/unit_labels.rs:58-73`
- What: the comment says "The name table first (it carries the exact defined ratios, e.g. the US survey foot's 1200/3937)". `get_conversion_based_unit_factor` covers only FOOT, INCH, YARD and MILE. The survey foot lives in `infer_map_unit_scale`, which only the ePSet path uses. A conversion-based MapUnit named 'US SURVEY FOOT' therefore falls through to the authored factor.
- Fix: either call `infer_map_unit_scale` here, as the ePSet path does (one MapUnit name rule for both paths), or correct the comment.
- Effort: S

### CORE-28: `decode_ifc_string` is quadratic on many unterminated `\X2\` or `\X4\` escapes
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/src/step_encoding.rs:144-178`, `rust/core/src/step_encoding.rs:213-221`
- What: each `\X2\` without a closing `\X0\` runs `find` (a windows scan) to the end of the string and then advances one byte. A 1 MB string made of repeated `\X2\` costs about n²/8 compares.
- Fix: memoise "no `\X0\` after position p" (one `memmem` search, remembering the result), or find the last `\X0\` once up front.
- Effort: S

### CORE-29: Limits and tolerances are scattered as magic numbers, not kept in `limits.rs`
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `rust/core/src/decoder/styled_items.rs:17,32,44,60,74` (256 MiB, used twice; 16 KiB; 1,000,000; 64)
  - `rust/core/src/parser/scanner_header.rs:228` (256 KiB) against `rust/core/src/parser/header.rs:14` (64 KiB)
  - `rust/core/src/parser/tokenizer.rs:175` (MAX_NESTING_DEPTH)
  - `rust/core/src/model_bounds.rs:260` (1000.0)
  - `rust/core/src/georef.rs:179,182,232` (f64::EPSILON used as a geometric tolerance)
  - `rust/core/src/fast_parse.rs:27,34`, `rust/core/src/decoder.rs:46`, `rust/core/src/columnar_index.rs` (`/50` capacity heuristics)
- What: `limits.rs` documents itself as the home for shared walk limits, but most budgets live inline. The two header windows disagree (see CORE-9).
- Fix: move them into named constants in `limits.rs`, with a doc line each.
- Effort: S

### CORE-30: Fuzzing covers only `parse_entity`, with four seeds
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/fuzz/fuzz_targets/parse_entity.rs`, `rust/core/fuzz/corpus/parse_entity/` (4 files)
- What: these untrusted-byte entry points are never fuzzed:
  - `EntityScanner::next_entity`, `close_step_record` and `data_section_start`
  - `StepListItems` and `nth_attribute_is_present`
  - `decode_ifc_string`
  - `header::declared_schemas`
  - `fast_parse::*` and `parse_step_numeric`
  - `model_bounds::scan_*`
  - `AttributeValue::from_token`
  - The decoder `*_fast` accessors

  They are exactly the hand-rolled code flagged in this review. There is also no differential target to catch drift between grammars (CORE-6, -8, -9, -12).
- Fix: add `scan_file` (scanner + `build_entity_index` + decode every span), `decode_string`, and a `differential_numbers` target asserting that tokenizer, `parse_step_numeric` and the fast accessors agree on acceptance. Seed them from `tests/fixtures/*.json`.
- Effort: S

### CORE-31: Scan diagnostics go to a global `OnceLock` sink or `eprintln!` as side effects
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/src/parser/report_sink.rs`, `rust/core/src/parser/oversized_ids.rs`, `rust/core/src/decoder.rs:52`, `rust/core/src/columnar_index.rs` `from_scan`
- What: library code prints to stderr by default, and the sink can be set only once per process. `build_entity_index` reports on every call, including per-decoder lazy index builds. The unit and precision scans walk the same scanner and never report, so reporting is inconsistent.
- Fix: return diagnostics as values (`ScanReport { oversized: usize, malformed: Option<usize> }`) from index builders and let the orchestrator log them. Keep the sink only for legacy entry points.
- Effort: M

### CORE-32: The tokenizer reads STEP binary literals (`"…"`) as text strings
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/src/parser/tokenizer.rs:78-102`, `rust/core/src/schema_gen.rs:61-87`
- What: `"0FF"` (the ISO 10303-21 binary form used by IfcBlobTexture and IfcPixelTexture) becomes `Token::String` and then `AttributeValue::String`, with `""` un-doubling and `\` escape decoding applied, although binary literals have neither. Geometry reads textures from raw bytes, so nothing breaks today, but `get_string()` on a binary slot returns hex as if it were text.
- Fix: add `Token::Binary` and `AttributeValue::Binary(Vec<u8>)` (or keep the raw hex) with no text decoding.
- Effort: S

### CORE-33: `AttributeValue` accessors are asymmetric
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/src/schema_gen.rs:146-176`
- What: `as_float` unwraps typed values and accepts Integer. `as_int` does not unwrap typed values (`IFCINTEGER(5)` returns `None`) and silently truncates Float with `as i64` (3.7 → 3, NaN → 0). There is no `as_string` that sees through `IFCLABEL('x')`, which is why `georef_pset.rs:22-32` hand-rolls one.
- Fix: route all accessors through the CORE-4 `unwrap_typed()`, and make `as_int` refuse non-integral floats.
- Effort: S

### CORE-34: `IfcType::is_subtype_of` clones, and registry misses allocate
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/src/generated/schema.rs:8490-8500`, `rust/core/src/generated/schema_registry.rs:114-220`
- What: `Some(self.clone())` allocates a `String` for every `Unknown` receiver on every call, and each parent step is another 1000-arm match. `SchemaVersion::is_subtype_of` and `entity_info` call `from_str` (allocating an `UnknownIfcType` and a CRC) at each step, even for names that are simply absent.
- Fix: compare by reference (`let mut cur: Option<&Self>` or a `known_index`). Make the registry lookups `Option`-returning table lookups (CORE-7).
- Effort: S

### CORE-35: The header scanner has two near-identical keyword finders and a third argument splitter
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/src/parser/header_scan.rs:84-113` against `rust/core/src/parser/header_scan.rs:119-147` (jscpd); `rust/core/src/parser/header.rs:19-59` (`split_top_level`) against `rust/core/src/parser/scanner_attributes.rs:35-127` (`StepListItems`)
- What: `find_record_open` and `find_section_marker` differ only in the after-keyword check and whether they look for `(` or `;`. `split_top_level` is another top-level comma splitter: it also counts `[`/`]` and returns owned `String`s.
- Fix: write one `find_keyword_then(haystack, kw, expect: u8)`. Build `split_top_level` on `StepListItems` (adding `[ ]` support there if headers need it).
- Effort: S

### CORE-36: Test fixtures are copy-pasted
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/src/units_tests.rs:183-201` against `378-396`, `216-234` against `275-293` and `305-321`; `rust/core/src/georef_tests.rs:147-159` against `247-259` (jscpd); minimal `ISO-10303-21;HEADER;…DATA;` builders are re-typed across `units_tests.rs`, `georef_tests.rs`, `project_units/tests.rs` and `decoder/schema_layout.rs` tests
- Fix: add a `#[cfg(test)] mod test_support` with `ifc_file(schema, &[records])` and `unit_assignment(units…)` builders.
- Effort: S

### CORE-37: The AttributeValue-based coordinate helpers default missing values to 0, contrary to #5266, and their geometry fallback is effectively unreachable
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/src/schema_gen.rs:197-285`; caller `rust/geometry/src/processors/tessellated/mod.rs:52-63`
- What: `parse_coordinate_list_3d` and `_3d_f64` give a missing or corrupt component `0.0`, and `parse_index_list` gives a missing index vertex 0. The strict raw path refuses the same input. In geometry the AttributeValue path runs only when `get_raw_bytes` returns `None`, but then `decode_by_id` fails on the same lookup, so the fallback cannot produce output.
- Fix: delete these helpers together with the unreachable fallback, or make them refuse with the same rule as `read_coordinate_list`.
- Effort: S

### CORE-38: `from_hashmap` and `from_hashmap_consuming` take two different sort paths for one conversion
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/src/columnar_index.rs` (`from_hashmap_consuming`: row tuples plus `sort_unstable_by_key`; `from_hashmap`: column vectors plus the `from_unsorted` permutation)
- Fix: make `from_hashmap(&m)` equal to `from_hashmap_consuming(m.clone())`, or route both through `from_unsorted`.
- Effort: S

### CORE-39: The public surface is wider than it needs to be
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/core/src/lib.rs:62-81` (every module is `pub mod`, including `generated`, `fast_parse`, `streaming` and `parser::header` with `Lex` and its `pub searches` counter field), `rust/core/src/lib.rs:94-99`
- What: internal helpers are part of the semver surface, so removing dead code (CORE-21) or reshaping internals counts as a breaking change for the published crate.
- Fix: make modules `pub(crate)` and re-export a curated API from `lib.rs`. Mark `Lex::searches` `#[cfg(test)]` or `pub(crate)`.
- Effort: S

## Concept inventory
- vector/matrix: `GeoReference::to_matrix` (column-major 4×4) `rust/core/src/georef.rs:248`
- vector/matrix: `GeoReference::local_to_map` / `map_to_local` `rust/core/src/georef.rs:213` / `rust/core/src/georef.rs:228`
- vector/matrix: `GeoReference::rotation` (atan2) `rust/core/src/georef.rs:151`
- vector/matrix: `GeoReference::sanitize_transform` (direction normalise) `rust/core/src/georef.rs:177`
- transforms/placements: placement-transform memo `[f64;16]` (`cache_placement_transform` / `get_placement_transform_cached`) `rust/core/src/decoder/caches.rs:128-156`
- transforms/placements: `MAX_PLACEMENT_DEPTH` `rust/core/src/limits.rs:74`
- transforms/placements: `MAX_MAPPED_ITEM_DEPTH` `rust/core/src/limits.rs:39`
- transforms/placements: `GridAxisIndex` / `grid_of_axis` `rust/core/src/decoder/schema_layout.rs:27,64`
- tolerances/epsilons: `LARGE_COORD_THRESHOLD_METERS`, `coord_is_large`, `RtcVerdict` `rust/core/src/limits.rs:104,109,121`
- tolerances/epsilons: raw `1000.0` placement filter `rust/core/src/model_bounds.rs:260`
- tolerances/epsilons: `f64::EPSILON` direction and scale guards `rust/core/src/georef.rs:179,182,232`
- tolerances/epsilons: `MAX_NESTING_DEPTH` `rust/core/src/parser/tokenizer.rs:175`
- tolerances/epsilons: `MAX_UNIT_RESOLVE_DEPTH` / `MAX_UNIT_RESOLVE_DECODES` `rust/core/src/project_units/mod.rs:175,188`
- tolerances/epsilons: `MAX_HEADER_BYTES` `rust/core/src/parser/header.rs:14`
- tolerances/epsilons: header skip cap `1<<18` `rust/core/src/parser/scanner_header.rs:228`
- tolerances/epsilons: styled-item budgets `rust/core/src/decoder/styled_items.rs:17,44,60,74`
- tolerances/epsilons: geometric-context precision range `rust/core/src/decoder/precision.rs:6`
- unit conversion: `extract_length_unit_scale` `rust/core/src/units.rs:31`
- unit conversion: `try_extract_length_unit_scale` `rust/core/src/units.rs:249`
- unit conversion: `try_extract_plane_angle_to_radians` `rust/core/src/units.rs:346`
- unit conversion: `extract_plane_angle_to_radians` `rust/core/src/units.rs:442`
- unit conversion: `EntityDecoder::length_unit_scale` / `plane_angle_to_radians` / `seed_unit_scales` `rust/core/src/decoder.rs:357,326,391`
- unit conversion: `ProjectUnits::resolve`, `resolve_unit_by_ref`, `conversion_factor_scale` `rust/core/src/project_units/mod.rs:60,139,347`
- unit conversion: `si_unit_symbol_and_scale`, `si_prefix_symbol`, `conversion_unit_symbol`, `compose_derived` `rust/core/src/project_units/symbols.rs:96,16,111,144`
- unit conversion: `measure_unit` `rust/core/src/project_units/measure.rs`
- unit conversion: `try_si_prefix_multiplier` / `get_si_prefix_multiplier` / `get_conversion_based_unit_factor` / `infer_map_unit_scale` / `US_SURVEY_FOOT_SCALE` `rust/core/src/unit_labels.rs:24,51,58,199,76`
- unit conversion: georef `resolve_measure_with_unit` `rust/core/src/georef.rs:285`
- unit conversion: MapUnit resolution `rust/core/src/georef.rs:493`
- bbox/AABB: `ModelBounds` (expand, centroid, has_large_coordinates, rtc_offset) `rust/core/src/model_bounds.rs:16-122`
- bbox/AABB: `scan_model_bounds` / `scan_placement_bounds` `rust/core/src/model_bounds.rs:140,217`
- hashing: `crc32_hash` (IEEE table; 5 generated copies) `rust/core/src/generated/schema.rs:16771` and `rust/core/src/generated/{ifc2x3,ifc4,ifc4x1,ifc4x2}/schema.rs`
- hashing: `IfcType::id` / `from_id` (CRC32 type ids) `rust/core/src/generated/schema.rs:3330,2302`
- hashing: `UnknownIfcType::id` `rust/core/src/generated/schema.rs:32`
- hashing: FxHashMap entity index `EntityIndex` `rust/core/src/decoder.rs:33`
- triangulation/polygon ops: none in core
- triangulation/polygon ops (index-list decoding only): `parse_indices_direct` `rust/core/src/fast_parse.rs:48`, `AttributeValue::parse_index_list` `rust/core/src/schema_gen.rs:239`
- entity attribute access/decoding: `AttributeValue` (`as_entity_ref`, `as_string`, `as_enum`, `as_float`, `as_int`, `as_list`, `is_null`) `rust/core/src/schema_gen.rs:37-191`
- entity attribute access/decoding: `DecodedEntity::{get,get_ref,get_string,get_float,get_list,get_refs}` `rust/core/src/schema_gen.rs:309-343`
- entity attribute access/decoding: `EntityDecoder::attribute_index` (schema-aware) `rust/core/src/decoder/schema_layout.rs:49`
- entity attribute access/decoding: `IfcType::attribute_index` / `attribute_names` (IFC4X3) `rust/core/src/generated/schema.rs:15707,8662`
- entity attribute access/decoding: `attribute_names_for_schema` / `entity_info_for_schema` `rust/core/src/generated/schema_registry.rs:228-247`
- entity attribute access/decoding: `StepListItems`, `nth_attribute_is_present`, `argument_list_start` `rust/core/src/parser/scanner_attributes.rs:35,146,164`
- entity attribute access/decoding: decoder fast accessors `get_raw_bytes`, `get_first_entity_ref_fast`, `get_polyloop_point_ids_fast`, `get_cartesian_point_fast`, `get_face_bound_fast` `rust/core/src/decoder.rs:475-708`
- entity attribute access/decoding: `get_entity_ref_list_fast(_into)`, `get_polyloop_coords_cached(_into)` `rust/core/src/decoder/fast_buffers.rs:13-198`
- entity attribute access/decoding: `decode_string_by_id_transient` `rust/core/src/decoder/caches.rs:22`
- entity attribute access/decoding: `fast_parse::{parse_coordinates_direct(_f64), extract_coordinate_list_from_entity(_f64), extract_entity_type_name, extract_first_entity_ref, extract_entity_refs_from_list, extract_face_indices_from_entity}` `rust/core/src/fast_parse.rs`
- entity attribute access/decoding: `parse_step_numeric` / `step_numeric_literal_len` `rust/core/src/parser/numeric_literal.rs:417,456`
- entity attribute access/decoding: `parse_express_id(_prefix)` `rust/core/src/express_id.rs`
- entity attribute access/decoding: `decode_ifc_string`, `step_string_literal_end`, `is_page_quote_operand` `rust/core/src/step_encoding.rs:86,63,51`
- entity attribute access/decoding: `keyword_eq` / `keyword_starts_with` / `keyword_ends_with` / `find_keyword` `rust/core/src/parser/keyword.rs:40-92`
- entity attribute access/decoding: `ifc_type_from_keyword`, `ifc_type_from_record`, `normalise_uppercase` `rust/core/src/schema_helpers.rs:243,292,38`
- entity attribute access/decoding: header `split_top_level`, `decode_opt_string(_list)`, `extract_record_args`, `Lex` `rust/core/src/parser/header.rs:19-198`, `rust/core/src/parser/header_scan.rs:10`
- entity attribute access/decoding: georef `compound_plane_angle_to_degrees` `rust/core/src/georef_parse.rs`
- entity attribute access/decoding: `pset_value_string` `rust/core/src/georef_pset.rs:22`
- colour/style resolution: `EntityDecoder::styled_item_ids` (IfcStyledItem inverse index) `rust/core/src/decoder/styled_items.rs:16`; no colour logic in core
- error types: `ifc_lite_core::Error` / `Result` (thiserror) `rust/core/src/error.rs`
- error types: `ColumnLengthMismatch` `rust/core/src/columnar_index.rs`
- error types: `StyledItemIndexResult = Result<_, String>` `rust/core/src/decoder.rs:30`
- error types: precision cache `Result<_, String>` `rust/core/src/decoder.rs:91`
- error types: `RecordClose` / `RecordEnd` / `QuoteEnd` (scanner outcome enums) `rust/core/src/parser/lexical.rs:119`, `rust/core/src/parser/scanner_record_end.rs:18`, `rust/core/src/parser/record_strings.rs:207`
