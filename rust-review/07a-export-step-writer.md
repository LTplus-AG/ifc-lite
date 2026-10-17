I found 29 findings in the STEP writer/rewrite slice. Three are High:

1. **Edits on a valid record silently dropped:** the log writer drops all named, retype and positional edits when a record has whitespace or a comment between `)` and `;`. No warning is raised and nothing is counted.
2. **Too many splitters:** five top-level argument splitters exist, plus two slot-grammar validators that both run on every slot.
3. **No conversion for generated lines:** with schema conversion on, the log writer writes generated, rewritten and georef records without converting them.

Other confirmed crashes: a positional index like `@100000000000` crashes the log writer, and the log writer's id allocator saturates at `u32::MAX` and duplicates ids. I made no edits and ran no cargo. The brief asks for a file, but I followed your instruction to return the findings here.

### EXPORT-STEP-1: Record-frame parsers (`#id=TYPE(args);`) implemented ~11 times; drift silently drops log edits
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: rust/export/src/step_text.rs:173-181 (`apply_attr_mutations_counted`), rust/export/src/step_text.rs:228-234 (`attribute_of`), rust/export/src/step_text.rs:207 (`renumber`), rust/export/src/step_log/lines.rs:19 (`record_parts`), rust/export/src/step_log/attrs.rs:279 (`split_record`), rust/export/src/step_log/attrs.rs:291 (`argument_list_scans`), rust/export/src/step_log/retype.rs:90 (`retype_line`), rust/export/src/step_log/extract.rs:64 (`extract_entity`), rust/export/src/step_log/source.rs:81 (`type_of`), rust/export/src/step_log/refilter.rs:32 and :236, rust/export/src/step_log/readers.rs:188. Core already has rust/core/src/parser/scanner_attributes.rs:52/164 (`of_record`, `argument_list_start`).
- What: Each one finds the `=`, the type and the outer parens its own way.
  - `step_text` uses the first `(` and `rfind(')')` after stripping `;`, so it accepts `) ;`.
  - `lines::record_parts` walks back ASCII whitespace before `;`, so it also accepts `) ;`.
  - `attrs::split_record` and `retype_line` need the literal `text.rfind(");")`.
  - So `#5=IFCWALL('g',$,'W',$,$,$,$,$,$) ;` (valid Part 21) behaves differently by path:
    - `apply_named` returns `(text, [])`, `apply_positional` returns the text unchanged, and `retype_line` returns the text unchanged.
    - `argument_list_scans` returns `true` for the `(Some, None)` case, so `pass.rs:284` raises no "unreadable" warning.
    - Every log edit on that record is dropped and nothing is counted, while `replace_argument` in the same module edits the same line fine.
  - In refilter, every `IFCREL*` line whose `read_slots` fails (for example a comment after `)`) is withheld (`refilter.rs:139`) even when nothing is excluded.
- Why it matters: Silent loss of user edits on valid files. Every new reader re-decides the framing rules.
- Fix: One `StepRecord::parse(&str) -> Option<{id, type_span, args_span, suffix}>` in `step_slot.rs` (or core `scanner_attributes`) that tolerates trivia before `;`. Have all 11 sites use it. The TS twin has the same `lastIndexOf(');')` bound (packages/export/src/step-attribute-mutations.ts:234, retype.ts:181), so fix both and add a parity vector with `) ;`.
- Effort: M

### EXPORT-STEP-2: Five top-level argument splitters and two slot-grammar validators; every slot is validated twice
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: rust/export/src/step_slot.rs:104 (`split_top_level_args`) + :203 (`is_well_formed_step_slot`), rust/export/src/step_log/lines.rs:66-196 (`split_args` → `well_formed_slot`/`Grammar`), rust/export/src/step_log/extract.rs:130 (`parse_list_items`) + :97 (`balanced_params`), rust/export/src/step_log/refilter.rs:67 (`list_items`), rust/core/src/parser/header.rs:19 (`split_top_level`). Outside the slice: rust/export/src/schema_pad.rs:235-255 (count), rust/export/src/merged/spatial.rs:55 (`nth_attr`).
- What: Each splitter has its own quote, comment, paren and trim policy:
  - `step_slot` keeps comments and refuses unbalanced input.
  - `extract` replaces a comment with `' '`, drops empty nested items and never refuses.
  - `refilter` trims items and never refuses.
  - The core header splitter drops comments and also counts `[`/`]`.
  - `lines::split_args` runs `split_top_level_args`, which already ran `is_well_formed_step_slot` on every part. It then runs a second recursive grammar on every part. The only differences are documented: empty nested elements, and depth 64. So every slot is scanned and validated twice.
- Why it matters: One grammar fix (like #7589) needs 5-7 synchronized edits. The double validation runs on every `IFCREL*` line of every log export (see EXPORT-STEP-15).
- Fix: Keep one splitter in `step_slot.rs`, parameterised by a `SlotGrammar { nested_empty: bool, max_depth: Option<usize>, comments: Keep|Drop }`. Have `extract`/`refilter` use a non-refusing mode of the same walker. Delete `lines::Grammar`.
- Effort: M

### EXPORT-STEP-3: Log writer skips schema conversion and IFC2X3 slot-fill for generated, rewritten and georef records
- Category: Bug
- Severity: High
- Confidence: CONFIRMED
- Where: rust/export/src/step_log/write.rs:270-275, rust/export/src/step_log/generate.rs:134-141, rust/export/tests/fixtures/step_log_parity_vectors.json (all 45 cases `schema: None`)
- What: `write_line` (which converts) is used for source and created lines only. `pass.generated`, `rewritten_lines` and `georef_lines` go out raw: `out.write_all(line.as_bytes())`. The qset `Formula` slot is decided from `pass.schema`, the source family, not the target. The TS twin converts generated quantity lines (`packages/export/src/step-property-sets.ts:95-101`, #7378).
  - Failure: an IFC4 source, a log adding a quantity, and `opts.schema = Some("IFC2X3")` writes `IFCQUANTITYLENGTH('L',$,$,1.,$)` (5 attrs) into an IFC2X3 file.
  - A repointed IFC4 type object such as `IFCDOORTYPE` is written unrenamed (no `IFCDOORSTYLE`).
  - A `$` OwnerHistory on generated psets is not counted in `owner_history_unfilled`.
- Why it matters: Invalid files reported as clean; a parity drift no vector covers.
- Fix: Route every appended line through `write_line` (or one `Emitter` struct, see EXPORT-STEP-22). Add parity cases with `schema` set.
- Effort: S

### EXPORT-STEP-4: Two STEP REAL formatters with different bytes and non-finite policy
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/step_log/jsval.rs:109 (`format_step_real`), :126 (`to_step_real`); rust/export/src/step_map_transform_writer.rs:87 (`real`). Non-STEP formatters for reference: usd/fmt.rs:98, model_props.rs:20, landxml_terrain.rs:280, collada_fmt.rs:20.
- What:
  - `format_step_real(1e-7)` gives `"1.E-7"`; `real(1e-7)` gives `"0.0000001"`, because Rust `Display` never uses an exponent. `real(1e300)` is a 302-char token, and its `split_once(['e','E'])` branch is dead.
  - `-0.0`: `"0."` vs `"-0."`.
  - Non-finite: `"0."` vs `Err`.
  - Both emit a mantissa `.`, so both are valid Part 21; only the bytes and policy drift.
- Why it matters: The same value written by two exporters gives different files and different NaN handling.
- Fix: One `fn step_real(f64) -> Option<String>` (shortest round-trip digits, `1.E-7` form) in a `step_number.rs`. `to_step_real`'s `0.` fallback stays a TS-parity wrapper at the call site.
- Effort: S

### EXPORT-STEP-5: Integer and number serialisers emit non-STEP tokens (`NaN`, `Infinity`, `1e+21`); REAL non-finite policy inconsistent
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/step_log/nominal.rs:126, rust/export/src/step_log/values.rs:50, :61, :113, rust/export/src/step_log/attrs.rs:250
- What:
  - `pvt::INTEGER => format!("IFCINTEGER({})", js_number_to_string(js_round(js_to_number(value))))`. A CREATE_PROPERTY with `valueType:2, newValue:"abc"` writes `IFCINTEGER(NaN)`.
  - Integral values ≥1e21 go through `js_number_to_string` and come out as `1e+21` (no `.`, lowercase, `+`). That is not a valid STEP INTEGER or REAL.
  - REAL non-finite becomes `$` in nominal.rs:118-124 and attrs.rs:244, but `0.` (a made-up zero) in values.rs:49/:122 and georef.rs:102-108.
- Why it matters: Strict readers reject the file, and a NaN measure is silently written as 0.
- Fix: Integer path: `n.is_finite() && n.abs() < 2^53` → integer digits, else `$` (or an `Unwritable` refusal). One non-finite policy enum shared by all serialisers. Add the cases to the shared TS vectors (TS has the same `String(n)`).
- Effort: S

### EXPORT-STEP-6: Seven comment/trivia skippers and three whitespace definitions; core's lexer is unused
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/step_slot.rs:216 (closure) + :337 (`comment_end`), rust/export/src/step_log/lines.rs:100-117, rust/export/src/step_log/extract.rs:81, :108-112, :182, rust/export/src/step_log/refilter.rs:40, :76, rust/export/src/step_log/readers.rs:16/23. Core: rust/core/src/parser/lexical.rs:42/78/105 (`skip_step_comment`, `skip_step_trivia`, `is_step_space`).
- What: The whitespace rules differ:
  - `step_slot`, `lines`, `extract` and `refilter` use `char::is_whitespace`/`str::trim`, which are Unicode and treat NBSP U+00A0 as trivia.
  - `readers::ws` and `record_parts` use `is_ascii_whitespace`, which excludes VT 0x0B.
  - Core `is_step_space` includes VT and documents that the mismatch was a real bug (#3733).
  - Unterminated-comment handling also differs: some return `None`, some run to the end.
- Why it matters: `#5=IFCRELAGGREGATES(...)\x0B;` parses in core but fails `record_parts`, so the relationship is withheld (refilter.rs:139).
- Fix: Use the core `lexical` helpers everywhere, plus a char-index adapter if one is still needed after EXPORT-STEP-2.
- Effort: S

### EXPORT-STEP-7: Numeric-literal grammar duplicated despite core's documented single home (#5266)
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/step_log/extract.rs:11 (`is_complete_numeric`, "isCompleteStepNumericLiteral") + :54 (`parse_float`); rust/export/src/step_log/attrs.rs:179 (`is_plain_number`); rust/export/src/step_log/values.rs:186 (`token_is_real_literal`). Core: rust/core/src/parser/numeric_literal.rs:33/72 ("The one STEP numeric-literal grammar every Rust raw-byte reader shares").
- What: `extract` re-implements the core grammar exactly. `parse_float` makes two `replacen` allocations per number, and its comment is stale: Rust's `f64::from_str` does accept `1.` and `1.E-5`. The other two are ports of TS regexes with deliberately different grammars (`is_plain_number` rejects `1.` and `+1`).
- Why it matters: Four grammars to keep in sync, and one of them breaks a documented single-home rule.
- Fix: `extract` should use `step_numeric_literal_len(b) == Some(b.len())` plus `parse_step_numeric`. Keep the two regex ports, but name and place them in `step_number.rs`.
- Effort: S

### EXPORT-STEP-8: Positional index from the log can force a huge allocation or index-out-of-bounds panic
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/step_log/replay.rs:212-216, rust/export/src/step_log/record.rs:27-31, reached via rust/export/src/step_log/collect.rs:61-65
- What: `"@N"` is parsed with `js_to_number`, then `index as usize` (saturating). `put()` then does `attributes.resize(index + 1, …)`.
  - Failure input: `{"type":"UPDATE_POSITIONAL_ATTRIBUTE","entityId":<an IfcRelDefinesByProperties id>,"attributeName":"@100000000000","newValue":"$"}`. `rel_index` → `effective_record` → `put` asks for ~1e11 slots, which is a capacity-overflow panic or OOM abort.
  - On wasm32 the index saturates to `u32::MAX`, so `index+1` wraps to 0 (overflow-checks off), then `attributes[index]` panics.
  - JS accepts a sparse index here.
- Why it matters: A crash or abort (panic=abort) on host-supplied JSON.
- Fix: Refuse an index ≥ the declared arity (or ≥ `u16::MAX`) in `replay` as `Unsupported`. Never `resize` past `names.len()`.
- Effort: S

### EXPORT-STEP-9: Log writer's id allocator saturates at `u32::MAX`, unlike the plain writer
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/step_log/pass.rs:78, :85-89; compare rust/export/src/step_cow.rs:85-89, :174 and rust/export/src/step.rs:193, :294-322
- What: `next_id: src.max_id.max(next_allocated).saturating_add(1)` and `allocate()` uses `saturating_add(1)`. `step_cow` documents exactly this as wrong ("Saturating was worse than the overflow it replaced") and uses `checked_add` plus a refusal.
- Why it matters: A file holding `#4294967295=…` plus any pset edit gets generated records with id 4294967295, repeated. That is duplicate ids and silent corruption.
- Fix: One `IdAllocator { next: Option<u32> }` in `step_api.rs` (or a new `step_ids.rs`) used by `step_cow`, `step.rs` synthesis and `Pass`. `allocate() -> Result<u32, Unwritable>`.
- Effort: S

### EXPORT-STEP-10: Plain writer silently drops property mutations it cannot place
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/step.rs:283-285, :296-310, :318-322
- What: Three cases drop a mutation with no `StepStats` field to count it:
  - a target not in `included` (`continue`);
  - `next_id == None` (an early return with no synthesis);
  - a group that does not fit the remaining id space (`_ => continue`).
- Meanwhile `copies_refused` and `attribute_edits_refused` exist so that edits that are not in the output are reported.
- Why it matters: The caller reads a clean export missing user edits, which is the failure mode the stats doc says it exists to prevent.
- Fix: Add `property_mutations_refused` to `StepStats` and count all three paths. Build `StepStats` once (see EXPORT-STEP-22).
- Effort: S

### EXPORT-STEP-11: Record index built twice; duplicate express ids silently collapse
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/step.rs:111-124, rust/export/src/step_log/source.rs:47-64
- What: The same `EntityScanner` loop (`max_id`, `HashMap<u32,(usize,usize)>`, `insert(..).is_none()`) appears in both. On a duplicate id, `insert` overwrites the span but `order` keeps the first position. So the second record's text is written at the first one's place and the first record vanishes, with no counter. In `Source`, `by_type` records the first record's type while `line_of` holds the second's span, so they can disagree. `step_map_transform.rs:58` explicitly refuses duplicates.
- Why it matters: Silent data loss on malformed input, and two places to fix it.
- Fix: One `RecordIndex::build(content)` (spans plus `max_id` plus optional tracked types plus `duplicates: Vec<u32>`) in a `step_index.rs`. Report duplicates in both stats.
- Effort: M

### EXPORT-STEP-12: Four schema-family classifiers and three FILE_SCHEMA-token rules have drifted
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/schema_convert.rs:14 (`canon`), :402 (`targets_ifc2x3`); rust/export/src/step_log/attrs.rs:20 (`schema_family`); rust/export/src/step_log/write.rs:159 (inline); rust/export/src/file_schema.rs:21. Header-token decisions: rust/export/src/step.rs:204-211, rust/export/src/step_log/write.rs:223-227, rust/export/src/merged/header.rs:25-29.
- What:
  - `canon("IFCX")` gives IFC5, but `schema_family` (no IFCX arm) falls back to a loose 2000-byte `contains` scan and returns IFC4. `canon` does not trim; `schema_family` does.
  - `file_schema_identifier` matches `"IFC4X3"` exactly, so `"ifc4x3"` is not written as ADD2.
  - `step.rs` and `write.rs` keep the source token unless converting. `merged/header.rs` writes the family identifier whenever `opts.schema.is_some()`. So the same target with a same-family source gives different FILE_SCHEMA bytes.
- Why it matters: Behaviour differs between exporters for the same input.
- Fix: A `SchemaFamily` enum with one `from_label` and one `header_token(source_token, target, converting)` in `schema_detect.rs`. `write.rs:222-227` and `step.rs:204-211` are verbatim copies; extract them.
- Effort: M

### EXPORT-STEP-13: Log stream loop does work proportional to records × created entities, plus allocations per record
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/step_log/entities.rs:12-18, rust/export/src/step_log/pass.rs:100-122, :136-138, rust/export/src/step_log/write.rs:246-255
- What:
  - `Overlay::is_created` and `created` are linear scans of `new_entities`.
  - `pass.has()`/`type_of()` call them, and the stream loop calls `pass.type_of(id)` for every source record. That is a `from_utf8_lossy` plus a `to_ascii_uppercase` allocation, and `raw.into_owned()` adds another allocation per record.
  - `is_omitted` runs per reference inside every `IFCREL*` line.
- Why it matters: A 4.4M-record file with 10k created entities means about 4e10 comparisons. Every record pays at least two allocations even for an edit that touches one pset.
- Fix: Keep a `HashMap<u32, usize>` index next to `new_entities` (to preserve order). Compute `upper` once from the scanner's type. Use `Cow` through `detach`.
- Effort: S

### EXPORT-STEP-14: Plain full export builds an every-id HashSet and copies every record
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/step.rs:129-131, :215-225, :51
- What:
  - With `included: None`, `order.iter().copied().collect::<HashSet<u32>>()` is built only to answer `contains`, which is always true. That is tens of MB on large models, on top of the ~84 B/record the docs already budget.
  - The loop then does two hash lookups (`included` plus `line_of`) per record.
  - `None => raw.into_owned()` allocates and copies every unedited record even though `from_utf8_lossy` returned `Borrowed`.
  - `String::from_utf8(buf)` re-validates the whole output.
- Why it matters: Memory and time on the main export path.
- Fix: `enum Included { All, Some(HashSet) }`. Store spans in `order: Vec<(u32, usize, usize)>`. Keep `edited` as `Cow<str>`.
- Effort: S

### EXPORT-STEP-15: Argument splitting allocates a `Vec<char>` per record and per slot, and runs on every `IFCREL*` line
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/export/src/step_slot.rs:114-115, :204-205, rust/export/src/step_log/lines.rs:78-79, rust/export/src/step_log/refilter.rs:261-262, :138
- What: Allocations per record:
  - `split_top_level_args`: `Vec<char>`, the ASCII projection, and a `String` per slot.
  - `is_well_formed_step_slot`: another `Vec<char>` plus projection per slot.
  - `lines::well_formed_slot`: a third pair per slot.

  A 9-slot record costs about 40 allocations. `filter_source_line` calls `relationship → read_slots` on every `IFCREL*` line of every log export, before checking `any_excluded`. The code comment's justification (avoid `bytes[i] as char` mojibake) is already met by slicing `&str` at ASCII delimiters, as core `header::split_top_level` does.
- Why it matters: The main cost on the log writer's streaming path.
- Fix: A byte walker that slices `&str` at ASCII boundaries, with one validation pass (folds into EXPORT-STEP-2).
- Effort: M

### EXPORT-STEP-16: A refusal counter is derived by substring-matching warning text; warning text is duplicated and has drifted
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED (counter) / LIKELY (wording drift)
- Where: rust/export/src/step_log/write.rs:285; producers rust/export/src/step_log/pass.rs:266-269 and rust/export/src/step_log/created.rs:43-47; withheld text at rust/export/src/step_log/write.rs:242 vs rust/export/src/step_log/refilter.rs:123-133
- What:
  - `warnings.iter().filter(|w| w.contains("is not a number and the slot is REAL-typed")).count()` drives `attribute_edits_refused`. Rewording either producer silently zeroes the stat.
  - The pre-pass turns `Filtered::Withhold(w)` into `None` and drops `w` (write.rs:205). The stream loop then always rebuilds the "Relationship #… Anything else that relationship associated…" text. So a withheld edited `IFCSTYLEDITEM` (a `STYLE_RESCUE_TYPES` record, where refilter says "Entity #…") is reported with the relationship wording.
- Why it matters: A fragile stat and wrong diagnostics.
- Fix: Count refusals in a field on `Pass`. Store the `Withhold(String)` in `mutated_lines` instead of `None`. Make warning texts `const`s or a `Warning` enum.
- Effort: S

### EXPORT-STEP-17: The same token predicates (`#N` ref, `.ENUM.`) are written six times
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/step_log/values.rs:136 and :161 (ref), :139-143 and :162-165 (enum); rust/export/src/step_log/attrs.rs:167, :174; rust/export/src/step_log/readers.rs:229; rust/export/src/step_log/refilter.rs:60; rust/export/src/step_log/retype.rs:32
- What: The same checks are copy-pasted. Small variants exist: canonical-spelling and `id>0` only in `authored_entity_refs`, and trivia stripping only in `bare_ref`.
- Why it matters: Five places to update together.
- Fix: `token::{is_ref, is_enum, enum_inner}` in `step_log/lines.rs` (or `step_slot.rs`).
- Effort: S

### EXPORT-STEP-18: Four `#ref` scanners with different string and overflow policies
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/step_text.rs:114 (`refs_in_line_counted`), :254 (`substitute_ref_in_attr`); rust/export/src/step_log/readers.rs:31 (`hash_ids`); rust/export/src/merged/line_edit.rs:31 (`rewrite_refs`)
- What: `hash_ids` does not skip string literals (`'lot #41'` yields 41) and silently drops refs above `u32::MAX` without counting. The others skip literals and count refusals. This is documented as a TS-regex port.
- Why it matters: Different answers for the same text.
- Fix: One `RefScanner { skip_literals: bool }` iterator in `step_text.rs`. `hash_ids` uses the `skip_literals = false` mode.
- Effort: S

### EXPORT-STEP-19: Literal un-doubling plus decoding is re-implemented outside core
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/step_log/extract.rs:212-214; private home rust/core/src/parser/header.rs:65 (`decode_literal`). Also rust/export/src/merged/spatial.rs:109 and rust/processing/src/processor/quick_metadata.rs:95.
- What: `value[1..len-1].replace("''","'")` followed by `decode_ifc_string`. The ordering is load-bearing (the core doc explains why), but it is restated at each site.
- Why it matters: An ordering fix would need several edits.
- Fix: Make `decode_step_literal(inner)` `pub` in `core::step_encoding` and use it at all sites.
- Effort: S

### EXPORT-STEP-20: Unit-symbol table duplicated from core with drift; SI prefix list and foot factors repeated
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/step_log/units.rs:20 vs rust/core/src/project_units/symbols.rs:111; rust/export/src/step_log/units.rs:14 vs rust/export/src/step_log/georef.rs:60 (inline copy of `SI_PREFIXES`); rust/export/src/step_log/georef.rs:73 (`1200.0/3937.0`) vs rust/core/src/unit_labels.rs:76 (`0.3048006096`) vs rust/export/src/landxml_terrain.rs:53
- What:
  - The export `conversion_unit_symbol` strips all `'` (`replace`) and uses Unicode `to_uppercase`. Core only trims outer quotes and uses ASCII. So `"O'CLOCK"` gives `"OCLOCK"` in export and `"O'CLOCK"` in core.
  - The US survey foot constant in core is truncated.
- Why it matters: Two unit tables that already disagree.
- Fix: Re-export the core symbol function (the TS parity target is the same table). Keep one `SI_PREFIXES` and `US_SURVEY_FOOT_M = 1200.0/3937.0` in core `unit_labels`.
- Effort: S

### EXPORT-STEP-21: Two header writers; magic `'2;1'` and the footer literal repeated
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/step_header.rs:75-152 vs rust/export/src/merged/header.rs:24-40; `"2;1"` at rust/export/src/step_header.rs:104, rust/export/src/source_header.rs:83, :93, merged/header.rs:32; `ENDSEC;\nEND-ISO-10303-21;\n` at rust/export/src/step.rs:297, :357, rust/export/src/step_log/write.rs:280, rust/export/src/merged/mod.rs:170, :409
- What: The merged header writes an empty `name`/`time_stamp` and `'ifc-lite-export'`, with its own formatting instead of `quote_list`/`write_header`.
- Why it matters: Header changes have to be made in two places.
- Fix: `step_header::{write_header_fields(HeaderFields), write_footer}` with `const DEFAULT_IMPLEMENTATION_LEVEL`. The merged writer builds a `HeaderFields`.
- Effort: S

### EXPORT-STEP-22: Convert-or-write and the `StepStats` literal are copy-pasted
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/step.rs:226-239 and :258-271; rust/export/src/step_log/write.rs:125-142; `StepStats` literal at rust/export/src/step.rs:298-309 and :359-370 (lines 368-369 are mis-indented); rust/export/src/step.rs:93-102 (`write_synthesized`)
- What: Three emit paths each own a `(slot_fill, checks, converting, from, to)` tuple. That is why `write_line` needs `#[allow(clippy::too_many_arguments)]`.
- Why it matters: Five write sites must stay in sync (EXPORT-STEP-3 is a missed one).
- Fix: An `Emitter<'w, W> { out, converting, from, to, slot_fill, checks, written }` with `write_source(id, &str)`, `write_synth(String)` and `stats()`, shared by `step.rs` and `step_log/write.rs`.
- Effort: M

### EXPORT-STEP-23: Long functions and stale `#[allow]`s
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/step.rs:105-371 (`emit`, 266 lines), rust/export/src/step_log/write.rs:144-301 (157), rust/export/src/step_slot.rs:203-315 (112), rust/export/src/step_log/generate.rs:186-266 (80); rust/export/src/step.rs:67-69 (`#[allow(clippy::type_complexity)]` on `export_step_to_writer`, whose signature is simple; the cited grouped Vec lives in `emit`); rust/export/src/step_log/write.rs:124
- What: `step.rs` is at 379/400 of the module-size ratchet, so the next change has to split something anyway.
- Why it matters: Hard to review, and the allows hide nothing real.
- Fix: Split `emit` into `index → closure → header → stream → copies → synth` with the `Emitter` from EXPORT-STEP-22. Drop the stale allow.
- Effort: M

### EXPORT-STEP-24: Schema, value types and attribute columns are passed as strings and bare numbers
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/step_log/pass.rs:21 (`schema: &'static str`), rust/export/src/step_log/attrs.rs:56-61, :76-81, :97-102 (column match repeated three times), :306-309, rust/export/src/step_log/refilter.rs:265, :269 (`matches!(schema, "IFC2X3"|"IFC4"|"IFC4X3")` with a `""` sentinel), rust/export/src/step_log/base.rs:26-48 (`pvt`/`qty` as `u8` const modules), rust/export/src/step_log/wire.rs:137, :139 (`Option<f64>` type codes, cast `as u8` at replay.rs:164, :190, overlay.rs:248)
- What: A `value_type: 300.0` cast `as u8` wraps silently to 44.
- Why it matters: Silent mis-typing and repeated lookup logic.
- Fix: `SchemaFamily` enum (shared with EXPORT-STEP-12), `enum PropertyValueType`/`QuantityType` with `TryFrom<f64>`, and one `fn names_column(family, registry: bool)`.
- Effort: M

### EXPORT-STEP-25: Inconsistent error and stats types across the writer
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/step.rs:29 (`io::Result`, schema errors via `From`), rust/export/src/step_log/write.rs:80 (`io::ErrorKind::InvalidInput` plus `String`), rust/export/src/step_log/values.rs:23 (`Unwritable(String)`), rust/export/src/step_log/replay.rs:105 (`Unsupported(String)`), rust/export/src/step_json.rs:64 and rust/export/src/step_map_transform_writer.rs:87 (`Result<_, String>`); stats at rust/export/src/step_api.rs:109 (`StepStats`: no `Debug`/`#[non_exhaustive]`), rust/export/src/step_log/write.rs:32, :54
- What: Callers cannot match on refusal kinds, and `From<&LogExportStats> for StepStats` zeroes fields. The log path also takes a `StepOptions` and rejects four of its fields at runtime (write.rs:145-152).
- Why it matters: Error handling and stats cannot be used uniformly by callers.
- Fix: One `thiserror` `StepExportError { Unsupported, Unwritable, Unrepresented, Io }`. Use a `LogStepOptions` type without the plain-writer vectors.
- Effort: M

### EXPORT-STEP-26: Caller-supplied STEP fragments are written unvalidated (record injection)
- Category: Bug
- Severity: Low
- Confidence: CONFIRMED (injection) / SUSPECT (id collision)
- Where: rust/export/src/step_log/created.rs:68, :101 (`LogNewEntity.entity_type`; `is_entity_name` only guards retypes, replay.rs:223), rust/export/src/step_text.rs:183 (`AttrMutation.value`), rust/export/src/step.rs:325-329 (`PropMutation.value`)
- What:
  - `entity_type: "IfcWall($);\n#1=IFCFOO("` emits arbitrary records, including a duplicate `#1`.
  - A value containing `,` shifts arity.
  - A created `express_id` equal to an existing source id is not refused. The stream loop (write.rs:234) has no `is_overlay_created` check, so both lines are written (SUSPECT; I did not confirm what the TS twin does).
- Why it matters: Malformed output from a buggy or hostile bridge payload.
- Fix: Validate with `is_entity_name` and `is_well_formed_step_slot` (both already exist). Refuse created ids ≤ `src.max_id` that exist in the source.
- Effort: S

### EXPORT-STEP-27: Repeated parsing of the header and of unit/relationship records
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/step_log/write.rs:154-155, :222 plus rust/export/src/step_log/attrs.rs:35-40 (header read three times: `declared_schemas`, `detect_schema`, `parse_source_header`); rust/export/src/step_log/units.rs:130-137 (re-extracts `IFCPROJECT` and `IFCUNITASSIGNMENT` for every generated property with a unit, via generate.rs:89); rust/export/src/step_log/base.rs:97-98 (fully extracts every `IFCRELDEFINESBYPROPERTIES` even when the log touches one entity); rust/export/src/step_log/values.rs:151-166 (linear `SELECT_SLOTS` scan plus a `Vec` per call)
- What: The same inputs are parsed again on each call instead of once per export.
- Why it matters: Wasted work on large models, though small next to EXPORT-STEP-13 to EXPORT-STEP-15.
- Fix: Parse the header once into `SourceHeader` and derive the family from it. Cache the project length units on `Pass`. Pre-filter rels with `hash_ids ∩ wanted` before `extract_entity`.
- Effort: S

### EXPORT-STEP-28: Keyword case normalisation repeated 37 times, mixing Unicode and ASCII
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/step_log/pass.rs:108, :119, :151, :160, :261; created.rs:68-69; record.rs:36, :43; retype.rs:27, :96; values.rs:67; refilter.rs:239 (Unicode `to_uppercase`) vs source.rs:86, extract.rs:73 (ASCII). Core has rust/core/src/parser/keyword.rs:40-70.
- What: Retype targets are stored un-normalised and re-uppercased inside loops (`Pass::of_type`). Unicode upper can change length (`ß` becomes `SS`).
- Why it matters: Repeated allocations and two subtly different normalisations.
- Fix: Normalise once in `replay` (`set_retype`, `restore`) to ASCII upper. Use `keyword_eq` for comparisons.
- Effort: S

### EXPORT-STEP-29: Copy-paste test fixtures and helpers
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `spec_unescape` cloned at rust/export/src/step_text_tests.rs:68-95 and rust/export/src/merged/tests.rs:145-170 (jscpd).
  - 20 inline full-file fixtures in rust/export/src/step_tests.rs (e.g. :127-139, :254-262).
  - The header line `FILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');` appears 17 times in merged/tests.rs and 5 times in step_text_tests.rs.
  - Ad-hoc builders: tests/source_header_comments.rs:28 (`header`), tests/merged_single_inverses.rs:17, tests/issue_5365_enum_reconciliation.rs:11, src/merged/empty_tests.rs:45, src/merged/empty_claims_tests.rs:11, src/step_map_transform_tests.rs:8 (`model`).
- What: rust/export/src/test_support.rs covers fixture skipping only.
- Why it matters: Every fixture format change has to be repeated across files.
- Fix: Add `test_support::{step_file(schema, &[&str]) -> String, spec_unescape}`. Add a `tests/common/mod.rs` re-exporting the same builder for integration tests, since they cannot see `pub(crate)`.
- Effort: S

### Generated `step_log_tables.rs` (5,864 lines)
The generation approach is sound. `scripts/generate-step-log-tables.mjs` (349 lines) runs the TS exporter's own functions (`attrIndex`, the slot classifiers, `declaredNominalValueType`) under tsx. It has `--check`, which runs in CI at `.github/workflows/test.yml:1937` and as `pnpm check:step-log-tables`. `step_log/tables_tests.rs` asserts the sort order of the six binary-searched tables. Two caveats:
- The `--check` needs the workspace packages built first.
- This is a second attribute-name source of truth beside core's registry, and `step_log` uses both: tables in attrs.rs vs `ifc_lite_core::attribute_names_for_schema` at generate.rs:134 and `IfcType::attribute_names` at base.rs:244. That is fine for TS parity, but a registry change can make them disagree inside one export.

## Concept inventory
- **Number formatting:** `js_number_to_string` rust/export/src/step_log/jsval.rs:69; `format_step_real` :109; `to_step_real` :126; `real` rust/export/src/step_map_transform_writer.rs:87; `js_round` rust/export/src/step_log/nominal.rs:99; `real_or_zero`/`real_or_unset` rust/export/src/step_log/georef.rs:102/:107.
- **Number parsing:** `json_number` jsval.rs:136; `js_to_number` :150; `string_to_number` :169; `is_complete_numeric`/`parse_float` step_log/extract.rs:11/:54; `is_plain_number` step_log/attrs.rs:179; `token_is_real_literal` step_log/values.rs:186; core `step_numeric_literal_len` rust/core/src/parser/numeric_literal.rs:33.
- **String escaping and decoding:** `escape` rust/export/src/step_text.rs:71 (re-exported as `escape_step_string`, lib.rs:77); `string_slot`/`enum_token` step_log/attrs.rs:138/:149; inline un-double+decode step_log/extract.rs:213; `quoted_third` (raw) step_log/readers.rs:58; core `decode_ifc_string` rust/core/src/step_encoding.rs:86; `step_string_literal_end` :63; `decode_literal`/`decode_opt_string` rust/core/src/parser/header.rs:65/:79.
- **STEP tokenizing and attribute splitting:** `split_top_level_args` step_slot.rs:104; `is_well_formed_step_slot` :203; `ascii_projection` :331; `comment_end` :337; `record_parts`/`read_slots`/`split_args`/`replace_argument`/`well_formed_slot` step_log/lines.rs:19/:55/:66/:8/:74; `extract_entity`/`skip_trivia`/`balanced_params`/`parse_list_items`/`find_comment_end`/`typed_value` step_log/extract.rs:64/:81/:97/:130/:182/:227; `starts_with_record_id`/`strip_trivia`/`list_items`/`framed`/`record_type` step_log/refilter.rs:32/:40/:67/:108/:236; `split_record`/`argument_list_scans` step_log/attrs.rs:279/:291; `retype_line` step_log/retype.rs:89; `apply_attr_mutations_counted`/`attribute_of`/`renumber`/`substitute_ref_in_attr` step_text.rs:168/:227/:207/:254; `Source::type_of` step_log/source.rs:81; `ws`/`ws_back` step_log/readers.rs:16/:23; core `split_top_level` parser/header.rs:19; core `skip_step_comment`/`skip_step_trivia`/`is_step_space` parser/lexical.rs:42/:78/:105.
- **Entity ids:** `refs_in_line(_counted)` step_text.rs:96/:114; `hash_ids`/`authored_entity_refs`/`owner_history_ref`/`related_property_set`/`related_entities`/`property_ids_in_set` step_log/readers.rs:31/:229/:188/:163/:126/:95; `authored_refs`/`record_refs` step_log/refs.rs:11/:27; `refs` step_log/base.rs:337; `bare_ref` step_log/refilter.rs:60; max-id/index scan step.rs:111 and step_log/source.rs:47; `resolve` (checked id budget) step_cow.rs:90; `Pass::allocate` (saturating) step_log/pass.rs:85; `is_entity_name` step_log/entities.rs:86.
- **Unit conversion:** `conversion_unit_symbol` step_log/units.rs:20 (duplicates core project_units/symbols.rs:111); `SI_PREFIXES` units.rs:14 (and an inline copy at georef.rs:60); `normalize_map_unit_name` units.rs:96; `find_length_unit_reference` units.rs:122; `map_unit` (0.3048, 1200/3937) step_log/georef.rs:52.
- **Hashing and GUID:** `global_id` → `crate::deterministic_global_id` step_log/generate.rs:44; `placeholder_guid` rust/export/src/schema_convert.rs:226 (used by step.rs:340/:350).
- **Schema family:** `canon`/`targets_ifc2x3`/`needs_conversion` schema_convert.rs:14/:402/:407; `schema_family` step_log/attrs.rs:20; `detect_schema` schema_detect.rs:13; `file_schema_identifier` file_schema.rs:21.
- **Error and stats types:** `StepStats` step_api.rs:109; `LogExportStats`/`StepCounters` step_log/write.rs:32/:54; `invalid()` → `io::Error` write.rs:80; `Unwritable` step_log/values.rs:23; `Unsupported` step_log/replay.rs:105; `Result<String,String>` step_json.rs:64 and step_map_transform_writer.rs:87.