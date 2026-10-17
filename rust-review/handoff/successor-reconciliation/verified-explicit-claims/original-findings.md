## PROCESSING-5 — 05-processing.md:73

73: ### PROCESSING-5: `apps/server` has its own `detect_schema_version` that disagrees with processing's
74: - Category: Bug (DRY drift)
75: - Severity: High
76: - Confidence: CONFIRMED
77: - Where: `apps/server/src/services/streaming.rs:56-88` (`find_bytes` + `detect_schema_version`, header-only, case-sensitive) vs `rust/processing/src/processor/schema_detection.rs:22-39` (whole-file, case-insensitive, "IFC4X3 anywhere wins"); consumer `apps/server/src/routes/parse/json.rs:259` (`/metadata` endpoint) vs `ModelMetadata.schema_version` on every geometry endpoint.
78: - What: the server version says `FILE_SCHEMA(('ifc4'))` is `IFC2X3` (case-sensitive `windows()` search), which #4661 fixed in processing; the processing version says a file whose header is `IFC2X3` but whose DATA contains the substring `IFC4X3` (a description, a comment, a `IfcPropertySingleValue` text) is `IFC4X3`, which the server comment at `:64` explicitly forbids ("Schema-like text in DATA values or comments must not influence metadata"). The two documented intents contradict each other, and neither owner knows about the other.
79: - Why it matters: `/api/v1/metadata` and `/api/v1/parse` on the same upload return different `schema_version`; a client keying schema-dependent behaviour (attribute indices, 2x3 vs 4 property layouts) on one endpoint gets the other's answer. `find_bytes` is also an O(n·m) `windows()` scan over the full content for `ENDSEC;`.
80: - Fix: export `ifc_lite_processing::detect_schema_version` (header-scoped AND case-insensitive — the header-scoping argument is the correct one; fix processing to search only `[..data_section_start]` via `ifc_lite_core` `scanner_header::data_section_start`), delete the server copy, pin with a test that feeds both a lowercase header and an `IFC4X3`-in-DATA decoy.
81: - Effort: S
82: 

## SERVER-18 — 08-server.md:242

242: ### SERVER-18: Schema detection is duplicated, and `/parse/metadata` disagrees with `/parse`
243: - Category: DRY / Bug
244: - Severity: Medium
245: - Confidence: CONFIRMED
246: - Where:
247:   - apps/server/src/services/streaming.rs:56-85 (`find_bytes` + `detect_schema_version`: case-SENSITIVE, header-only, defaults IFC2X3), used by routes/parse/json.rs:259
248:   - rust/processing/src/processor/schema_detection.rs:20 (case-insensitive since #4661, whole-file, defaults IFC2X3), which feeds `ProcessingResult.metadata.schema_version` on every other route
249:   - rust/export/src/schema_detect.rs:13 → `core::parser::header::declared_schema` (proper header parser, defaults IFC4)
250: - What: For `FILE_SCHEMA(('ifc4'))`, `/parse/metadata` reports `IFC2X3` while `/parse` reports `IFC4`. That is the exact bug #4661 fixed in processing and #4593 fixed in export ("Keeping a second scanner here previously gave long and lower-case headers different answers"). A file whose DATA section mentions IFC4X3 gives the opposite disagreement.
251: - Why it matters: Clients that route by schema get inconsistent answers from the same server.
252: - Fix: Delete the server copy and use `ifc_lite_core::declared_schema_bounded` + `SchemaVersion::from_file_schema` everywhere (processing too). That leaves one detector with one default.
253: - Effort: S
254: 

## PROCESSING-APP-2 — 05-processing.md:610

610: ### PROCESSING-APP-2: `evaluated::wire` panics (`unreachable!`) on a file-supplied `*` attribute
611: - Category: Bug
612: - Severity: High
613: - Confidence: LIKELY
614: - Where: `rust/processing/src/appearance/evaluated.rs:24-32`; callers feeding file attributes: `evaluated_replacement.rs:53` (`body.attributes.to_vec()` of the source `IfcShapeRepresentation`) and `:64` (`layer.attributes.to_vec()`)
615: - What: `evaluated_replacement::replace` clones the occurrence's Body wrapper when a type `IfcRepresentationMap` shares it; attribute 0 (`ContextOfItems`) is copied verbatim from the file into `authored(...)`, which runs every attribute through `evaluated::wire`. `ifc_lite_core` decodes `*` as `AttributeValue::Derived` (`core/src/schema_gen.rs:111`), which hits `unreachable!`. `evaluated_source::body` only checks attrs 1 (`get_string(1)=="Body"`) and 2/3; attr 0 is never type-checked.
616: - Why it matters: an IFC4 file with `#43=IFCSHAPEREPRESENTATION(*,'Body','SweptSolid',(#44));` where `#43` is also referenced by an `IfcRepresentationMap`, planned with `representationPolicy: evaluatedOccurrence` -> panic; under `release` (`panic='abort'`) the wasm instance dies instead of returning an exclusion.
617: - Fix: collapse into `authored::wire` (APP-1) which already maps `Derived -> "*"`; additionally validate attr 0 is an `EntityRef` in `evaluated_source::body`.
618: - Effort: S
619: 

## EXPORT-DATA-6 — 07c-export-data-model.md:75

75: ### EXPORT-DATA-6: HBJSON/DFJSON coordinates already passed through f32; the "rebase keeps survey precision" comment is wrong
76: - Category: Bug (stale justification)
77: - Severity: Medium
78: - Confidence: LIKELY
79: - Where:
80:   - rust/export/src/rooms.rs:8-9 (doc), 45-55 (origin)
81:   - rust/export/src/geom.rs:17-24 (`xf` reads `t[12..14]` from `[f32; 16]`)
82:   - rust/geometry/src/profile_extractor.rs:68 (`transform: [f32; 16]`, no RTC)
83:   - Also openings.rs:32 and shades.rs:44
84: - What: the world translation is stored in f32 before export sees it. At LV95 magnitudes (E about 2.6e6) the f32 step is 0.25 m. Rebasing in f64 afterwards cannot recover that, and the JSON output is f64 anyway. The origin is then thrown away (`_origin` in dfjson/plates.rs:68), so no georeference survives.
85: - Why it matters: each space, window and railing is shifted rigidly by up to about 0.125 m relative to the others. That is the same order as `MAX_LATERAL = 0.15` (adjacency.rs) and the opening placement windows, so on national-grid models adjacencies go unmatched and windows are misplaced. rust/AGENTS.md's RTC note applies directly here.
86: - Fix: add an f64 translation (or an RTC offset) to `ExtractedProfile`, or call `extract_profiles` after setting an RTC offset. Correct the rooms.rs comment and consider emitting the origin.
87: - Effort: M
88: 

## SERVER-26 — 08-server.md:329

329: ### SERVER-26: Material association rows multiply elements × layers with no cap
330: - Category: Bug (DoS amplification)
331: - Severity: Medium
332: - Confidence: LIKELY
333: - Where: services/data_model/materials.rs:262-307
334: - What: Each `IfcRelAssociatesMaterial` emits one `MaterialAssociation` row per related element × per resolved layer, cloning five strings per row. A ~10 MB file with one association relating 10⁶ elements to a 1,000-layer set yields 10⁹ rows.
335: - Why it matters: Admission charges only the upload size, so a small file can OOM the server.
336: - Fix: Emit the definition once (definition table) plus an `element → definition` link table, or cap total rows with an explicit error. At minimum, `Arc<str>` the shared strings.
337: - Effort: M
338: 
