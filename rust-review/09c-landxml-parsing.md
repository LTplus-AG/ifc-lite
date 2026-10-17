I found 29 issues in the LandXML XML-parsing layers. Four are High: one silently corrupts coordinates, one makes streaming and pull parsing disagree on the same bytes, one is a memory blow-up from tiny input, and the fourth is the duplication that caused most of the drift. I did not run cargo; every finding comes from reading the code and the vendored quick-xml 0.42.0 source (CONFIRMED means confirmed by reading, not by execution). `rust/AGENTS.md` has no LandXML-specific decisions. All paths are relative to `rust/landxml/src/` unless they start with `rust/`.

### EDGE-1: Four hand-rolled XML front-ends (pull loop, consume_event, start/end/text prologue), the root cause of most drift
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - Pull loops: parser.rs:43-76, plan/parser.rs:61-92, pipe_parser.rs:33-61, alignment/parser.rs:75-105.
  - `consume_event`: parser.rs:81-94, plan/parser.rs:185-199, pipe_parser.rs:110-124, alignment/parser.rs:195-208.
  - `start()` prologue (depth cap, split_name, attributes, work/char-ref budget, namespace inheritance, root/version validation, `target`): parser.rs:95-149, plan/parser/driver.rs:23-90, pipe_parser.rs:130-184, alignment/parser/driver.rs:60-96 plus `validate_root` 372-399.
  - `end()` prologue: parser.rs:347-358, plan/parser/driver.rs:255-266, pipe_parser/driver.rs:13-24, alignment/parser/driver.rs:194-205.
  - `is_path`: parser.rs:378-385, pipe_parser.rs:369-376, plan/parser/actions.rs:370-377, alignment/parser/driver.rs:320-327.
  - Frame structs: parser/state.rs:167-179, plan/parser/state.rs:13-18, pipe_parser/state.rs:56-61, alignment/parser.rs:106-111.
  - Capture enums: capture.rs:5-47, plan/parser/state.rs:20-58, alignment/parser.rs:112-138, pipe_parser/state.rs:178-185.
- What: the TIN, plan, pipe and alignment parsers each own a copy of the same front-end. Drift already observed:
  - (a) Per-event work charge. TIN and alignment charge `+1` per event in the pull loop (parser.rs:62, alignment/parser.rs:91). Plan and pipe charge it inside `consume_event`. The stream (stream.rs:370-382) calls only `consume_event`, so TIN and alignment `max_work` means something different in stream and pull.
  - (b) The version-mismatch diagnostic goes through the bounded `record_capability_diagnostic` in TIN (parser.rs:141-146) but is a raw `push` in the other three.
  - (c) The version is read with `required` (parser.rs:147), `.expect` (pipe_parser.rs:179-181, alignment/parser/driver.rs:88-90) or `.unwrap_or_default()` (plan/parser/driver.rs:83).
  - (d) Messages differ: "multiple root elements" vs "multiple roots"; plan has its own unsupported-version text.
  - (e) Empty-document errors differ: pipe says "unclosed XML element" (pipe_parser.rs:57-59), plan says "LandXML document is empty", alignment says "document must contain exactly one root element".
  - (f) `validate_root` re-lists the `supports_tin_ingestion` variants (alignment/parser/driver.rs:381-397 vs model.rs:88-98).
  - (g) Alignment adds char-refs to work (alignment/parser/driver.rs:67); plan adds an extra pntRef budget (plan/parser/driver.rs:30-38).
  - All four manual "mismatched closing element" checks duplicate quick-xml's default `check_end_names: true`.
- Why it matters: every XML-level fix has to be made four or five times. EDGE-2 exists in all four parsers for exactly this reason.
- Fix: create one `xml::driver` home:
  - `XmlCursor { frames: Vec<CoreFrame{local,target,ns:Rc<Namespaces>}>, root: RootInfo, budgets: Budgets }`.
  - A `trait FamilyHandler { start(&mut self, &XmlCursor, &Element); end; text(&str, literal: bool) }`.
  - A `drive(input, limits, cancel, &mut [&mut dyn FamilyHandler])` used by the pull entry points and by `LandXmlTinStreamSession`.
  - Root validation, units, `GeneralRef`, DOCTYPE and budgets then live once.
- Effort: L

### EDGE-2: Entity and character references in element text are silently dropped (quick-xml 0.42 `Event::GeneralRef` is never handled)
- Category: Bug
- Severity: High
- Confidence: CONFIRMED
- Where:
  - The `_ => Ok(())` arms at parser.rs:92, plan/parser.rs:197, pipe_parser.rs:122, alignment/parser.rs:206.
  - Dead text unescape / char-ref accounting at parser/text.rs:15,19, plan/parser/driver.rs:315-329, pipe_parser/driver.rs:93,101, alignment/parser/driver.rs:261,265.
- What: quick-xml 0.42 stops text at `&` (`memchr2(b'<', b'&')`) and emits `Event::GeneralRef` (vendored quick-xml-0.42.0, src/reader/mod.rs:317). No parser matches it.
  - `<P id="1">1&#46;5 2 3</P>` is captured as "1" + "5 2 3" = "15 2 3", so northing becomes 15 with no diagnostic.
  - `<F>1&#32;2 3</F>` becomes "12 3" and is refused.
  - `&custom;` in text is accepted, while the attribute path refuses it with `EntityForbidden`.
  - `max_character_references` is never charged for text, because `Text` events never contain `&`.
  - Tests only cover references in attributes and CDATA (tests/ingest.rs:1085-1101, 1148).
- Why it matters: valid or hostile input yields wrong coordinates silently, and the char-ref cap is bypassed. The comment at parser/text.rs:12-14 describes pre-0.38 quick-xml and is stale.
- Fix: handle `GeneralRef` once in the driver:
  - resolve with `BytesRef::resolve_char_ref` or `quick_xml::escape::resolve_predefined_entity`;
  - charge one char-ref;
  - refuse unknown entities with `EntityForbidden` and refuse references outside the root;
  - append the resolved text to the active capture;
  - add pull and stream tests.
- Effort: S

### EDGE-3: The streaming session desynchronises when one text token produces more than one event
- Category: Bug
- Severity: High
- Confidence: LIKELY
- Where: stream.rs:344-385 (single `break` after the first non-comment event); stream.rs:267-274 (text tokens split only on `<`).
- What:
  - A text token like "a&amp;b" yields Text, GeneralRef, Text. The reader then lags by two events for the rest of the document.
  - At `finish_cursor` (stream.rs:183) the closing `</LandXML>` is still unread, giving "unclosed XML element". With a lag of 1 and trailing whitespace the document is instead accepted, with the reference dropped.
  - Conversely, `&#32;<LandXML…>` yields a single GeneralRef that every parser ignores. The stream accepts it, but pull preflight refuses it (the test at ingest.rs:1130 is pull-only).
- Why it matters: stream and pull disagree on the same bytes.
- Fix: keep reading until the pad comment/PI for that token is consumed, and route GeneralRef through the EDGE-2 handler.
- Effort: S

### EDGE-4: Extension-root `path` strings amplify memory roughly 2000x
- Category: Bug
- Severity: High
- Confidence: CONFIRMED
- Where: parser.rs:161-176 (`path: self.path_with(local)`), parser/path.rs:31-38, limits.rs (`max_extensions` 100_000, `max_depth` 64, `max_name_bytes` 256).
- What: each foreign-namespace child of a target element stores the full joined ancestor path. Example input:
  - root declares `xmlns:x="urn:x"`;
  - 62 nested default-namespace elements with 256-byte names (~32 KB);
  - then 100 000 `<x:a/>` (~0.7 MB).
  - Each path is about 16 KB, so about 1.6 GB is retained, and serialized again for JSON/stream metadata.
  - No byte budget covers this, and `max_work` is not reached.
- Why it matters: a WASM out-of-memory from under 1 MB of input.
- Fix: charge path bytes to a budget (for example `max_extension_path_bytes`), or store segment indices and render paths lazily.
- Effort: S

### EDGE-5: The budget/limit counter pattern is duplicated 17 times, with drift
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - parser/limits.rs:16-25, 27-42, 44-56, 61-71, 75-88
  - parser/profiles/guards.rs:41-50, 52-64
  - plan/parser.rs:168-183; plan/parser/driver.rs:30-38, 40-49, 315-324; plan/parser/actions.rs:360-369
  - pipe_parser/handlers.rs:19-34, 36-48, 50-61
  - alignment/parser/driver.rs:24-39, 40-49, 50-59
  - xml.rs:22-58; stream/decoder.rs:49-55, 156-162
- What: each copy is `checked_add` → `> max` → `LimitExceeded`, plus a cancel poll. Drift:
  - Alignment reports "alignment limit exceeded" as `InvalidSemantic` (alignment/parser/actions.rs:26); TIN reports `LimitExceeded` (parser/profiles/start.rs:20).
  - Plan inlines char-ref accounting twice in one file.
- Why it matters: the same cap reports different error codes depending on which parser hits it.
- Fix: `xml::Budget { used, max, label }` with `reserve(n)`, a `Budgets` struct, and a single `poll(cancel)`.
- Effort: M

### EDGE-6: The linear-unit scale table and Units parsing are duplicated; `elevationUnit=""` behaves differently
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: semantics.rs:55-82 vs pipe_parser/convert.rs:12-49, 386-398. "Units only once" checks at parser.rs:265-272, plan/parser/driver.rs:99-115, alignment/parser/driver.rs:118-123, pipe_parser/units.rs:10-20. Area table at plan/parser/value.rs:7-18.
- What: there are two identical `scale` tables. TIN filters an empty or whitespace `elevationUnit` to "meter" (semantics.rs:57-60). Pipe keeps `""`, so `scale("")` fails and every Struct/Pipe is refused with "unsupported LandXML unit". Root Units is also parsed four times per document.
- Why it matters: the same Units element is accepted for terrain and refused for pipes.
- Fix: one `semantics::linear_scale(&str) -> Option<f64>` and one `units_from(&Attributes)`. Pipe units are built on top of the base units. Root units are decoded once by the driver.
- Effort: S

### EDGE-7: `assumed_linear_unit` is honoured only by TIN; pipe, plan and alignment ignore it
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: the contract at semantics.rs:102-105 says every entry point taking `LandXmlLimits` should call `resolve_assumed_units`. It is called only at parser.rs:54 and stream.rs:75. It is not called at pipe_parser.rs:33-43, plan/parser.rs:61-72, alignment/parser.rs:75-112, or for the three non-TIN parsers in stream.rs:81-93.
- What: for a unitless document with an assumed "foot":
  - terrain is scaled in feet;
  - pipes are refused with "pipe-network element requires Units" (pipe_parser/finalize/document.rs:70);
  - plan has `units: None` and `area_scale: None`;
  - alignment has `units: None`.
  - The pipe entry point also does not reject an invalid token such as "furlong".
- Why it matters: one caller-supplied assumption is applied to terrain only, and the documented contract is not enforced.
- Fix: resolve the assumed unit once in the driver and pass effective units to every family.
- Effort: S

### EDGE-8: The pull "canonical document" re-parses the input 3–4 times; the WASM options path drops pipes; an error is matched by string
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: parser/document.rs:13-23, plan.rs:34-41, rust/wasm-bindings/src/api/landxml/endpoints/methods.rs:36-64 and 71-115. The stream (stream.rs:80-93) already fans one pass out to all four parsers.
- What:
  - Each pass re-runs `normalize_encoding` (a full copy), preflight and quick-xml. `parseLandXmlSourceBytes` does four passes.
  - `parseLandXmlSourceBytesWithOptions` calls `parse_landxml_tin_with_cancel`, so `terrain.pipe_networks` is always `None` there. The other two paths include pipes. This is a behaviour difference, not just cost.
  - parser/document.rs:17-20 matches `error.message == "document contains no PipeNetwork records"`, which is coupled to pipe_parser/finalize/document.rs:28.
  - The doc comment at parser/document.rs:8-12 ("cannot accidentally load pipe records through a second ingestion path") is stale.
- Why it matters: repeated whole-document passes, inconsistent results between the two WASM endpoints, and a string-coupled error check.
- Fix: one `parse_landxml_source_with_cancel(input, &SourceLimits, cancel)` built on the EDGE-1 fan-out with `require_pipe_networks = false`, called by both WASM endpoints.
- Effort: M

### EDGE-9: Alignments are parsed twice into two public types; plan point, location and properties types are also duplicated
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Alignment parsing: parser/profiles/dispatch.rs:26-28 plus parser/profiles/start.rs:18-34, vs alignment/parser/actions.rs:24-55.
  - `LandXmlAlignment`: profile.rs:17 vs alignment/model.rs:208.
  - `LandXmlPlanPoint`: alignment/model.rs:14 vs plan/model.rs:18.
  - `LandXmlPointLocation` (alignment/model.rs:24) vs `LandXmlPlanPointLocation` (plan/model.rs:27).
  - `BTreeMap<String,String>` aliased three times: model.rs:8, plan/model.rs:14, pipes.rs:16.
  - `max_alignments` defined twice: limits.rs:72 and alignment/parser.rs:27.
  - `plan_point` at alignment/parser/actions/values.rs:74-92 vs `point` at plan/parser/value.rs:69-90; `point_list` (94-110) vs `points_limited` (91-118).
- What:
  - Both parsers produce the same id `landxml:alignment:{ordinal}:{name}`.
  - Drift: the limit error code differs (EDGE-5); only the alignment parser refuses a nested Alignment (actions.rs:28-30); error texts differ.
  - The alignment parser drops an authored `pntRef` when coordinates are also present (actions.rs:296-317). Plan keeps both (plan/parser/actions.rs:200).
  - Stream and WASM build `LandXmlAlignmentLimits { ..Default }`, so the caller's `max_alignments` does not reach the alignment parser.
- Why it matters: two public types for the same record, and the same element is validated differently.
- Fix: one point type, one location type and one properties alias in model.rs; one owner for the alignment header; a single `max_alignments`.
- Effort: M

### EDGE-10: Whitespace-separated finite-f64 coordinate parsing is reimplemented about 10 times
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - semantics.rs:22-40
  - parser/capture.rs:57-86 and 108-139 (jscpd 61-73 vs 114-126)
  - parser/profiles/values.rs:8-19, 21-40, 42-74, 101-111
  - plan/parser/value.rs:26-68, 69-90, 91-118
  - alignment/parser/actions/values.rs:27-52, 74-110
  - pipe_parser/convert.rs:357-384
- What: I checked all 10 `parse::<f64>` sites; every one rejects NaN and inf. What differs is count-before-allocate, arity rules and messages:
  - TIN counts tokens, then parses again.
  - Alignment counts in `finish_capture`, then re-parses.
  - Pipe never pre-counts.
  - None of them trim attribute whitespace.
- Why it matters: the copies stay correct only as long as each one is maintained separately.
- Fix: `semantics::finite(&str) -> Option<f64>`, and `coord_list(text, dim, min_points, &mut Budget) -> Result<Vec<f64>>` that counts, reserves and parses once.
- Effort: S

### EDGE-11: Encoding normalization is duplicated between pull and stream
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: xml.rs:145-255 vs stream/decoder.rs:29-153.
  - BOM table: xml.rs:152-159 vs decoder.rs:94-101.
  - UTF-16 decode: xml.rs:208-246 vs decoder.rs:119-153.
  - Normalized-size bound: xml.rs:164-168 vs decoder.rs:30-34.
  - Declaration constant: `DECLARATION_LIMIT` (xml.rs:258) vs `DECLARATION_BYTES` (decoder.rs:12), both 1024.
- What: the batch path is a special case of the incremental decoder.
- Why it matters: any encoding fix has to be made twice.
- Fix: keep only `Decoder`; `normalize_encoding` becomes `push(input)` followed by `finish()`.
- Effort: S

### EDGE-12: The lexical tokenizer is duplicated (preflight vs stream), and both share a `<!-->` overlap bug
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: preflight.rs:16-74 and 125-181 vs stream.rs:267-323.
- What: there are two lexers for comment/CDATA/PI termination and quote tracking. Both let the opener's own `--` count as the terminator: preflight.rs:134 checks from the token start, and stream.rs:281 uses `ends_with(b"-->")`. So `<!-->x-->` is treated as a closed `<!-->`:
  - Pull falsely refuses `<!-->x--><LandXML…>` as "non-whitespace content outside root".
  - Inside the root, quick-xml receives one comment token larger than `max_text_bytes`.
  - The stream hits EOF inside the comment and reports InvalidXml.
- Why it matters: the same legal construct is refused falsely by pull, refused differently by stream, and slips past the `max_text_bytes` token cap that preflight exists to enforce.
- Fix: one incremental `TokenScanner` used by both; start the terminator search after the opener.
- Effort: M

### EDGE-13: Progress-error mapping in terrain.rs is copy-pasted 8 times inside a 375-line function
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - The eight copies: terrain.rs:197-211, 216-231, 243-258, 263-278, 282-297, 313-324, 328-343, 352-365.
  - `adapt_faceless_tin` spans terrain.rs:25-400.
  - `diagnostic()`: terrain.rs:22 vs terrain_topology.rs:37.
  - `on_segment` (terrain_topology.rs:158-164) vs `point_on_segment` (terrain_validation.rs:16-22).
- What: the same `match charge_work() { WorkLimit => Ok(Some(diag)), Cancelled => Err, _ => unreachable! }` appears eight times. The file sits at the 400-line ratchet and uses `#[path]` to reach its siblings.
- Why it matters: eight identical blocks to keep in sync inside a function too long to review.
- Fix: an `enum Outcome { Refuse(Diag), Fail(LandXmlError) }` with `From<TerrainCdtError>`, an inner function using `?`, and a `terrain/` directory.
- Effort: S

### EDGE-14: Every element clones the namespace map and the whole frame, in all four parsers (so four times per element in stream)
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Namespace map clone: parser.rs:104-110, plan/parser/driver.rs:50-54, pipe_parser.rs:139-143, alignment/parser/driver.rs:69-73.
  - Frame clone in `end()`: parser.rs:348-352, plan/parser/driver.rs:256-260, pipe_parser/driver.rs:14-18, alignment/parser/driver.rs:195-199.
  - Attributes decoded per parser: xml.rs:60-93.
- What: every element allocates a new `HashMap<String,String>` per parser. `end()` clones the full Frame (the TIN frame includes `child_ordinals`, `overlay_properties` and namespaces) only to read `local` and `target`. Attributes are decoded into owned Strings separately by each of the four parsers.
- Why it matters: for 5M `<P>` plus 10M `<F>`, that is on the order of 60M map allocations in stream mode.
- Fix: share `Rc<Namespaces>` unless the element declares xmlns; borrow `frames.last()` in `end()`; decode attributes once in the driver.
- Effort: S

### EDGE-15: The pipe parser builds a BTreeMap of all attributes for every LandXML element
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: pipe_parser.rs:200 (built before the `match`), pipe_parser/state.rs:63-65.
- What: this runs for every `<P>`, `<F>`, CgPoint and so on, even in terrain-only documents (in the full-document pull path and in the stream). The map is discarded unless a pipe element matched.
- Why it matters: millions of throwaway map allocations in terrain-heavy documents.
- Fix: build the map only inside the matched arms.
- Effort: S

### EDGE-16: Stream transport copies every byte about 5 times, byte by byte, plus a debug copy per token and a JSON serialization per event just to measure it
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - stream.rs:251-258: `pop_front` per byte.
  - stream.rs:267-311: per-byte token push.
  - stream.rs:330: `String::from_utf8_lossy(&token).into_owned()` for every token, used only in an error message.
  - stream/token.rs:28-33: per-byte `pop_front`.
  - stream/output.rs:97-104: `serde_json::to_vec` only to take `.len()`.
  - stream/event.rs:49,180: `payload_utf8: Vec<u8>` serializes as a JSON number array (about 3.5x size).
- Why it matters: every input byte goes through several per-byte copies, every token is copied once more for a debug string, and every event is serialized once just to be measured.
- Fix:
  - scan with `memchr` over slices;
  - back the feed with a `Vec` plus an offset;
  - build the debug string lazily in `map_err`;
  - measure with a counting writer;
  - use `serde_bytes` for the payloads.
- Effort: M

### EDGE-17: TIN `child_ordinals` keeps one entry per distinct child name (memory amplification)
- Category: Bug
- Severity: Medium
- Confidence: LIKELY
- Where: parser.rs:150-157, parser/state.rs:174.
- What: every element inserts `(bool, String)` into its parent's map, which lives as long as the parent. The ordinals are only used by `capture_path` (parser/path.rs:44-57). A root followed by about 6M distinct `<aNNNNNN/>` children (64 MB, under `max_work`) would hold about 6M entries, roughly 400 MB.
- Why it matters: a large memory multiple from input within the byte limit, for data used only inside Surfaces.
- Fix: track ordinals only inside the Surfaces/Surface subtree, or cap the number of distinct names.
- Effort: S

### EDGE-18: Text/CDATA-outside-root and nested-element-in-capture rules differ across parsers
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - Outside-root text: parser/text.rs:40-54 and 81-83; alignment/parser/driver.rs:353-371; plan/parser/driver.rs:309-314, 352-354, 379-381; pipe_parser/driver.rs:94-96 and 110-127; preflight.rs:30-35, 54-59, 93-95.
  - Nested elements in a capture: parser/text.rs:56-61 (TIN ignores), plan/parser/driver.rs:13-22 (refuses), alignment/parser/driver.rs:102-111 (refuses), pipe_parser.rs:190-196 (marks the record invalid).
- What:
  - Pipe uses Unicode `trim` (so NBSP outside the root passes) and does not refuse CDATA outside the root.
  - TIN accepts `<P id="1">1 2 <Foo>9</Foo>3</P>` as "1 2 3"; the same shape is refused for CgPoint and AlignPI.
  - `is_xml_s` is defined three times plus once inline.
- Why it matters: the same malformed input is ignored, refused or marked invalid depending on which family reads it.
- Fix: the driver owns outside-root rules; apply one capture policy (refuse descendants) to all numeric captures.
- Effort: S

### EDGE-19: Attribute-to-properties helpers exist three times, with an xmlns difference; Feature/Property parsing exists twice
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: parser/state.rs:199-205 and plan/parser/state.rs:83-89 (filter `xmlns*`) vs pipe_parser/state.rs:63-65 (no filter). Property element: pipe_parser.rs:274-289 vs plan/parser/actions.rs:339-359.
- What: pipe records keep `xmlns` / `xmlns:x` as properties; the other two drop them. The Property error messages differ.
- Why it matters: the same element yields different property sets depending on the family.
- Fix: `xml::properties(&Attributes)` and `xml::property_kv(&Attributes)`.
- Effort: S

### EDGE-20: Pipe part conversion arms are copy-pasted
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: pipe_parser/convert.rs:106-129, 130-153, 154-177; also 89-105, 188-204, 205-228.
- What: the Elli, Egg and Rect arms are identical apart from field names.
- Why it matters: a dimension-rule change must be repeated in each arm.
- Fix: one `PartDims` builder per dimension set.
- Effort: S

### EDGE-21: The plan resolver work-budget formula is duplicated across crates
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: stream/derived/plan.rs:242-263 and rust/wasm-bindings/src/api/landxml/endpoints.rs:237-263.
- What: identical `cogo*8 + requests*8 + 1000` logic.
- Why it matters: changing the budget in one crate silently desyncs the stream and WASM resolvers.
- Fix: `LandXmlPlanDocument::resolution_work_limit()` or `LandXmlPlanResolver::for_document(plan)`.
- Effort: S

### EDGE-22: Error codes and error types are inconsistent
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: alignment/parser/actions.rs:26 (wrong code); alignment/parser/state.rs:269-274 (`invalid`/`limit` helpers) vs xml.rs:320 (`error`); `Result<_, String>` throughout pipe_parser/convert.rs and pipe_parser/finalize/helpers.rs; the string-matched error at parser/document.rs:17-20.
- What: three error-construction styles, and one control-flow decision keyed on message text.
- Why it matters: rewording a message silently changes behaviour, and the same failure surfaces with different codes.
- Fix: an internal typed refusal enum and a single `error()`.
- Effort: S

### EDGE-23: The XML declaration check is skipped when byte 1024 falls inside a UTF-8 character
- Category: Bug
- Severity: Low
- Confidence: CONFIRMED
- Where: xml.rs:258-266; stream/decoder.rs:163-167 and 87.
- What: `from_utf8(prefix[..1024]).ok()` returns `None`, which is treated as "no declaration". So `<?xml version="1.0" encoding="ISO-8859-1"?>` followed by a comment padded so that "é" straddles byte 1024 bypasses the unsupported-encoding refusal.
- Why it matters: the unsupported-encoding refusal can be skipped by padding alone.
- Fix: truncate at `Utf8Error::valid_up_to()` before reading the declaration.
- Effort: S

### EDGE-24: Repeated CoordinateSystem warnings are unbounded
- Category: Bug
- Severity: Low
- Confidence: CONFIRMED
- Where: parser.rs:213-219.
- What: each repeated root `<CoordinateSystem/>` (19 bytes) pushes an ~85-byte warning. 64 MB of them gives about 3.5M warnings, and no cap exists.
- Why it matters: output grows several times larger than the input with no limit check.
- Fix: warn once with a count.
- Effort: S

### EDGE-25: TIN and alignment allocate an unescaped String for every text node
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: parser/text.rs:19 and alignment/parser/driver.rs:265 unescape before checking for a capture. Plan (plan/parser/driver.rs:325-329) and pipe (pipe_parser/driver.rs:97-101) check first.
- What: whitespace between elements and uncaptured text allocate a String each time, and given EDGE-2 the unescape never changes anything.
- Why it matters: an avoidable allocation per text node on the hottest path.
- Fix: check the capture first and borrow `&str`.
- Effort: S

### EDGE-26: Fragile index arithmetic in plan `start()`
- Category: Bug
- Severity: Low
- Confidence: SUSPECT
- Where: plan/parser/driver.rs:191 (`frames[depth..len-1]`) vs line 220 (`saturating_sub`); plan/parser/actions.rs:229 (`max_vertices - vertices`), with the counter bumped before the cap check at 360-368.
- What: safe today only because errors abort the parse. Not reachable with current invariants.
- Why it matters: the next change that makes these paths non-fatal turns them into panics or wraparound.
- Fix: `checked_sub`, or `Budget::remaining()`.
- Effort: S

### EDGE-27: Degenerate faces are accepted
- Category: Quirk
- Severity: Low
- Confidence: SUSPECT
- Where: semantics.rs:42-53; parser/finalize.rs:65-75.
- What: `<F>1 1 2</F>` passes; finalize only checks that the ids exist. It may be intended as source-preserving behaviour.
- Why it matters: if not intended, downstream renderers have to cope with zero-area faces.
- Fix: refuse, or flag with a diagnostic.
- Effort: S

### EDGE-28: God functions and structs, stringly-typed paths, sentinel roles
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `start()`: parser.rs:95-345 (250 lines), plan/parser/driver.rs:12-254 (242), pipe_parser.rs:130-367 (237).
  - terrain.rs:25-400 (375); plan/parser/actions.rs:117-251 (134).
  - Structs: parser/state.rs:22-76 (40 `pub(super)` fields), plan/parser.rs:97-130 (33), pipe_parser/state.rs:15-54 (38).
  - The "PipeNetworks" literal appears 31 times in pipe_parser; "Alignments" 16 times in parser/profiles/dispatch.rs.
  - Sentinel role strings: `"__location"` (plan/parser/driver.rs:226), `"__align_pi"` and `"__alignment_start"` (alignment/parser/driver.rs:147, 171).
  - `#[allow(private_interfaces)]` at plan/parser.rs:96.
  - The guard at plan/parser/driver.rs:16 is always true.
  - Several files sit at the 400-line ratchet and are split by line count rather than concept: terrain.rs 400, alignment/parser/driver.rs 399, convert.rs 398; pipe units are split between units.rs and convert.rs.
- What: paths are matched by repeated O(depth) string-slice comparisons several times per element.
- Why it matters: these are the hardest parts of the crate to review, and the repeated path literals invite typos.
- Fix: a per-frame context enum state machine instead of `is_path` slices, enums for capture roles, and a concept-based split.
- Effort: L

### EDGE-29: Public surface and naming
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: lib.rs:11 (`pub mod alignment`) and lib.rs:43 (root `LandXmlAlignment`); the crate-private `parse_landxml_document` (parser/document.rs:13) vs the public one (plan.rs:34); `LandXmlTinStreamSession` (stream.rs:46) streams all families.
- What:
  - There are two public `LandXmlAlignment` and two public `LandXmlPlanPoint` types.
  - The TIN, pipe and plan entry-point docs say "exact LandXML 1.2" (parser.rs:37, pipe_parser.rs:27, plan/parser.rs:56), but those parsers accept 1.0/1.1 too (the alignment parser's doc also says 1.2).
  - The two WASM methods duplicate their serialization tails.
- Why it matters: callers cannot tell which type or entry point is canonical, and the docs understate what is accepted.
- Fix: unify the types, rename the session, and correct the docs.
- Effort: S

### Concept inventory
- **Number/float parsing:**
  - semantics.rs: `positive_id` 10, `triple` 22, `references` 42.
  - parser/capture.rs: inline at 66-86 and 119-139.
  - parser/profiles/values.rs: `finite_attr` 8, `optional_finite_attr` 21, `station_elevation` 42, `station_elevations` 58, `station_elevation_count` 79, `finite` 101.
  - plan/parser/value.rs: `optional_finite` 26, `optional_positive` 35, `finite` 53, `point` 69, `points_limited` 91.
  - alignment/parser/actions/values.rs: `finite_attr` 27, `optional_finite_attr` 31, `finite` 41, `radius` 54, `plan_point` 74, `point_list` 94.
  - pipe_parser/convert.rs: `parse_measure` 326, `measure` 337, `optional_number` 357, `finite_values` 372.
- **Unit tables and conversion:** semantics.rs: `units` 55, `scale` 70, `assumed_units` 91, `resolve_assumed_units` 106. pipe_parser/convert.rs: `units` 12, `scale` 386. plan/parser/value.rs: `area_scale` 7.
- **Tolerances/epsilons:** pipe_parser/inverts.rs:154 `elevations_match` (1e-9 m); terrain_validation.rs:29-40 `elevations_agree` (8 × `f64::EPSILON` × scale).
- **Bounding boxes:** none in scope.
- **Hashing/keys:** terrain_topology.rs:44 `bits()` (zero-normalized f64 bits as a BTreeMap key); `child_ordinals` at parser/state.rs:174; `refusal_keys` at pipe_parser/state.rs:43.
- **Triangulation/polygon:**
  - terrain.rs:25 `adapt_faceless_tin`.
  - terrain_topology.rs: `add_vertex` 52, `line_vertices` 103, `orient` 143, `on_segment` 158, `edges_touch` 166, `validate_simple_ring` 180, `ring_edges` 222, `point_in_ring` 260, `canonical_vertices` 289.
  - terrain_filter.rs:10 `point_is_in_permitted_region`.
  - terrain_validation.rs: `point_on_segment` 16, `segment_fraction` 59, `validate_split_elevations` 100.
  - `ifc_lite_geometry::triangulate_terrain_pslg_with_progress`.
- **Attribute access:**
  - xml.rs: `attributes` 60, `attr` 95, `required` 102, `split_name` 112, `utf8` 120, `character_references` 131, `unescape` 135.
  - Properties helpers: parser/state.rs:199, plan/parser/state.rs:83, pipe_parser/state.rs:63.
- **Error types:**
  - model.rs: `LandXmlDiagnosticCode` 12, `LandXmlError` 42, `LandXmlTerrainDiagnostic` 230.
  - profile.rs:205 `LandXmlCapabilityDiagnostic`.
  - xml.rs:320 `error()`; alignment/parser/state.rs:269 `invalid` and 272 `limit`.
  - Pipe `Result<_, String>` refusals plus `LandXmlPipeRefusal`.
  - terrain_topology `TopologyValidationError`; terrain_validation.rs:10 `SplitElevationValidationError`.
- **Limits/caps:**
  - limits.rs:41-137 `LandXmlLimits`; plan/parser.rs:33 `LandXmlPlanLimits`; alignment/parser.rs:25 `LandXmlAlignmentLimits`.
  - Stream constants stream.rs:30-39; xml.rs:20 `CANCELLATION_POLL_BYTES`; preflight.rs:99 `max_markup_bytes`.
  - xml.rs:258 `DECLARATION_LIMIT` and stream/decoder.rs:12 `DECLARATION_BYTES`.
  - Budget helpers as listed in EDGE-5.