I found 22 issues in the merge and schema-conversion slice. The most serious is a downgrade bug: IFC4→IFC2X3 output contains records the target schema rejects, with no warning. All findings below come from reading the code; I edited nothing and ran no cargo. I checked for HashMap iteration order reaching the merged output, chosen ids, warnings or minted GUIDs and found none (the code iterates `ModelIndex.order`, BTree sets or sorted vectors). Id offsetting uses `checked_add`/`saturating_add`, and I found no panics on UTF-8 slicing.

### EXPORT-MERGE-1: The Rust schema converter does not trim attributes the target schema lacks, except for 30 hand-listed types
- Category: Bug
- Severity: High
- Confidence: CONFIRMED
- Where: rust/export/src/schema_convert.rs:173-188 (`ifc2x3_attr_count`), :351-378, :389-396; rust/export/src/schema_pad.rs:217; TS twin packages/export/src/schema-converter.ts:416-436
- What: The TS twin trims or pads by a general rule: whichever attribute-name list is a strict prefix of the other wins. Rust only pads upgrades (`schema_pad`) and only trims IFC2X3 targets whose type is in the hand table `ifc2x3_attr_count`. I compared the generated arity tables: 64 types keep the same name but are longer in IFC4 than in IFC2X3 and are not in that table. Examples: `IFCMATERIAL` (3→1), `IFCQUANTITYLENGTH/AREA/COUNT/…` (5→4), `IFCMATERIALLAYER`, `IFCSTAIRFLIGHT` (13→12), `IFCRAMPFLIGHT`, `IFCBUILDINGELEMENTPART`, `IFCFASTENER`. Upgrades never trim either: 11 types are shorter in IFC4 than in IFC2X3, e.g. `IFCDISTRIBUTIONCONTROLELEMENT` (9→8) and `IFCLSHAPEPROFILEDEF`. The sweep fixture has only 1 IFC4→IFC2X3 case.
- Why it matters: `#7=IFCMATERIAL('Concrete',$,$);` downgraded to IFC2X3 keeps 3 attributes where IFC2X3 declares 1. The follow-up passes (`fill_required`, `EnumReconciliation::reconcile`, `Ifc4SlotCheck::count`) all skip a line whose attribute count differs from the target's, so the record is neither fixed nor counted. Every IFC4 material and quantity in an IFC2X3 export is invalid, silently.
- Fix: Port `isStrictAttrPrefix` into `convert_record` using `ifc_lite_core::generated::schema_registry::SchemaVersion::{Ifc2x3,Ifc4,Ifc4x3}.attribute_names`, run in both directions. Delete `ifc2x3_attr_count` and the `schema_pad` tables. Add downgrade rows to `schema_upconvert_sweep.json`.
- Effort: M

### EXPORT-MERGE-2: Per-schema attribute data exists 5+ times, and the reason given for the `schema_pad` tables is out of date
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - core: rust/core/src/generated/schema_registry.rs:41-247 and core/src/generated/{ifc2x3,ifc4,…}/schema.rs (`attribute_names`, `entity_info`, `is_subtype_of`), generated from EXPRESS by @ifc-lite/codegen
  - export generated tables:
    - generated/ifc2x3_entity_names.rs (names only)
    - generated/ifc2x3_required_slots.rs (arity column)
    - generated/ifc4_required_slots.rs (arity column)
    - generated/enum_reconciliation.rs (arity column)
    - generated/step_log_tables.rs (`NAME_LISTS`)
  - hand-written in export:
    - schema_convert.rs:71-107 (`by_name_attr_remap_names`)
    - schema_convert.rs:173-188 (`ifc2x3_attr_count`)
    - schema_pad.rs:41-197 (pad tables)
- What: `schema_pad.rs:24-26` says "Rust has no per-schema attribute table… `IfcType` is IFC4X3 alone". That is no longer true: core has had independent IFC2X3/IFC4/IFC4X1/IFC4X2/IFC4X3 registries since 2026-09-20. The export generators (`scripts/generate-ifc2x3-entity-names.mjs`, `generate-ifc2x3-required-slots.mjs`, `generate-ifc4-required-slots.mjs`, `generate-enum-reconciliation.mjs`, `generate-step-log-tables.mjs`) read the TS registries under packages/parser and packages/data. CI's `--check` steps (test.yml:1909-1937) only compare the Rust output against those TS sources. Nothing cross-checks them against core's registry.
- Why it matters: There are two independent derivations of the same EXPRESS facts in Rust, and the hand tables have already drifted (EXPORT-MERGE-9).
- Fix: Use core's `SchemaVersion` as the single home for entity names, arities and attribute names. Keep the generated export tables only for what core lacks (OPTIONAL flags, enum members and their policy). Add one Rust test asserting that every generated row's arity equals `attribute_names().len()`.
- Effort: M

### EXPORT-MERGE-3: Two copies of the leading-GlobalId reader and validator, and the doc names the unused one as the only production path
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/export/src/rooted_type.rs:66-91 (`extract_leading_guid`, `is_global_id_shaped`)
  - merged/guid.rs:64-68 (`is_global_id`), :87 (`is_rooted_entity_type`, a pure wrapper), :94-111 (`extract_global_id_fast`), :115 (`entity_type_upper`), :146 (`read_leading_guid`), :159 (`replace_global_id`)
  - merged/tests.rs:1206 (`leading_guid_tokens`)
  - examples/merge_ifc.rs:179 (`type_token`)
  - rust/processing/src/appearance/authored.rs:49 (`valid_guid`)
- What: rooted_type.rs:52-64 says `extract_leading_guid` is "this crate's only sanctioned way… the sole production GlobalId path… `merged::leading_guid` is a one-line wrapper around it". In fact `extract_leading_guid` is only called from tests; production uses `extract_global_id_fast`, a copy that adds a 128-byte window. The validators also disagree: processing's `valid_guid` requires the first char in `0-3` (correct for 128 bits), while export's two validators accept any of the 64 chars.
- Why it matters: Fixes land in one copy only, and the doc points maintainers at the wrong function.
- Fix: One `ifc_guid` module (alphabet, `is_global_id`, `leading_global_id(type, line)`) with the stricter first-char rule. Delete `extract_leading_guid`/`is_global_id_shaped` and the wrapper, and correct the rooted_type docs.
- Effort: S

### EXPORT-MERGE-4: Schema-family detection exists 9 times with different rules
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/export/src/schema_convert.rs:14-27 (`canon`)
  - step_log/attrs.rs:20-46 (`schema_family`)
  - step_log/write.rs:159 (`target_is_ifc2x3` inline)
  - schema_convert.rs:402 (`targets_ifc2x3`)
  - step_map_transform.rs:67-72 (allowlist)
  - file_schema.rs:42 (`file_schema_identifier`)
  - schema_detect.rs:13 (`detect_schema`)
  - merged/header.rs:13 (`output_schema`)
  - rust/processing/src/processor/schema_detection.rs:20
  - rust/core/src/generated/schema_registry.rs:41 (`SchemaVersion::from_file_schema`)
- What:
  - `canon` doesn't trim, so `" IFC2X3"` resolves to IFC4; write.rs trims.
  - `canon` defaults unknown labels (e.g. `IFC2X2_FINAL`) to IFC4. `from_file_schema` returns `None` for them and keeps IFC4X1/X2 separate.
  - `canon` and `schema_family` check prefixes in different orders, and only `canon` maps `IFCX` to IFC5.
  - `file_schema_identifier` is case-sensitive while `canon` is not. An explicit merge target `"ifc4x3"` is converted as IFC4X3 but declared verbatim in lower case, not as `IFC4X3_ADD2` (merged/header.rs:24-28).
  - Processing defaults to IFC2X3 after a whole-file scan.
- Why it matters: The same file is classified differently by the exporter, the step_log writer and the processor.
- Fix: One `SchemaFamily` enum in core next to `SchemaVersion::from_file_schema`, with case-insensitive, trimming parsing and a `file_identifier()` method. Use it at every site above.
- Effort: M

### EXPORT-MERGE-5: Five STEP argument splitters; only one skips `/* comments */`
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED (drift); LIKELY (impact)
- Where:
  - rust/export/src/step_slot.rs:104 (`split_top_level_args`: handles comments, validates)
  - merged/line_edit.rs:99 (`arg_span`), :127 (`split_args`)
  - merged/spatial.rs:55 (`nth_attr`)
  - schema_pad.rs:233 (`count_top_level_attributes`)
  - step_text.rs:227 (`attribute_of`) correctly delegates
  - core header splitter: core/src/parser/header.rs:19
- What: Only `split_top_level_args` treats a comment as one unit. The other four count commas and quotes inside comments.
- Why it matters: Take `#7=IFCRELAGGREGATES('q',$,$,/* it's */$,#1,(#2));`. The `'` in the comment opens a literal, so `nth_attr` returns `None`. `ParentClaims::claim` (single_parents.rs:139 `read_side`) then sees no members and writes the rel unmodified, so the child gets a second `Decomposes` parent (WR41). Separately, a comma inside a comment makes `count_top_level_attributes` overcount, which suppresses padding.
- Fix: Make `step_slot` the single tokenizer and expose a borrowed-slice variant (`top_level_spans(&str) -> Option<Vec<Range>>`). Rebuild `nth_attr`, `arg_span`/`split_args` and the attribute count on top of it.
- Effort: M

### EXPORT-MERGE-6: The record-parsing prologue is copied 5 times, and each IFC2X3 line is split 5-6 times
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - schema_convert.rs:293-318 (`convert_record`)
  - schema_ifc2x3_slots.rs:95-104 (`fill_required`)
  - schema_ifc4_slots.rs:56-64 (`count`)
  - schema_enum.rs:101-110 (`reconcile`)
  - schema_owner_history.rs:68-76 (`fill`)
  - binary-search row lookups at schema_ifc2x3_slots.rs:125, schema_ifc4_slots.rs:98, schema_enum.rs:105
- What: Each site repeats `find('(')` / `rfind(')')` / `find('=')`, upper-cases the type, does `split_top_level_args`, then an arity guard. The null-slot test has drifted: `is_null_token` (schema_ifc4_slots.rs:75) accepts surrounding comments, while 2X3 fill and owner history use `slot.trim() != "$"`.
- Why it matters: For an IFC2X3 target one line is split at :316 (validate), :248 or :134, then by owner-history, by 2X3 fill and by enum reconciliation. Each split builds a `Vec<char>` and a `Vec<String>`. On top of that, `canon` (`to_uppercase`) allocates 3+ times per line (convert_step_line, convert_entity_type). `$ /*x*/` in a mandatory IFC2X3 slot is not filled.
- Fix: Parse once into a `StepRecord { prefix, type_upper, slots: Vec<String>, suffix }` in step_slot.rs and pass it through convert → owner history → slot fill → enums → IFC4 count, serialising once. Make `canon` return an enum without allocating.
- Effort: M

### EXPORT-MERGE-7: step_map has three pairs of near-identical graph walkers and duplicated map edits
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - mapped-representation depth DFS: step_map_rigid_contexts.rs:52-161 vs step_map_transform_preflight.rs:164-224
  - context-chain walk: step_map_rigid_contexts.rs:95-119 vs preflight.rs:231-242
  - placement-chain walk: step_map_rigid.rs:193-254 (`placement_root`) vs preflight.rs:277-312
  - neutral MapConversion edits: step_map_transform.rs:161-166 vs step_map_rigid.rs:166-177
  - `transform_north` + `output.finish()` tail repeated in both planners
- What: The walkers share the same postorder, active/seen sets and work-budget logic, with small differences in depth accounting (`+1` per child vs `max+1`, `added_levels`). In addition, `.map_err(|error| error.to_string())` appears 44 times, while the `required()` helper exists only in preflight.
- Why it matters: Each depth or budget fix has to be made twice, and the rigid and scaled paths can disagree on what is valid input.
- Fix: One `mapped_depth_walk(roots, ctx, budget, reserve)` and one `walk_context_chain` in preflight, used by both paths. Share a `neutral_map_edits(map, unit)` helper. Add a `decode(id) -> Result<_, String>` helper.
- Effort: M

### EXPORT-MERGE-8: Downgrading IfcAlignment/IfcReferent to IFCPROXY keeps the source attributes, producing a short, invalid IfcProxy
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED (shared with TS twin, schema-converter.ts:145-147)
- Where: rust/export/src/schema_convert.rs:161-162 (`map_4x3_to_4` → `"IFCPROXY"`), :351-366
- What: The four ALIGNMENT* types in `should_skip_entity` get a synthesised 9-attribute `IFCPROXY(…)`. `IFCALIGNMENT|IFCREFERENT|IFCLINEARELEMENT|IFCPOSITIONINGELEMENT|IFCLINEARPOSITIONINGELEMENT` are only renamed, so `#1=IFCALIGNMENT('g',$,'A',$,$,$,$,.ROAD.);` becomes `IFCPROXY('g',$,'A',$,$,$,$,.ROAD.)`. That is 8 attributes where IfcProxy has 9 (ifc4_required_slots.rs:411), with `.ROAD.` in `ProxyType : IfcObjectTypeEnum`. The arity guards then skip both enum reconciliation and the required-slot count.
- Why it matters: Every IFC4X3 alignment downgraded to IFC4 or IFC2X3 is invalid, and no warning is raised.
- Fix: Send these types through the same proxy synthesis as `resolve_unrepresented_entity` (schema_unrepresented.rs:88): a fixed 9-attribute layout keeping GlobalId, Name, ObjectPlacement and Representation.
- Effort: S

### EXPORT-MERGE-9: Two wrong counts in the hand-written IFC2X3 attribute table
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/schema_convert.rs:179 (`IFCDISTRIBUTIONCONTROLELEMENT` => 8), :183 (`IFCPILE` => 11)
- What: The generated IFC2X3 table says 9 (`ifc2x3_required_slots.rs:163`) and 10 (`:316`). I compared all 30 entries programmatically; only these two differ.
- Why it matters: An IFC4→IFC2X3 `IfcDistributionControlElement` is one attribute short (ControlElementId missing), and the 2X3 fill's arity guard then skips it silently. The IfcPile value is harmless today but wrong.
- Fix: Covered by EXPORT-MERGE-1/2 (read the arity from the registry). If the table stays as a stopgap, correct both values.
- Effort: S

### EXPORT-MERGE-10: `unify_spatial` copies every line of each later model to a String before checking its type
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/merged/plan.rs:191-194
- What: The loop does `let Some(line) = index.line_str(id) else {continue};`, a lossy String copy, and only then `match ty.as_str()`. Only IFCSITE, IFCBUILDING and IFCBUILDINGSTOREY lines need the text.
- Why it matters: Every later model's whole file is reallocated line by line. This happens again in the empty-container pre-pass (empty.rs:167).
- Fix: Match on `ty` first and call `line_str` only inside the three arms.
- Effort: S

### EXPORT-MERGE-11: The merge repeats whole-model passes and stores one heap String per entity
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `ModelIndex::build`: model 0 is built at merged/mod.rs:197, empty.rs:149 and mod.rs:234; every model is built twice when `drop_empty_containers` is on
  - `resolve_length_scale(model 0)` runs 3 times: mod.rs:213, units.rs:61 (computed then thrown away when `i==0`), empty.rs:123
  - `output_schema` / `detect_schema`: mod.rs:155 + empty.rs:124, mod.rs:286 + empty.rs:182
  - plan.rs:35/68/78: `type_of: HashMap<u32, String>`
- Why it matters: Multi-GB federations pay for several full scans and the type-name allocations of millions of entities.
- Fix: Build each `ModelIndex` once and pass the first-model facts, `primary_scale` and `schema` into `plan_drops`. Skip `resolve_length_scale` at `i==0`. Store the type as `&'a str` (a slice of `content`) or as `IfcType`.
- Effort: M

### EXPORT-MERGE-12: `apply_folds` splits the output on newlines, so a fold into a multi-line source record is lost
- Category: Bug
- Severity: Low
- Confidence: LIKELY
- Where: rust/export/src/merged/single_parents.rs:285-299
- What: Emitted lines are the raw `EntityScanner` spans (any internal newlines are kept), but `apply_folds` iterates `out.split_inclusive('\n')`. For an owner rel wrapped across lines, `rel_id` matches the first fragment, then `append_to_list_attr` finds no closing `)` and returns `None`.
- Why it matters: On IFC2X3 output from exporters that wrap long lines, the folded objects lose their `IfcRelDefinesByProperties`. A warning ("Could not add …") is emitted, but the fold could have been done.
- Fix: Record each owner's byte span in `out` during emit and patch by span, or iterate over records with `EntityScanner` instead of lines.
- Effort: S

### EXPORT-MERGE-13: Four copies of the `#N` and `(#a,#b)` parsers, two copies of the `IFCREL` check, three of the "id of a `#N=` line" reader
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - plan.rs:220-232 (`parse_single_ref`, `parse_ref_list`) and empty.rs:371-383 (`single_ref`, `ref_list`): byte-identical
  - line_edit.rs:163 (`parse_ref`)
  - single_parents.rs:144 (inline `strip_prefix('#')?.parse()`)
  - `rel_id` single_parents.rs:150 ≡ merged/tests.rs:455 `leading_id` ≡ examples/merge_ifc.rs:171 `leading_express_id`
  - `guid::is_relationship_type` (guid.rs) vs inline `starts_with("IFCREL")` at empty.rs:332, :343
- What: The comment at line_edit.rs:155-159 kept the copies to avoid a refactor riding on the #3421 fix. That was a scope note for one PR, not a reason to keep them.
- Fix: Make `line_edit::parse_ref` plus a `parse_ref_list` the one home (using `parse_express_id`), and export a `record_id(line)` helper.
- Effort: S

### EXPORT-MERGE-14: The GUID alphabet is defined in three places, with two different minting schemes
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/merged/guid.rs:13 (`GLOBAL_ID_CHARS` + `deterministic_global_id`), schema_convert.rs:226-237 (`placeholder_guid`, local `const A`), rust/processing/examples/schema_detection_bench_4661.rs:22
- What: `placeholder_guid` uses a separate base-64 encoder (id + 0x1000_0000, right-aligned with leading zeros) instead of `deterministic_global_id`. The divergence from TS is pinned on purpose (schema_convert_tests.rs:131), but the alphabet and encoder are still duplicated.
- Fix: Move the alphabet and a `encode_bits_128` helper into the `ifc_guid` module from EXPORT-MERGE-3. Keep `placeholder_guid` as a thin seed-to-id wrapper until the maintainer decides on TS parity.
- Effort: S

### EXPORT-MERGE-15: Two STEP REAL formatters; the map writer's exponent branch can never run
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/step_map_transform_writer.rs:87-93 (`real`) vs rust/export/src/step_log/jsval.rs:109 (`format_step_real`), :126 (`to_step_real`)
- What: `real` uses `f64::to_string`, which never produces exponent notation in Rust, so its `split_once(['e','E'])` branch is unreachable. `1e-300` is written as 300+ digits. Non-finite handling differs: `Err` here, `"0."` in step_log.
- Fix: Use one `step_real(v) -> Option<String>` (shortest round-trip with a STEP exponent) in step_text.rs, called by both.
- Effort: S

### EXPORT-MERGE-16: Test oracles use their own `#ref` scanners that have drifted from production
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - rust/export/src/merged/tests.rs:362-399 (`assert_no_dangling`) and :424-452 (`refs_in_line`) (jscpd 366-378 ↔ 427-439)
  - examples/merge_ifc.rs:196 (`refs_in`)
  - `spec_unescape` at merged/tests.rs:145 and step_text_tests.rs:68
- What: Both merged/tests.rs scanners toggle `in_str` on every `'`, while production uses `step_string_literal_end` (#7589). A `\S\'` in a test string flips the oracle's quote state. The example copies `refs_in_line_counted` because that function is `pub(crate)`.
- Fix: Have `assert_no_dangling` call the local `refs_in_line`, implemented with `step_string_literal_end`. Make `refs_in_line_counted` available to the example (`pub` or `#[doc(hidden)] pub`). Move `spec_unescape` into a shared test helper.
- Effort: S

### EXPORT-MERGE-17: Repeated inline STEP-file wrappers in tests
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - byte-identical pair: tests/merged_single_parent_parity.rs:48 (`file`) and tests/merged_single_inverses.rs:17 (`model`)
  - other wrappers:
    - tests/issue_4660_merged_keyword_case.rs:22
    - tests/issue_5365_enum_reconciliation.rs:11
    - tests/schema_upconvert_parity.rs:44-49
    - src/merged/empty_tests.rs:39-48
    - src/merged/empty_claims_tests.rs:10
    - src/schema_convert_tests.rs:315
    - src/file_schema.rs:34
    - src/merged/units.rs:141-142
  - 58 inline `ISO-10303-21;` headers in src/merged/tests.rs and 26 in schema_detect_tests.rs
  - step_map tests mutate fixtures via `.replace(...)`, which does nothing if the pattern is missing (e.g. step_map_rigid_tests.rs:6-11, :18)
- What: `test_support.rs` only handles on-disk fixtures; there is no shared in-memory STEP builder.
- Fix: Add `test_support::step_file(schema, &[lines])` (and a `tests/common/mod.rs` twin for integration tests). Replace `.replace()` mutations with an asserting helper (`replace_once`).
- Effort: S

### EXPORT-MERGE-18: `ModelIndex::build` keeps the last span but the first type for duplicate express ids
- Category: Bug
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/merged/plan.rs:64-78
- What: `line_of.insert(id, …)` overwrites with the last occurrence, while `type_of.entry(id).or_insert(type_upper)` keeps the first.
- Why it matters: With malformed input `#5=IFCOWNERHISTORY(…); #5=IFCWALL('g…',…);`, the wall's line is classified as `IFCOWNERHISTORY`. Its GlobalId is then never reconciled (duplicate GUIDs), and the rel and container rules read the wrong type.
- Fix: Keep first-wins for both (`entry().or_insert`), or warn on duplicates like `plan_map_conversion_normalization` does (step_map_transform.rs:57).
- Effort: S

### EXPORT-MERGE-19: Extra full-size copies of the merged output
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: merged/single_parents.rs:284-299 (`apply_folds` rebuilds the whole `out`); merged/line_edit.rs:65 (`String::from_utf8_lossy(&out).into_owned()` copies every rewritten line twice, plus a `to_string()` per reference)
- Why it matters: Peak memory doubles on large IFC2X3 merges, plus one extra allocation per line.
- Fix: Patch folds in place using recorded spans (see EXPORT-MERGE-12). Use `String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())` and `itoa` or `write!`.
- Effort: S

### EXPORT-MERGE-20: Two very large functions
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/merged/mod.rs:154-411 (`export_merged_models`, 258 lines, with comment blocks up to about 30 lines inside the emit loop); rust/export/src/step_map_transform.rs:51-175 (a 105-line `attempt` closure, lines over 150 chars)
- Fix: Extract `emit_model(...)` (with the conversion fallback as a named function) and `register_emitted_guid`. Split the map planner into `validate_scaled`, `plan_scaled` and `finish_map_edits`.
- Effort: M

### EXPORT-MERGE-21: Dead parameters and fields, and out-of-date docs
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `unify_spatial`'s `elevation_factor` is always `1.0` (plan.rs:309, empty.rs:175); it is the reason for `#[allow(clippy::too_many_arguments)]` at plan.rs:177
  - `ModelIndex.max_id` (plan.rs:36-37): the doc says it "drives the next model's offset", but only plan_tests reads it
  - `Writer::mapped_representation(_context)` (step_map_transform_writer.rs:49): unused parameter
  - schema_convert.rs:239-242: an orphaned doc paragraph for a splitter that moved to step_slot, sitting on `trim_attributes`
  - schema_unrepresented.rs:29-31: says it "deliberately answers `false` (representable)" but returns `true`
  - rooted_type.rs:26-30, :52-64: stale (see EXPORT-MERGE-3)
  - plan.rs:2-5: the module doc lists ref rewriting, which lives in line_edit
- Fix: Remove the dead parameter, field and allow; correct the docs.
- Effort: S

### EXPORT-MERGE-22: Map normalisation uses String errors, reports refusals through two different channels, and mislabels ids
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/step_map_transform.rs:52-60 vs :171-174; step_map_transform_preflight.rs:353-358
- What: Non-UTF-8 input, duplicate ids and bad record boundaries return a top-level `Err`. Every other refusal becomes `plan.warnings` with `Ok`, so callers must handle both. All errors are `String`. `rigid_frame` always says "product #id" even when given the map id (step_map_rigid.rs:22) or a placement id (:127, :156).
- Fix: Define a `MapNormalizationError` enum, send every refusal through one channel, and pass an entity-kind label into `rigid_frame`.
- Effort: S

### Concept inventory
- Matrix/transform math:
  - map affine and unit division: step_map_transform.rs:100-105
  - placement compose `affine * placement * inverse_scale`: step_map_transform.rs:121, :131
  - `affine * local`: step_map_rigid.rs:126
  - TrueNorth 2D rotate/normalise: step_map_context_metadata.rs:54-60
  - rigid check: step_map_transform_preflight.rs:353
  - Axis/RefDirection parallel check: step_map_transform_preflight.rs:314
  - matrix→IfcAxis2Placement3D writer: step_map_transform_writer.rs:24 (`Writer::frame`)
- Unit conversion:
  - `resolve_length_scale`: merged/units.rs:108 (delegates to core `length_unit_scale`)
  - `primary_scale`: merged/units.rs:120
  - `units_compatible`: merged/units.rs:126
  - `resolve_model_modes`: merged/units.rs:53
  - project/map unit checks: step_map_transform_preflight.rs:31, :49 (SI prefix enumeration :65-66)
  - `try_extract_length_unit_scale` use: step_map_transform.rs:87
- GUID/hashing:
  - GUID minting and validation: `GLOBAL_ID_CHARS` + `deterministic_global_id` merged/guid.rs:13, :24; `is_global_id` :64; `GuidMinter::mint` merged/guid.rs (salted retry); `placeholder_guid` schema_convert.rs:226
  - leading-GlobalId readers: `extract_global_id_fast` guid.rs:94; `extract_leading_guid`/`is_global_id_shaped` rooted_type.rs:66, :87; `read_leading_guid`/`replace_global_id` guid.rs:146, :159; `is_rooted_type` rooted_type.rs:40
- Schema detection: `canon` schema_convert.rs:14; `needs_conversion` :407; `targets_ifc2x3` :402; `detect_schema` schema_detect.rs:13; `file_schema_identifier` file_schema.rs:42; `output_schema` merged/header.rs:13; inline allowlist step_map_transform.rs:69
- STEP tokenising / entity-ref rewriting:
  - ref rewriting: `rewrite_refs` merged/line_edit.rs:31
  - line splitting and slot classification: `arg_span` :99; `split_args` :127; `parse_ref` :163; `classify_refs`; `decide_line` :218; `append_to_list_attr` :264; `arg_refs`
  - attribute readers: `nth_attr`/`entity_name`/`storey_elevation` merged/spatial.rs:55, :101, :113; `count_top_level_attributes` schema_pad.rs:233
  - ref/id parsers: `parse_single_ref`/`parse_ref_list` plan.rs:220, :225; `single_ref`/`ref_list` empty.rs:371, :376; `read_side`/`rel_id` single_parents.rs:139, :150; `entity_type_upper` guid.rs:115
  - shared helpers used: `split_top_level_args` step_slot.rs:104, `refs_in_line(_counted)` step_text.rs:96, :114, `attribute_of` step_text.rs:227, core `step_string_literal_end`, `parse_express_id`
- Tolerances:
  - `UNIT_SCALE_TOLERANCE = 1e-6` merged/units.rs:35
  - storey elevation `max(0.5, |e|·0.01)` merged/spatial.rs:245
  - rigid frame `1e-10` preflight.rs:355-356; parallel axes `1e-12` preflight.rs:328
  - sine noise `f64::EPSILON` step_map_transform.rs:110
  - GUID window of 128 bytes guid.rs:98
- Error types: `UnrepresentedEntityError` (+ `From` for `io::Error`) schema_unrepresented.rs:45-76; `Result<_, String>` throughout step_map_*; `MapConversionNormalizationPlan.warnings` step_map_transform.rs:37; merge reports through `MergedStats.warnings` only (no `Result`).