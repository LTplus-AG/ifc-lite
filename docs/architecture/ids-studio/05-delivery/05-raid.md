# RAID log (Risks, Assumptions, Issues, Dependencies)

## Risks
| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R-01 | Funnel and preview too slow on large federated models | M | H | Index reuse, stage cache, worker, sampling with confidence; benchmark gate in C3 week 4 | Track B |
| R-02 | Op vocabulary churn breaks the agent and persisted histories | M | M | `opsVersion` + migrations; tool schemas generated from types; freeze v1 at end of C1 | Track A |
| R-03 | Agent quality below targets | M | H | Eval-first (P-08 in C1); tool design over prompt tricks; circuit breaker cuts modes from beta | Track C |
| R-04 | LLM cost too high for the free tier | M | M | Caching, effort per mode, budgets, quotas; BYOK default for heavy use | Track C |
| R-05 | Gate rejects legitimate names due to schema-table gaps | M | H | Fill Qto tables (IDS-009); "use as custom" escape hatch with warning; telemetry on `gate_rejected{code}` | Track A |
| R-06 | Lint false positives erode trust | M | H | Precision ≥ 95% gate; demote uncertain rules to info; suppressions with reasons | Track A |
| R-07 | Spec ambiguity: our interpretation differs from other tools | H | M | Lint explains both readings; conformance dashboard; upstream issues; follow the corpus where it decides | Track A |
| R-08 | Another tool ships bSDD + AI + live check first | M | M | Model loop + test suites are hard to copy; ship beta at month 6; public benchmark | Owner |
| R-09 | Scope creep ("boil the ocean") stalls delivery | H | H | Shape Up appetites and circuit breakers; betting table per cycle; beta gate is explicit | Owner |
| R-10 | Public-repo leakage of strategy or client info | L | H | ADR-014; issue templates vendor-neutral; PR review checklist | Owner |
| R-11 | Licence issues (benchmark, templates, corpus BY-ND, ids-flow AGPL) | M | M | D4/D5; never modify corpus files; re-implement instead of copying AGPL code unless relicensed | Owner |
| R-12 | Browser memory with large models + Studio + AI | M | M | Lazy-load agent/interop chunks; measure in benchmarks | Track B |
| R-13 | Prompt injection via documents or IFC strings | M | M | Data wrapping; no exfiltration tools; E5 adversarial eval | Track C |
| R-14 | Collaboration conflicts corrupt documents | L | H | Gate on remote ops; diagnostics instead of silent drops; revision snapshots | Track D |

## Assumptions (to verify)
| ID | Assumption | How to verify | By |
|---|---|---|---|
| A-01 | Model-grounded features drive switching more than AI | Activation and usage split at beta | C4 |
| A-02 | Users accept a sidecar for Studio metadata | Beta feedback; bundle adoption | C4 |
| A-03 | IDS 1.0 entity facet doesn't match subtypes (basis of lint ENT-001) | Corpus cases + IDS docs + ifctester behaviour | C2 week 1 |
| A-04 | Exact accepted boolean lexical forms in IDS values | Corpus + docs | C2 week 1 |
| A-05 | bSDD API stays stable and accessible via our proxy | Monitoring; recorded fallbacks | ongoing |
| A-06 | `@ifc-lite/create` can be extended to IFC2X3/IFC4X3 within appetite | Spike in C4 cooldown | C4 |
| A-07 | An external IDS benchmark can be used and scores published | Licence check (D4) | C1 |
| A-08 | Opus-tier tool use reaches ≥ 80% E2 agreement with tools | First eval in C3 week 2 | C3 |

## Issues (known today)
| ID | Issue | Action |
|---|---|---|
| I-02 | Possible ids-flow export bug dropping restricted applicability facets | Note on the ids-flow repo if it stays live (D1) |
| I-03 | Viewer has duplicate IFC4 pset/qto definitions | Supersede with `@ifc-lite/data` in P-03, delete |

## Dependencies
| ID | Dependency | Type | Risk |
|---|---|---|---|
| DEP-01 | buildingSMART IDS corpus + audit tool | External (open) | Low |
| DEP-02 | bSDD API | External service | Medium |
| DEP-03 | Claude API (and BYOK providers) | External service | Medium |
| DEP-04 | `@ifc-lite/collab` maturity (0.x) | Internal | Medium |
| DEP-05 | `@ifc-lite/create` for fixtures | Internal | Low/Medium |
| DEP-06 | Real-model fixture set with licences | Internal/partners | Medium |
