# IDS Studio campaign — STATUS

Single source of truth for progress. Update it in the campaign PR (`claude/stoic-cannon-6hceqo`) whenever a pitch PR changes state. Legend: ⬜ todo · 🟨 in progress · 🟦 in review (PR ready) · ✅ merged · ⏸ blocked.

_Last updated: 2026-10-08 (session 1)._

## Pitches

Umbrella PR: #7143 (this tracker).

| Pitch | Branch | PR | State | Notes |
|---|---|---|---|---|
| P-01 Engine completeness | `claude/ids-studio-p01-engine` | (opens when first code is pushed) | 🟨 | Implementation running (session 1) |
| P-02 Authoring core | `claude/ids-studio-p02-authoring-core` | (opens when first code is pushed) | 🟨 | Implementation running (session 1) |
| P-03 Studio UI v1 | `claude/ids-studio-p03-studio-ui` | #7145 | ⬜ | Draft PR open (charter + work log); not started |
| P-04 Lint | `claude/ids-studio-p04-lint` | #7144 | ⬜ | Draft PR open (charter + work log); not started |
| P-05 Model loop | `claude/ids-studio-p05-model-loop` | #7146 | ⬜ | Draft PR open (charter + work log); not started |
| P-06 bSDD | `claude/ids-studio-p06-bsdd` | #7147 | ⬜ | Draft PR open (charter + work log); not started |
| P-07 Agent | `claude/ids-studio-p07-agent` | #7148 | ⬜ | Draft PR open (charter + work log); not started |
| P-08 Eval | `claude/ids-studio-p08-eval` | #7149 | ⬜ | Draft PR open (charter + work log); not started |
| P-09 Ingestion & documents | `claude/ids-studio-p09-ingestion` | #7150 | ⬜ | Draft PR open (charter + work log); not started |
| P-10 Trust & teamwork | `claude/ids-studio-p10-trust` | #7151 | ⬜ | Draft PR open (charter + work log); not started |
| P-11 Headless | `claude/ids-studio-p11-headless` | #7152 | ⬜ | Draft PR open (charter + work log); not started |
| P-12 Standards leadership | `claude/ids-studio-p12-standards` | #7153 | ⬜ | Draft PR open (charter + work log); not started |

## Backlog items


### P-01 — Engine completeness

| ID | Title | State | PR / commit |
|---|---|---|---|
| IDS-001 | Writer: emit `length`/`minLength`/`maxLength` restrictions | ⬜ | |
| IDS-002 | Writer: emit `totalDigits`/`fractionDigits` and conjunctive (`and[]`) restrictions | ⬜ | |
| IDS-003 | Move `writeIdsXml` into `@ifc-lite/ids/writer`; `rules` imports it; delete old location | ⬜ | |
| IDS-004 | Charter: classify the 21 `AUDIT_UNDETECTED` invalid cases into defect families | ⬜ | |
| IDS-005 | Audit family 1 (XSD-structural) detection | ⬜ | |
| IDS-006 | Audit family 2 (restriction base / dataType compatibility) | ⬜ | |
| IDS-007 | Audit family 3 (cardinality / occurs placement) | ⬜ | |
| IDS-008 | Audit family 4 (remaining) → `AUDIT_UNDETECTED` empty | ⬜ | |
| IDS-009 | Qto tables for IFC2X3 and IFC4 in `@ifc-lite/data` generator | ⬜ | |
| IDS-010 | Audit inspects conjunctive siblings (`and[]`), not only the primary family | ⬜ | |
| IDS-011 | Italian (`it`) locale for IDS translations | ⬜ | |
| IDS-012 | Canonical formatting options in writer (`fmt`) + golden files | ⬜ | |
| IDS-013 | CI oracle job: official audit tool (NuGet CLI) on exported docs; diff verdicts | ⬜ | |
| IDS-014 | Property-based round-trip test (random IDSDocument generator) | ⬜ | |

### P-02 — Authoring core

| ID | Title | State | PR / commit |
|---|---|---|---|
| IDS-015 | Scaffold `@ifc-lite/ids-authoring` (README, MPL headers, changeset, api-surface) | ⬜ | |
| IDS-016 | `StudioDocument` + `NodeIndex` (UUIDv7) + import from `IDSDocument` | ⬜ | |
| IDS-017 | Op schema v1 (zod): document + spec ops | ⬜ | |
| IDS-018 | Facet + value ops; `ConstraintDraft` → `IDSConstraint` normalisation (units → SI) | ⬜ | |
| IDS-019 | Reducer with exact inverses + property tests (apply∘inverse = id) | ⬜ | |
| IDS-020 | Compound ops (`bulk.*`) expansion | ⬜ | |
| IDS-021 | Gate: entity, predefined type, attribute (per version, inherited) | ⬜ | |
| IDS-022 | Gate: pset/property/enum/dataType (per version; pset kinds) | ⬜ | |
| IDS-023 | Gate: custom declarations, reserved prefixes, structural rules, value well-formedness (XSD regex + ReDoS guard) | ⬜ | |
| IDS-024 | History + transactions + persistence adapter interface (IndexedDB impl in viewer) | ⬜ | |
| IDS-025 | Sidecar (`studio.json`) + `.idsz` bundle read/write | ⬜ | |
| IDS-026 | Re-identification matcher (identifier → signature → similarity) | ⬜ | |
| IDS-027 | Plain-language renderer per facet × section × cardinality (en/de/fr/it) | ⬜ | |

### P-03 — Studio UI v1

| ID | Title | State | PR / commit |
|---|---|---|---|
| IDS-030 | Register `idsStudio` panel, store slice, teardown, i18n catalogue, layout preset | ⬜ | |
| IDS-031 | Outline (virtualised tree, badges, count slots, keyboard nav) | ⬜ | |
| IDS-032 | Inspector: document info + spec fields + cardinality with explanations | ⬜ | |
| IDS-033 | Inspector: facet editors; entity/PDT/attribute pickers (hierarchy, abstract flagged) | ⬜ | |
| IDS-034 | Pset/property/dataType pickers filtered by `applicableEntities` (+ show all) | ⬜ | |
| IDS-035 | Value editor for every `ConstraintDraft` kind; enumeration chips/bulk-paste; live match examples | ⬜ | |
| IDS-036 | Diagnostics panel, inline markers, click-to-focus, quick-fix buttons with preview | ⬜ | |
| IDS-037 | XML preview tab (CodeMirror read-only, selection-synced) | ⬜ | |
| IDS-038 | Grid mode (react-virtual): bulk paste through gate, fill-down, find/replace, filters | ⬜ | |
| IDS-039 | Library v2 (IndexedDB, revisions list), migrate + delete localStorage definition library | ⬜ | |
| IDS-040 | Import/export: IDS 1.0, 0.9.7 upgrade report, `.idsz`; drag-and-drop | ⬜ | |
| IDS-041 | Template gallery + first 25 self-authored templates (re-authored ideas from ids-flow) | ⬜ | |
| IDS-042 | Command palette: every op; keyboard model (§7 UX) | ⬜ | |
| IDS-043 | Supersede `check-authoring` IDS editor/review with Studio; delete old components | ⬜ | |
| IDS-044 | Studio guided tour (tour anchors per AGENTS.md) | ⬜ | |
| IDS-045 | Unit-aware numeric input (reuse `ids-constraint.ts` conversions) | ⬜ | |

### P-04 — Lint

| ID | Title | State | PR / commit |
|---|---|---|---|
| IDS-046 | Lint engine: registry, incremental scopes, Diagnostic, suppressions, quick-fix contract | ⬜ | |
| IDS-047 | Rules ENT/PDT/ATT (8) | ⬜ | |
| IDS-048 | Rules PSET/PROP static (6) | ⬜ | |
| IDS-049 | Rules VAL/UNIT static (8) | ⬜ | |
| IDS-050 | Rules REGEX (4 static) + XSD regex explainer | ⬜ | |
| IDS-051 | Rules CARD/SPEC static incl. constraint-intersection solver (contradiction/tautology) | ⬜ | |
| IDS-052 | Rules DOC/VER/PART | ⬜ | |
| IDS-053 | Per-rule docs generator (`docs/guide/ids-lint/*`) | ⬜ | |
| IDS-054 | Lint corpus + precision script (target ≥95%) | ⬜ | |

### P-05 — Model loop

| ID | Title | State | PR / commit |
|---|---|---|---|
| IDS-055 | Worker protocol extension + model-set hashing + generation cancellation | ⬜ | |
| IDS-056 | Funnel computation with stage cache, progressive results | ⬜ | |
| IDS-057 | Requirement preview + parity test vs validator on corpus | ⬜ | |
| IDS-058 | Funnel UI + stage click → isolate/ghost/colour (federation-aware) | ⬜ | |
| IDS-059 | Explain tracer (optional param in facet evaluators) + parity | ⬜ | |
| IDS-060 | Explain UI with near-miss reasons | ⬜ | |
| IDS-061 | Distinct values API + picker integration ("from model") | ⬜ | |
| IDS-062 | Infer: applicability + contrast learning | ⬜ | |
| IDS-063 | Infer: requirement candidates + pattern synthesiser | ⬜ | |
| IDS-064 | Infer UI ("Require what these have") | ⬜ | |
| IDS-065 | Coverage lens (packages/lens) + ungoverned table | ⬜ | |
| IDS-066 | Model-aware lint rules (VAL-007, SPEC-004/010, REGEX-005, PROP-004, UNIT-002, VER-002) | ⬜ | |
| IDS-067 | Fix-in-place via mutations; supersede `IDSCorrectionDialog` | ⬜ | |
| IDS-068 | Performance benchmarks recorded in `tests/benchmark` (perf docs region) | ⬜ | |

### P-06 — bSDD

| ID | Title | State | PR / commit |
|---|---|---|---|
| IDS-069 | bSDD tab in pickers: search, filters, cards | ⬜ | |
| IDS-070 | Insert class → classification and/or entity facets | ⬜ | |
| IDS-071 | bSDD property → requirement mapping table + tests | ⬜ | |
| IDS-072 | Dictionary → IDS generator (inheritance, scope options, preview) | ⬜ | |
| IDS-073 | URI health lints BSDD-001..003 with cached checks | ⬜ | |
| IDS-074 | bSDD IndexedDB cache; offline behaviour | ⬜ | |

### P-07 — AI agent

| ID | Title | State | PR / commit |
|---|---|---|---|
| IDS-075 | Scaffold `@ifc-lite/ids-agent`; tool-calling adapter on `packages/ai` (Anthropic first, OpenAI second) | ⬜ | |
| IDS-076 | Tool registry generated from zod; schema read tools | ⬜ | |
| IDS-077 | Act tools: `apply_ops` on sandbox fork, `lint`, `apply_fix`, `mark_unresolved`, `undo` | ⬜ | |
| IDS-078 | Model tools via worker bridge (stats, count, distinct, infer, coverage) | ⬜ | |
| IDS-079 | bSDD tools | ⬜ | |
| IDS-080 | Loop runner: budgets, no-progress detection, streaming, receipts, cancel | ⬜ | |
| IDS-081 | `ask_user` structured choices + UI | ⬜ | |
| IDS-082 | Proposal model + review UI (accept per spec/op, sources, previews) | ⬜ | |
| IDS-083 | Modes Draft/Edit/Explain/Repair + system prompt v1 (versioned file) | ⬜ | |
| IDS-084 | Modes Review/Infer/Translate | ⬜ | |
| IDS-085 | Assistant integration; supersede JSON `ids-proposal` path and delete | ⬜ | |
| IDS-086 | Privacy view: "what was sent" per run | ⬜ | |

### P-08 — Evaluation

| ID | Title | State | PR / commit |
|---|---|---|---|
| IDS-087 | E2: generate NL descriptions for corpus specs; human review pass | ⬜ | |
| IDS-088 | Charter: E3 gold set (≥100 cases, 4 languages) | ⬜ | |
| IDS-089 | E4 edit tasks + E5 adversarial set | ⬜ | |
| IDS-090 | Eval runner: CI recorded replay + nightly live (Batch API) + `scores.json` | ⬜ | |
| IDS-091 | Ishigaki-IDS-Bench adapter (pending D4) | ⬜ | |
| IDS-092 | Public benchmark page (generated) | ⬜ | |

### P-09 — Ingestion & documents

| ID | Title | State | PR / commit |
|---|---|---|---|
| IDS-093 | DOCX → structured text with span IDs | ⬜ | |
| IDS-094 | PDF ingestion with citations → source spans; outline chunking for long docs | ⬜ | |
| IDS-095 | XLSX/CSV parser (multi-sheet, merged cells, header detection) | ⬜ | |
| IDS-096 | Mapping proposal (LLM) + mapping UI + deterministic converter + saved mappings | ⬜ | |
| IDS-097 | Built-in mappings for common open templates (licence-checked, D5) | ⬜ | |
| IDS-098 | Traceability UI, unresolved list, statement coverage metric | ⬜ | |
| IDS-099 | Readable appendix renderer (HTML → PDF); decide PDF path | ⬜ | |
| IDS-100 | DOCX appendix export | ⬜ | |
| IDS-101 | Excel export (Studio layout, hidden IDs) + lossless round-trip | ⬜ | |
| IDS-102 | YAML/JSON human format (schema published) | ⬜ | |
| IDS-103 | Translations in sidecar + multi-language exports | ⬜ | |

### P-10 — Trust & teamwork

| ID | Title | State | PR / commit |
|---|---|---|---|
| IDS-104 | Semantic diff engine + plain-language changelog | ⬜ | |
| IDS-105 | Diff UI (side-by-side outline) | ⬜ | |
| IDS-106 | Three-way merge + conflict UI | ⬜ | |
| IDS-107 | Revisions + sign-off + hash chain | ⬜ | |
| IDS-108 | Comments (sidecar, threads, resolve) | ⬜ | |
| IDS-109 | Yjs co-authoring binding via `@ifc-lite/collab` (gate on remote ops) | ⬜ | |
| IDS-110 | Test-suite model + runner (UI + headless) | ⬜ | |
| IDS-111 | Synthetic fixture generator (IFC4) via `@ifc-lite/create` | ⬜ | |
| IDS-112 | IFC2X3/IFC4X3 fixture support | ⬜ | |
| IDS-113 | Snapshot fixtures ("pin element as test") | ⬜ | |
| IDS-114 | XSD-pattern string generator (matching / non-matching examples) | ⬜ | |

### P-11 — Headless everywhere

| ID | Title | State | PR / commit |
|---|---|---|---|
| IDS-115 | CLI `ids audit|lint|fmt` | ⬜ | |
| IDS-116 | CLI `ids diff|convert|explain|preview|coverage` | ⬜ | |
| IDS-117 | CLI `ids test|infer|draft|edit|bsdd` | ⬜ | |
| IDS-118 | MCP batch 1: `ids_audit`, `ids_lint`, `ids_read`, `ids_apply_ops`, `ids_write`, `ids_schema_*` | ⬜ | |
| IDS-119 | MCP batch 2: `ids_preview`, `ids_infer`, `ids_coverage`, `ids_diff`, `ids_test` | ⬜ | |
| IDS-120 | SDK `bim.ids.authoring` | ⬜ | |
| IDS-121 | Embeddable Studio mode (embed-protocol messages) | ⬜ | |
| IDS-122 | Flow nodes (Load IDS, Lint, Validate, BCF) | ⬜ | |
| IDS-123 | Docs: studio, authoring, agent, test suites; update ids/cli/mcp/viewer-assistant guides | ⬜ | |

### P-12 — Standards leadership

| ID | Title | State | PR / commit |
|---|---|---|---|
| IDS-124 | IDS 1.1 preview flag + candidate-feature modelling (extended partOf, translations, identifiers, tolerance) | ⬜ | |
| IDS-125 | Conformance dashboard: our engine vs other open engines on the corpus (+ official audit) | ⬜ | |
| IDS-126 | Upstream contributions: ambiguity notes and lint catalogue references on standard issues | ⬜ | |

## Session log

| Date | Session | Summary |
|---|---|---|
| 2026-10-08 | 1 | Plan written; campaign docs, tracker and handover committed; pitch branches and draft PRs opened |
