# Product Requirements (PRD)

Priority: **M** = must for public launch (end of cycle 3 beta / cycle 6 GA as marked), **S** = should, **C** = could.
Release column: **β** public beta, **GA** general availability, **L** later.
Each FR traces to jobs (J-x) and pitches (P-x). Acceptance criteria are written so they can become tests.

## A. Document & editing core

| ID | Requirement | Pri | Rel | Jobs | Pitch | Acceptance |
|---|---|---|---|---|---|---|
| FR-A01 | Studio represents any IDS 1.0 document losslessly, including info/metadata, all six facets in applicability and requirements, all restriction kinds (simple, pattern, enumeration, bounds, length, minLength, maxLength, totalDigits, fractionDigits) and **multiple restriction facets per value** | M | β | J3,J16 | P-01,P-02 | Target: `parse→model→canonical serialization→parse` identity on all 334 corpus files + fuzzed docs. This internal writer fidelity check is separate from user export admission; invalid cases must retain diagnostics and be rejected by FR-A06. Unsupported forms retain source + explicit diagnostics until lossless coverage is implemented and qualified |
| FR-A02 | Every node (document, spec, facet, value) has a stable ID that survives edits, reorders and save/load | M | β | J9,J11 | P-02 | IDs stable across 1,000 random op sequences; persisted in sidecar |
| FR-A03 | All mutations go through typed, invertible operations; undo/redo is unlimited within a session and persisted per document | M | β | J9 | P-02 | Property test: `apply(op); apply(inverse(op))` ≡ original |
| FR-A04 | Grounding gate: an op that references a standard IFC entity, predefined type, attribute, pset (`Pset_`/`Qto_`), property, enumeration value or data type that doesn't exist for the spec's IFC version(s) is rejected with ranked candidates | M | β | J3,J14 | P-02 | Gate tests per name kind × version; candidate ranking test |
| FR-A05 | Custom psets/properties are allowed but explicitly flagged `custom`; reserved prefixes (`Pset_`, `Qto_`, …) cannot be used for custom names | M | β | J3 | P-02 | Gate + lint tests |
| FR-A06 | Export produces IDS 1.0 XML that passes Studio audit **and** the official buildingSMART audit tool | M | β | J1 | P-01 | CI job runs `ids-audit-tool` on exported corpus + generated docs |
| FR-A07 | Import IDS 1.0 and 0.9.7; 0.9.7 is upgraded with a list of changes | M | β | J16 | P-03 | Corpus + 0.9.7 fixtures |
| FR-A08 | Multi-version specs (e.g. `IFC2X3 IFC4`) are supported; pickers show the intersection, lints flag version-specific names | S | β | J3 | P-02 | Tests |
| FR-A09 | Studio metadata (IDs, provenance, comments, tests, revisions) is stored in a sidecar (`studio.json` inside an `.idsz` bundle, per P-02 `SIDECAR_FILENAME`) or the library, never in IDS XML | M | β | — | P-02 | Exported XML byte-identical with/without sidecar |
| FR-A10 | Canonical formatting (`fmt`): stable element order, indentation and namespace prefixes so diffs are minimal | S | β | J9,J12 | P-01 | Golden tests |

FR-A04 is the target grounding contract. The published P-02 checkpoint leaves reserved `Qto_` names unverified for versions without quantity-set tables; IDS-009 must qualify those tables and positive/negative gate controls before this target is met for those versions (ADR-003). This does not permit a reserved-name custom override.

## B. Studio UI

| ID | Requirement | Pri | Rel | Jobs | Pitch |
|---|---|---|---|---|---|
| FR-B01 | Studio workspace in the viewer: **outline** (specs → applicability/requirements → facets), **inspector** (selected node), **grid** (spreadsheet view of all facets), **XML preview** (read-only, synced) | M | β | J3,J7 | P-03 |
| FR-B02 | Every facet shows a plain-language sentence beside its technical form, in en/de/fr/it | M | β | J7,J15 | P-03 |
| FR-B03 | Pickers: entity (searchable, hierarchy-aware, abstract flagged), predefined type (per entity/version), attribute (per entity incl. inherited), pset (filtered by `applicableEntities` of the applicability entities; "show all" toggle), property (with dataType + description), enumeration values (from schema/bSDD/model), data type, unit-aware numeric input | M | β | J3 | P-03 |
| FR-B04 | Value editor for every restriction kind with live examples ("matches: 'EI60', 'EI90'; doesn't match: 'ei60'"); **Regex assistant**: describe → pattern, pattern → explanation, test strings | M | β | J3,J4 | P-03, P-07 |
| FR-B05 | Live diagnostics panel (audit + lint), inline markers in outline/inspector/grid, click-to-focus, quick fixes | M | β | J3,J4 | P-03,P-04 |
| FR-B06 | Grid view supports bulk edit (multi-cell paste, fill-down, find/replace across specs), sorting, filtering, freeze columns | M | β | J1 | P-03 |
| FR-B07 | Templates gallery (spec-level and document-level), search, preview with live counts | S | β | J1 | P-03 |
| FR-B08 | Library: documents with revisions (immutable snapshots), labels (draft/review/released), restore, duplicate, delete | M | β | J9 | P-03 |
| FR-B09 | Keyboard-first: command palette actions for every op, outline navigation, quick-add facet, undo/redo | S | β | — | P-03 |
| FR-B10 | Learn mode: contextual explanations of IDS concepts and sharp edges, linked to the cheat sheet | C | GA | J15 | P-03 |
| FR-B11 | Works on tablet widths (outline+inspector stacked); grid read-only below 768 px | C | GA | — | P-03 |

## C. Diagnostics

| ID | Requirement | Pri | Rel | Jobs | Pitch |
|---|---|---|---|---|---|
| FR-C01 | Audit detects all 27 `invalid-` corpus cases (`AUDIT_UNDETECTED` empty) | M | β | J16 | P-01 |
| FR-C02 | Lint engine with stable rule codes, severities (error/warning/info), per-rule docs and quick-fix ops; ≥ 25 rules at β, ≥ 35 at GA (catalogue in `03-diagnostics-audit-lint.md`) | M | β | J3,J4 | P-04 |
| FR-C03 | Rules run statically (schema/bSDD) and, when a model is loaded, model-aware (e.g. never-applies on real data) | M | β | J2 | P-04,P-05 |
| FR-C04 | Users can suppress a lint per spec with a reason (stored in the sidecar) | S | β | — | P-04 |
| FR-C05 | Lint precision ≥ 95% on the labelled lint corpus (false positives are product bugs) | M | GA | — | P-04 |

## D. Model loop

| ID | Requirement | Pri | Rel | Jobs | Pitch |
|---|---|---|---|---|---|
| FR-D01 | Per-spec live **applicability funnel**: count after each applicability facet, across all loaded models; updates ≤ 300 ms after edit for 100k-element models (p95), with progressive results for larger | M | β | J2 | P-05 |
| FR-D02 | Per-spec live **requirement preview**: pass/fail/not-applicable counts; per requirement facet failure counts | M | β | J2,J6 | P-05 |
| FR-D03 | Click any funnel stage / count → isolate/ghost/colour those elements in 3D (federation-aware) | M | β | J2,J7 | P-05 |
| FR-D04 | **Explain** for any element × spec: trace of every facet evaluation with actual values, units and the reason | M | β | J4 | P-05 |
| FR-D05 | **Infer from selection**: from a 3D/table selection propose applicability + requirements (constants → simpleValue, small sets → enumeration, numeric → bounds, strings → pattern) with confidence and **contrast** against unselected same-class elements | M | β | J5 | P-05 |
| FR-D06 | **Coverage lens**: colour the model by number of specs applying (0 = ungoverned); list ungoverned classes by count | S | β | J13 | P-05 |
| FR-D07 | Value suggestions from the model in pickers (distinct values with counts per entity/pset/property) | M | β | J3 | P-05 |
| FR-D08 | Fix-in-place: from a failure, write the required value via mutations (single/bulk), with preview; export corrected IFC | S | GA | J8 | P-05 |
| FR-D09 | BCF from failures (existing) grouped per spec, with viewpoints | M | β | J8 | existing |

## E. bSDD

| ID | Requirement | Pri | Rel | Jobs | Pitch |
|---|---|---|---|---|---|
| FR-E01 | bSDD class search scoped by dictionary, language and related IFC entity; result previews properties | M | β | J3 | P-06 |
| FR-E02 | Insert bSDD class as classification facet (system, value, URI) and/or entity facet (related IFC entity) | M | β | J3 | P-06 |
| FR-E03 | Insert bSDD class properties as property requirements (pset name, property, dataType mapping, allowed values → enumeration, units → SI conversion note) | M | β | J3,J10 | P-06 |
| FR-E04 | Dictionary → IDS generator: choose dictionary + classes → one spec per class (inheritance, datatypes, values), preview, apply as one batch | S | GA | J10 | P-06 |
| FR-E05 | URI health: lint unknown/deprecated/inactive class or property URIs; suggest replacements | S | GA | J3 | P-06 |
| FR-E06 | Export custom psets/properties as a bSDD import-JSON draft | C | L | J10 | P-06 |
| FR-E07 | Offline: bSDD results cached; Studio fully functional without bSDD | M | β | — | P-06 |

## F. AI assistant

| ID | Requirement | Pri | Rel | Jobs | Pitch |
|---|---|---|---|---|---|
| FR-F01 | Modes: **Draft** (from NL), **Edit** (natural-language edit of the current IDS), **Explain**, **Review** (critique with lint + model), **Repair** (fix diagnostics), **Infer** (from model/selection), **Translate** | M | β (Draft/Edit/Explain/Repair) GA (rest) | J1,J14 | P-07 |
| FR-F02 | Output is a **proposal**: an op batch grouped per spec, with sources, live counts, diagnostics; user accepts/rejects per spec or per op | M | β | J1 | P-07 |
| FR-F03 | Agent uses only tools for facts (schema, bSDD, model, audit, lint, dry-run); every op passes the gate; failures are fed back for self-correction within a task budget | M | β | J14 | P-07 |
| FR-F04 | Clarification via structured choices (each a ready op batch with counts) only when tools return several materially different candidates | M | β | J14 | P-07 |
| FR-F05 | Document ingestion: PDF, DOCX, XLSX/CSV, Markdown/TXT; long documents chunked by structure | M | GA | J1 | P-09 |
| FR-F06 | **Traceability**: every proposed spec/facet links to its source span (page/paragraph/cell); every source statement is covered or listed as **unresolved** with a category (not-IDS-expressible / ambiguous / out-of-scope / needs rules engine / manual) | M | GA | J1 | P-09 |
| FR-F07 | Spreadsheet import: LLM proposes a column→field mapping (with preview); deterministic converter applies it to all rows; mapping saved and reusable without AI | M | GA | J1 | P-09 |
| FR-F08 | Privacy: model data sent to LLM is limited to counts, distinct values (capped), schema/bSDD snippets and the IDS; user can inspect the exact payload ("what was sent") | M | β | — | P-07 |
| FR-F09 | Providers: BYOK (Anthropic/OpenAI) and hosted proxy; per-model eval gate decides availability per mode | M | β | — | P-07,P-08 |
| FR-F10 | Public benchmark: report scores on Ishigaki-IDS-Bench (if licence permits) and our own gold set, per release | S | GA | — | P-08 |

## G. Interop, versioning, collaboration, trust

| ID | Requirement | Pri | Rel | Jobs | Pitch |
|---|---|---|---|---|---|
| FR-G01 | Export readable document: HTML/PDF/DOCX "contract appendix" with plain-language specs, tables, translations, revision info | M | GA | J7,J9 | P-09 |
| FR-G02 | Excel export/import round-trip lossless (hidden ID columns) | M | GA | J1 | P-09 |
| FR-G03 | YAML/JSON import/export (human-editable format, compatible with the ids-light-editor style) | S | GA | J12 | P-09 |
| FR-G04 | Semantic diff between two IDS (matched by ID → identifier → name → similarity): added/removed/changed specs and facets, plain-language changelog | M | GA | J9 | P-10 |
| FR-G05 | Three-way merge with conflict UI | S | GA | J9,J11 | P-10 |
| FR-G06 | Revisions with sign-off (who/when/hash), release labels, diff between revisions | M | GA | J9 | P-10 |
| FR-G07 | Comments threaded per node; resolve; mention | S | GA | J11 | P-10 |
| FR-G08 | Live co-authoring (Yjs) with presence | C | GA | J11 | P-10 |
| FR-G09 | **IDS test suites**: per spec, generated pass/fail IFC fixtures (synthetic), user-added fixtures (real models or element snapshots), expected outcomes; run in UI and CLI | M | GA | J6 | P-10 |
| FR-G10 | Fingerprint: optional XML comment with tool, revision hash and sidecar link | C | GA | — | P-10 |

## H. Headless & distribution

| ID | Requirement | Pri | Rel | Jobs | Pitch |
|---|---|---|---|---|---|
| FR-H01 | CLI: `ids audit`, `ids lint`, `ids fmt`, `ids diff`, `ids convert`, `ids explain`, `ids coverage`, `ids test`, `ids draft`, `ids infer`, JSON output for all | M | GA | J12 | P-11 |
| FR-H02 | MCP: `ids_audit`, `ids_lint`, `ids_read`, `ids_apply_ops`, `ids_write`, `ids_explain`, `ids_preview`, `ids_infer`, `ids_coverage`, `ids_diff`, `ids_test` (+ existing `ids_validate`, `bsdd_*`) | M | GA | J12 | P-11 |
| FR-H03 | SDK `bim.ids.authoring` namespace mirroring ops | S | GA | J12 | P-11 |
| FR-H04 | Embeddable Studio via viewer-embed/embed-sdk with postMessage API (load/save IDS, events) | S | GA | J12 | P-11 |
| FR-H05 | IDS 1.1 preview features behind a flag; never emitted in 1.0 output | C | L | — | P-12 |
| FR-H06 | Public conformance dashboard (ifc-lite vs other engines on the corpus) | C | L | — | P-12 |

## Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-01 | Performance: op apply + gate + audit + lint for a 200-spec doc | p95 ≤ 50 ms (main thread budget), heavy lint in worker |
| NFR-02 | Live preview latency | p95 ≤ 300 ms for 100k elements; progressive for 1M |
| NFR-03 | Memory | Studio state ≤ 20 MB for a 500-spec doc |
| NFR-04 | Privacy | No model bytes, pset/property names or free text in analytics (existing scrub); LLM payload inspectable |
| NFR-05 | Accessibility | WCAG 2.2 AA: keyboard-only flows, screen-reader labels on outline/grid, no jsx-a11y warning increase |
| NFR-06 | i18n | All Studio strings in catalogues; en/de/fr/it at GA |
| NFR-07 | Reliability | No data loss: autosave to IndexedDB every op; crash recovery |
| NFR-08 | Security | Prompt-injection safe: model/document strings are data; no tool can exfiltrate beyond the declared payload; regex ReDoS guard (existing) on all user patterns |
| NFR-09 | Code quality | House rules; ≤400-line modules; strict TS; changesets; API surface snapshots |
| NFR-10 | Offline | Everything except AI and bSDD works offline; bSDD cached |
| NFR-11 | AI cost | Median Draft run ≤ $0.50 at list price for a 20-spec document (prompt caching on); Edit ≤ $0.05; measured per release |
| NFR-12 | AI latency | First proposal tokens ≤ 3 s; 20-spec Draft ≤ 60 s p50 |
