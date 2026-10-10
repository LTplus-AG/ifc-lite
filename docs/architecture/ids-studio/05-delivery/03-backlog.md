# Backlog: issue-ready items

Each row is sized to be **one backlog scope → one PR** (or a stack if it is L). The recorded D8 campaign exemption uses backlog IDs in PR bodies instead of GitHub issues; other AGENTS.md guardrails remain:
- one defect class per PR;
- ≤ ~1,500 changed lines per PR, otherwise stack;
- record the approved backlog scope in the PR body; only the maintainer applies the repository's escape label when needed;
- user-visible claims need evidence (a real model, an oracle run or a screenshot).

**Size:** S < 300 changed lines · M 300–800 · L 800–1,500 (stack beyond).
**Evidence:** what the PR must show. **Dep:** blocking items.
Issue text must stay vendor-neutral (ADR-014).

## P-01 — Engine completeness (Cycle 1)
| ID | Title | Pkg | Size | Dep | Acceptance / evidence |
|---|---|---|---|---|---|
| IDS-001 | Writer: emit `length`/`minLength`/`maxLength` restrictions | ids/rules | S | – | Oracle round-trip on corpus cases using them; unit tests per facet |
| IDS-002 | Writer: emit `totalDigits`/`fractionDigits` and conjunctive (`and[]`) restrictions | ids/rules | M | 001 | `unwritable()` removed for these; property test parse∘write = id on generated constraints |
| IDS-003 | Move `writeIdsXml` into `@ifc-lite/ids/writer`; `rules` imports it; delete old location | ids, rules | M | 002 | Changesets, `api-surface:update`, repo-wide grep clean, docs updated |
| IDS-004 | Charter: classify the 21 `AUDIT_UNDETECTED` invalid cases into defect families | ids | S | – | Issue body lists families → IDS-005…008 scopes |
| IDS-005 | Audit family 1 (XSD-structural) detection | ids | M | 004 | Cases removed from `AUDIT_UNDETECTED` |
| IDS-006 | Audit family 2 (restriction base / dataType compatibility) | ids | M | 004 | same |
| IDS-007 | Audit family 3 (cardinality / occurs placement) | ids | M | 004 | same |
| IDS-008 | Audit family 4 (remaining) → `AUDIT_UNDETECTED` empty | ids | M | 004 | List empty; test asserts length 0 |
| IDS-009 | Qto tables for IFC2X3 and IFC4 in `@ifc-lite/data` generator | data | M | – | Regenerated/qualified IFC2X3 and IFC4 tables with counts; per-version controls accept known valid Qto names and reject nonexistent reserved Qto names. Closes current unverified acceptance when quantity tables are absent (ADR-003); no custom override |
| IDS-010 | Audit inspects conjunctive siblings (`and[]`), not only the primary family | ids | S | – | Fixtures with a bad sibling regex/bound |
| IDS-011 | Italian (`it`) locale for IDS translations | ids | S | – | Catalogue complete; snapshot tests |
| IDS-012 | Canonical formatting options in writer (`fmt`) + golden files | ids | S | 003 | Golden tests; idempotence test |
| IDS-013 | CI oracle job: official audit tool (NuGet CLI) on exported docs; diff verdicts | ci | M | 003 | Workflow + triage doc for disagreements |
| IDS-014 | Property-based round-trip test (random IDSDocument generator) | ids | S | 002 | 10k cases pass in CI time budget |

## P-02 — Authoring core (Cycle 1)
| ID | Title | Pkg | Size | Dep | Acceptance / evidence |
|---|---|---|---|---|---|
| IDS-015 | Scaffold `@ifc-lite/ids-authoring` (README, MPL headers, changeset, api-surface) | ids-authoring | S | – | CI green, README check passes |
| IDS-016 | `StudioDocument` + `NodeIndex` (UUIDv7) + import from `IDSDocument` | ids-authoring | M | 015 | Invariant tests (one Uuid per node) |
| IDS-017 | Op schema v1 (shared JSON Schema): document + spec ops | ids-authoring | M | 016 | JSON Schema generation test |
| IDS-018 | Facet + value ops; `ConstraintDraft` → `IDSConstraint` normalisation (units → SI) | ids-authoring | L | 017 | Table tests per draft kind |
| IDS-019 | Reducer with exact inverses + property tests (apply∘inverse = id) | ids-authoring | M | 018 | fast-check 10k sequences |
| IDS-020 | Compound ops (`bulk.*`) expansion | ids-authoring | M | 019 | Each compound op undone in one step |
| IDS-021 | Gate: entity, predefined type, attribute (per version, inherited) | ids-authoring | M | 019 | Tests per version; candidate ranking test |
| IDS-022 | Gate: pset/property/enum/dataType (per version; pset kinds) | ids-authoring | M | 021, 009 | Tests incl. Qto; IFC2X3 specifics |
| IDS-023 | Gate: custom declarations, reserved prefixes, structural rules, value well-formedness (XSD regex + ReDoS guard) | ids-authoring | M | 021 | Tests |
| IDS-024 | History + transactions + persistence adapter interface (IndexedDB impl in viewer) | ids-authoring | M | 019 | Undo across reload test |
| IDS-025 | Sidecar (`studio.json`) + `.idsz` bundle read/write | ids-authoring | M | 016 | Round-trip; XML byte-identical with/without sidecar |
| IDS-026 | Re-identification matcher (identifier → signature → similarity) | ids-authoring | M | 016 | Matching accuracy on corpus mutations ≥ 98% |
| IDS-027 | Plain-language renderer per facet × section × cardinality (en/de/fr/it) | ids | M | 011 | Snapshot tests; reviewed by native speakers |

## P-03 — Studio UI v1 (Cycle 2)
| ID | Title | Pkg | Size | Dep | Acceptance / evidence |
|---|---|---|---|---|---|
| IDS-030 | Register `idsStudio` panel, store slice, teardown, i18n catalogue, layout preset | viewer | M | 016 | Registration tests; screenshot |
| IDS-031 | Outline (virtualised tree, badges, count slots, keyboard nav) | viewer | M | 030 | a11y check; screenshot |
| IDS-032 | Inspector: document info + spec fields + cardinality with explanations | viewer | M | 030 | Screenshot; ops dispatched |
| IDS-033 | Inspector: facet editors; entity/PDT/attribute pickers (hierarchy, abstract flagged) | viewer | L | 032, 021 | Screenshot with real schema |
| IDS-034 | Pset/property/dataType pickers filtered by `applicableEntities` (+ show all) | viewer | M | 033, 022 | Screenshot |
| IDS-035 | Value editor for every `ConstraintDraft` kind; enumeration chips/bulk-paste; live match examples | viewer | L | 018 | Screenshot; tests |
| IDS-036 | Diagnostics panel, inline markers, click-to-focus, quick-fix buttons with preview | viewer | M | 046 | Screenshot |
| IDS-037 | XML preview tab (CodeMirror read-only, selection-synced) | viewer | S | 003 | Screenshot |
| IDS-038 | Grid mode (react-virtual): bulk paste through gate, fill-down, find/replace, filters | viewer | L | 033 | 5k-row perf evidence |
| IDS-039 | Library v2 (IndexedDB, revisions list), migrate + delete localStorage definition library | viewer | M | 024 | Migration test with real stored entries |
| IDS-040 | Import/export: IDS 1.0, 0.9.7 upgrade report, `.idsz`; drag-and-drop | viewer | M | 025 | Corpus import evidence |
| IDS-041 | Template gallery + first 25 self-authored templates (re-authored ideas from ids-flow) | ids-authoring, viewer | M | 020 | Each template audit+lint clean |
| IDS-042 | Command palette: every op; keyboard model (§7 UX) | viewer | S | 030 | Tests |
| IDS-043 | Supersede `check-authoring` IDS editor/review with Studio; delete old components | viewer | M | 035 | knip clean; tour updated |
| IDS-044 | Studio guided tour (tour anchors per AGENTS.md) | viewer | S | 043 | Tour test |
| IDS-045 | Unit-aware numeric input (reuse `ids-constraint.ts` conversions) | viewer | S | 035 | Tests |

## P-04 — Lint (Cycle 2)
| ID | Title | Pkg | Size | Dep | Acceptance / evidence |
|---|---|---|---|---|---|
| IDS-046 | Lint engine: registry, incremental scopes, Diagnostic, suppressions, quick-fix contract | ids-authoring | M | 019 | Engine tests |
| IDS-047 | Rules ENT/PDT/ATT (8) | ids-authoring | M | 046 | ≥2 pos/neg fixtures each; ENT-001 semantics verified on corpus (A-03) |
| IDS-048 | Rules PSET/PROP static (6) | ids-authoring | M | 046 | same |
| IDS-049 | Rules VAL/UNIT static (8) | ids-authoring | M | 046 | same; VAL-005 lexical forms verified (A-04) |
| IDS-050 | Rules REGEX (4 static) + XSD regex explainer | ids-authoring | M | 046 | same |
| IDS-051 | Rules CARD/SPEC static incl. constraint-intersection solver (contradiction/tautology) | ids-authoring | L | 046 | same; solver unit tests |
| IDS-052 | Rules DOC/VER/PART | ids-authoring | S | 046 | same |
| IDS-053 | Per-rule docs generator (`docs/guide/ids-lint/*`) | docs | S | 047 | docs CI |
| IDS-054 | Lint corpus + precision script (target ≥95%) | scripts | M | 052 | Report in PR |

## P-05 — Model loop (Cycle 3)
| ID | Title | Pkg | Size | Dep | Acceptance / evidence |
|---|---|---|---|---|---|
| IDS-055 | Worker protocol extension + model-set hashing + generation cancellation | viewer | M | – | Tests |
| IDS-056 | Funnel computation with stage cache, progressive results | ids-model-loop | L | 055 | Benchmark on real models (100k, 1M) |
| IDS-057 | Requirement preview + parity test vs validator on corpus | ids-model-loop | M | 056 | Parity 100% |
| IDS-058 | Funnel UI + stage click → isolate/ghost/colour (federation-aware) | viewer | M | 056 | Screen recording on a real federated model |
| IDS-059 | Explain tracer (optional param in facet evaluators) + parity | ids | M | – | Zero-overhead benchmark; parity 100% |
| IDS-060 | Explain UI with near-miss reasons | viewer | M | 059 | Screenshot on real model |
| IDS-061 | Distinct values API + picker integration ("from model") | ids-model-loop, viewer | S | 055 | Screenshot |
| IDS-062 | Infer: applicability + contrast learning | ids-model-loop | L | 061 | Accuracy on labelled selections ≥ 90% |
| IDS-063 | Infer: requirement candidates + pattern synthesiser | ids-model-loop | L | 062 | Tests |
| IDS-064 | Infer UI ("Require what these have") | viewer | M | 063 | Recording on real model |
| IDS-065 | Coverage lens (packages/lens) + ungoverned table | viewer, lens | M | 056 | Screenshot |
| IDS-066 | Model-aware lint rules (VAL-007, SPEC-004/010, REGEX-005, PROP-004, UNIT-002, VER-002) | ids-authoring | M | 056, 046 | Fixtures with real model |
| IDS-067 | Fix-in-place via mutations; supersede `IDSCorrectionDialog` | viewer | M | 060 | Corrected IFC re-validates green |
| IDS-068 | Performance benchmarks recorded in `tests/benchmark` (perf docs region) | bench | S | 056 | Baseline committed |

## P-06 — bSDD (Cycle 3)
| ID | Title | Pkg | Size | Dep | Acceptance / evidence |
|---|---|---|---|---|---|
| IDS-069 | bSDD tab in pickers: search, filters, cards | viewer | M | 033 | Screenshot |
| IDS-070 | Insert class → classification and/or entity facets | ids-authoring, viewer | S | 069 | Tests |
| IDS-071 | bSDD property → requirement mapping table + tests | ids-authoring | M | 070 | Per-dataType tests |
| IDS-072 | Dictionary → IDS generator (inheritance, scope options, preview) | ids-authoring, viewer | L | 071 | Run on a real public dictionary; audit+lint clean |
| IDS-073 | URI health lints BSDD-001..003 with cached checks | ids-authoring | S | 046 | Tests with recorded responses |
| IDS-074 | bSDD IndexedDB cache; offline behaviour | viewer | S | 069 | Offline test |

## P-07 — AI agent (Cycle 3 → 5)
| ID | Title | Pkg | Size | Dep | Acceptance / evidence |
|---|---|---|---|---|---|
| IDS-075 | Scaffold `@ifc-lite/ids-agent`; tool-calling adapter on `packages/ai` (Anthropic first, OpenAI second) | ids-agent, ai | M | 017 | Recorded tool-call round-trip tests |
| IDS-076 | Tool registry uses canonical runtime JSON Schemas; schema read tools | ids-agent | M | 075 | Tests |
| IDS-077 | Act tools: `apply_ops` on sandbox fork, `lint`, `apply_fix`, `mark_unresolved`, `undo` | ids-agent | M | 076, 046 | Tests |
| IDS-078 | Model tools via worker bridge (stats, count, distinct, infer, coverage) | ids-agent, viewer | M | 077, 056 | Tests |
| IDS-079 | bSDD tools | ids-agent | S | 076 | Recorded responses |
| IDS-080 | Loop runner: budgets, no-progress detection, streaming, receipts, cancel | ids-agent | M | 077 | Tests incl. budget exhaustion |
| IDS-081 | `ask_user` structured choices + UI | ids-agent, viewer | S | 080 | Screenshot |
| IDS-082 | Proposal model + review UI (accept per spec/op, sources, previews) | viewer | L | 080 | Recording |
| IDS-083 | Modes Draft/Edit/Explain/Repair + system prompt v1 (versioned file) | ids-agent | M | 080 | Eval report (P-08) attached |
| IDS-084 | Modes Review/Infer/Translate | ids-agent | M | 083 | Eval report |
| IDS-085 | Assistant integration; supersede JSON `ids-proposal` path and delete | viewer | M | 082 | knip clean; recordings updated |
| IDS-086 | Privacy view: "what was sent" per run | viewer | S | 080 | Screenshot |

## P-08 — Evaluation (Cycle 1 → ongoing)
| ID | Title | Pkg | Size | Dep | Acceptance / evidence |
|---|---|---|---|---|---|
| IDS-087 | E2: generate NL descriptions for corpus specs; human review pass | scripts | M | – | Dataset committed (licence-compatible: descriptions are ours, corpus files referenced, not modified) |
| IDS-088 | Charter: E3 gold set (≥100 cases, 4 languages) | eval | L | – | Dataset + README |
| IDS-089 | E4 edit tasks + E5 adversarial set | eval | M | – | Dataset |
| IDS-090 | Eval runner: CI recorded replay + nightly live (Batch API) + `scores.json` | scripts | M | 083 | First scored run |
| IDS-091 | Ishigaki-IDS-Bench adapter (pending D4) | scripts | S | 090 | Comparable metric implementation |
| IDS-092 | Public benchmark page (generated) | docs/landing | S | 090 | Page live |

## P-09 — Ingestion & documents (Cycle 4)
| ID | Title | Pkg | Size | Dep | Acceptance / evidence |
|---|---|---|---|---|---|
| IDS-093 | DOCX → structured text with span IDs | ids-agent | M | – | Real EIR-style docs (internal) |
| IDS-094 | PDF ingestion with citations → source spans; outline chunking for long docs | ids-agent | M | 083 | 200-page test doc |
| IDS-095 | XLSX/CSV parser (multi-sheet, merged cells, header detection) | ids-interop | M | – | Fixture sheets |
| IDS-096 | Mapping proposal (LLM) + mapping UI + deterministic converter + saved mappings | ids-interop, viewer | L | 095, 080 | 400-row sheet converts deterministically |
| IDS-097 | Built-in mappings for common open templates (licence-checked, D5) | ids-interop | S | 096 | Tests |
| IDS-098 | Traceability UI, unresolved list, statement coverage metric | viewer | M | 094 | Recording |
| IDS-099 | Readable appendix renderer (HTML → PDF); decide PDF path | ids-interop | M | 027 | Sample appendix |
| IDS-100 | DOCX appendix export | ids-interop | M | 099 | Opens in common word processors |
| IDS-101 | Excel export (Studio layout, hidden IDs) + lossless round-trip | ids-interop | M | 095 | Round-trip test |
| IDS-102 | YAML/JSON human format (schema published) | ids-interop | S | 016 | Round-trip test |
| IDS-103 | Translations in sidecar + multi-language exports | ids-interop | S | 084 | Sample |

## P-10 — Trust & teamwork (Cycles 4–5)
| ID | Title | Pkg | Size | Dep | Acceptance / evidence |
|---|---|---|---|---|---|
| IDS-104 | Semantic diff engine + plain-language changelog | ids-authoring | M | 026 | Tests on corpus mutations |
| IDS-105 | Diff UI (side-by-side outline) | viewer | M | 104 | Screenshot |
| IDS-106 | Three-way merge + conflict UI | ids-authoring, viewer | L | 104 | Tests |
| IDS-107 | Revisions + sign-off + hash chain | ids-authoring, viewer | M | 039 | Tamper test |
| IDS-108 | Comments (sidecar, threads, resolve) | viewer | M | 025 | Screenshot |
| IDS-109 | Yjs co-authoring binding via `@ifc-lite/collab` (gate on remote ops) | ids-authoring, viewer | L | 024 | Two-browser recording |
| IDS-110 | Test-suite model + runner (UI + headless) | ids-authoring | M | 025 | Tests |
| IDS-111 | Synthetic fixture generator (IFC4) via `@ifc-lite/create` | ids-testgen | L | 110, 114 | Generated fixtures validate as expected on 100% of corpus specs that are generable |
| IDS-112 | IFC2X3/IFC4X3 fixture support | ids-testgen, create | L | 111 | Same for those versions |
| IDS-113 | Snapshot fixtures ("pin element as test") | ids-testgen, viewer | M | 110 | Real-model evidence |
| IDS-114 | XSD-pattern string generator (matching / non-matching examples) | ids | M | – | Property tests vs translator |

## P-11 — Headless everywhere (incremental; Cycles 4–6)
| ID | Title | Pkg | Size | Dep | Acceptance / evidence |
|---|---|---|---|---|---|
| IDS-115 | CLI `ids audit\|lint\|fmt` | cli | M | 046, 012 | Docs table regenerated |
| IDS-116 | CLI `ids diff\|convert\|explain\|preview\|coverage` | cli | M | 104, 096, 056 | Same |
| IDS-117 | CLI `ids test\|infer\|draft\|edit\|bsdd` | cli | M | 110, 062, 083, 072 | Same |
| IDS-118 | MCP batch 1: `ids_audit`, `ids_lint`, `ids_read`, `ids_apply_ops`, `ids_write`, `ids_schema_*` | mcp | M | 046 | MCP docs |
| IDS-119 | MCP batch 2: `ids_preview`, `ids_infer`, `ids_coverage`, `ids_diff`, `ids_test` | mcp | M | 118 | Same |
| IDS-120 | SDK `bim.ids.authoring` | sdk | M | 019 | Typechecked doc snippets |
| IDS-121 | Embeddable Studio mode (embed-protocol messages) | viewer-embed, embed-sdk | M | 043 | Demo page |
| IDS-122 | Flow nodes (Load IDS, Lint, Validate, BCF) | flow-nodes | S | 118 | Example flow |
| IDS-123 | Docs: studio, authoring, agent, test suites; update ids/cli/mcp/viewer-assistant guides | docs | M | rolling | docs CI |

## P-12 — Standards leadership (Cycle 6+)
| ID | Title | Pkg | Size | Dep | Acceptance / evidence |
|---|---|---|---|---|---|
| IDS-124 | IDS 1.1 preview flag + candidate-feature modelling (extended partOf, translations, identifiers, tolerance) | ids, ids-authoring | L | – | Behind flag; 1.0 export unaffected |
| IDS-125 | Conformance dashboard: our engine vs other open engines on the corpus (+ official audit) | scripts, landing | M | 013 | Public page |
| IDS-126 | Upstream contributions: ambiguity notes and lint catalogue references on standard issues | — | S | 054 | Links |

**Total: 124 items** (IDS-001…IDS-126, with IDS-028/029 reserved for spill-over).
