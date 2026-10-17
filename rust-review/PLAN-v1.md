# Plan: resolve the 2026-10-15 Rust review (622 findings)

This plan works from `REPORT.md`, `INDEX.md` and the per-area files in this folder. Every finding ID is assigned to exactly one work package (WP) in `plan-coverage.csv`, and a script checks that the coverage is complete. When this document and the repo's `AGENTS.md` disagree, `AGENTS.md` wins.

## 0. Definition of done

- **Every one of the 622 IDs is closed in the ledger** (`~/rust-review/ledger.md`) with one of these dispositions:
  - `fixed` (with the PR link)
  - `fixed-by:<other ID>`
  - `rejected` (false positive; give the evidence)
  - `wontfix` (a deliberate decision; give the reason and record it in the relevant AGENTS.md)
- **Every defect class that has a prevention gate (§6) has that gate on `main`**, so the class cannot come back silently.
- **The single-home claims in docs and comments are true.** Each one either points at the real home or has been deleted.
- **No phase is "done" while its ledger rows are still open.** A merged PR does not by itself close a ledger row.

## 1. Operating model

### 1.1 Issues and charter
- **One umbrella charter issue.** It is titled "Rust maintainability sweep (review 2026-10-15)" and states what is swept (these 622 IDs) and what ends it (§0). It needs the maintainer's `unqueued` label or `ready`, as the AGENTS.md rule on charters requires.
- **One issue per defect class.** Each WP below is one issue, or a few issues where a WP lists sub-packages.
  - The issue body lists the finding IDs it covers and links to the review file.
  - Above ~1,500 changed lines, stack the PRs against the same issue.
- **Claiming.** Assign `louistrue`, post a claim comment naming the session, and add a `claimed:session-<id>` label before any code is written (AGENTS.md "Claiming work").

### 1.2 PR classes: never mix them
Each PR declares exactly one class in its description.

| Class | Meaning | Required evidence |
|---|---|---|
| **R** (refactor) | Behaviour-preserving | Byte-identity on all three oracles: `mesh_determinism` manifests unchanged, the ifcopenshell parity reference unchanged, and the export golden corpus (T3) unchanged. In perf-sensitive paths, a neutral perf verdict from `scripts/perf/probe.sh` (base vs branch, interleaved). |
| **X** (behaviour change) | Fixes a bug or changes output | A failing regression test first (it cites the finding ID and issue). If geometry output changes: **both** manifests re-pinned and the ifcopenshell reference regenerated in the same PR. Real-model evidence for user-visible changes. A perf verdict if the path is perf-sensitive. |
| **G** (gate) | Adds a CI check, ratchet or lint | The gate fails at the parent commit of a known instance and passes at the fix. |

**Why the separation matters:** most consolidations collapse copies that have drifted, so a "refactor" can quietly pick one copy's behaviour.
- **Rule:** reconcile the drift first, in an X PR that makes all copies agree and pins the agreed behaviour with tests. Only then delete the copies, in an R PR that must be byte-identical.
- **When the copies cannot be reconciled without the shared home:** one X PR introduces the home, and its description lists the drift it resolves.

### 1.3 Every PR
- Run `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace`.
- Build and test `rust/python` and `rust/csg-thread-bench` in-dir whenever a public Rust API changes.
- Commit the wasm `.d.ts` whenever bindings change.
- The module-size ratchet still applies. New homes must stay under 400 lines; split them rather than allowlisting.
- Supersede means delete: the PR that introduces a home deletes the copies it replaces, or a later stacked PR on the same issue does.
- Never run a repo-wide `cargo fmt`. Format only the lines you touch.
- **TS twins.** Several Rust paths have TypeScript twins with parity vectors: the STEP log writer and attribute mutations, clash, schema conversion, and the GUID helpers.
  - A behaviour fix lands in both languages in the same PR and adds a parity vector.
  - A Rust-only refactor must not change the vector outputs.

### 1.4 Lanes, models, ledger
- **Coordinator: main session.** It owns the ledger, plans each wave, verifies results and merges.
- **Lanes are background agents in their own worktrees** under `/home/louistrue/wt/`.
- **Model choice:**
  - **Fable** writes the design note for every foundation and consolidation WP (F2, F3, F4, F5, C1, C2, C3, C4, C6, C7, C9) *before* any code. The note covers API, migration order and the drift-reconciliation list. Fable also reviews each foundation PR.
  - **Opus** handles bug fixes, foundation implementation and consolidations.
  - **Sonnet** handles mechanical consumer migrations, CI shepherding, manifest re-pins, ledger bookkeeping and rebases.
- **Merge discipline (§5.3).** At most one geometry-output-changing (X) PR is open at a time. All of them re-pin the same two manifests and the parity reference, so concurrent ones conflict and invalidate each other's evidence.

## 2. Phase T: triage and baselines (wave 0)

| WP | Scope | Output |
|---|---|---|
| **T1** | Umbrella charter issue and per-WP issues, created from this plan's WP list with the ID lists from `plan-coverage.csv`. Initialise the ledger. | Issues filed; ledger with 622 rows |
| **T2** | **Verification wave.** Every Bug or Quirk finding marked LIKELY or SUSPECT, plus every High bug, gets a failing test on a scratch branch or a documented non-reproduction. The review was read-only, so ~30% of LIKELY/SUSPECT items may not reproduce. | Each ID is either `confirmed (test at <branch>)` or `rejected (evidence)`. Fix WPs then pick up the test. |
| **T3** | **Byte-identity oracles.** Add an export golden corpus: STEP, STEP-log, merge, glTF, OBJ, USD, CSV, JSON, Parquet, HBJSON/DFJSON and LandXML outputs over the fixture set, compared by FNV, with a `--check` script. Record the baseline perf probe and confirm `mesh_determinism` and parity are green on main. | The oracles R-class PRs need. Today only mesh output has one. |

T2 runs in parallel per crate, as Sonnet lanes for test-writing with Opus for anything that needs judgement. T3 is one Opus lane.

## 3. Phase S: safety (crash, abort, DoS). Wave 1, all in parallel

These are small X PRs, each a single defect class. Do them first: they are the cheapest and the most severe.

| WP | Defect class | Core IDs | Gate |
|---|---|---|---|
| **S1** | Unbounded recursion and stack exhaustion | SERVER-5, EDGE-FFI-1 | **G1:** extend `scripts/check-refwalk-guards.mjs` scope to `apps/server`, `rust/export`, `rust/core` and `rust/landxml`. SERVER-5 slipped through because the server is out of scope today. |
| **S2** | Non-total float comparators in sorts/min/max (`partial_cmp().unwrap_or(Equal)` / `.unwrap()`) | EDGE-CLASH-1, PROC-S30, PROC-AL-17, GEOM-12, ROUTER-30 | **G2:** a grep or clippy `disallowed_methods` gate on `unwrap_or(Ordering::Equal)` inside sort comparators; use `total_cmp`. |
| **S3** | Allocation or work sized by untrusted input | EXPORT-STEP-8, EDGE-LXPARSE-4/17/24, CORE-5, CORE-24, PROC-AL-25, PROC-16, SERVER-26, EXPORT-GEOM-14 | none |
| **S4** | Server admission, blocking work and cache policy | SERVER-6/7/8/10/11/24/29/35, SERVER-12/21/22 | An admission test per route |
| **S5** | Reachable panics (`unreachable!`, unchecked indexing, `unimplemented!`, `throw_str` in `&self`) | PROCESSING-APP-2/21, KERNEL-17/27/28/30, EDGE-WASM-13, EDGE-LXPARSE-26 (the `unreachable!` arms of EDGE-LXMATH-22) | none |
| **S6** | Non-finite input admitted (NaN/inf reaching geometry or output) | XCUT-26, PROC-S23, PROC-AL-16, CORE-14/15, GEOM-39, EDGE-WASM-32, EDGE-FFI-5, EXPORT-GEOM-16, EXPORT-STEP-5 | none |

The full ID lists are in `plan-coverage.csv`.

## 4. Phase B: silent wrong output (waves 1–2)

**Policy:** where a foundation (F) or consolidation (C) WP will collapse the drifted copies anyway, fix the bug *inside* that WP, with the regression test written first in T2. The exceptions are High-severity, user-visible bugs and bugs whose home is more than ~2 weeks out. Those get a minimal X fix now: the fix goes in the current copies and the test stays. The rows below are the ones fixed now.

| WP | Defect class | Core IDs | Notes |
|---|---|---|---|
| **B1** | LandXML text references and stream sync | EDGE-LXPARSE-2/3/23 | Handle `GeneralRef` in all 4 `consume_event`s now; the driver refactor (C9) later removes the copies. Add a LandXML fuzz target (**G7**). |
| **B2** | Property-set loss on data export | EXPORT-DATA-1/8/26/28 | Teach core `get_refs` the `IfcPropertySetDefinitionSet` wrapper. That fixes export, processing and server at once. |
| **B3** | STEP writer and log correctness | EXPORT-STEP-1/3/9/10/11/26 | STEP-1 gets the minimal trivia-tolerant framing now; the shared `StepRecord` is in F4/C7. Includes the TS twin. |
| **B4** | Schema conversion validity | EXPORT-MERGE-1/8/9/12/18 | MERGE-1 is fixed by deriving arity from core's `SchemaVersion` registry. That is the DRY fix for MERGE-2 too, so both land together. |
| **B5** | Precision loss: f32 before RTC/site rebase, or rebase dropped | EXPORT-GEOM-1, EXPORT-DATA-6/20, PROCESSING-SYM-4 | Add the rule to `rust/AGENTS.md`: every exporter and overlay that bypasses the orchestrator must apply RTC and site rotation in f64. ROUTER-27 goes with C2. |
| **B6a** | Profile holes dropped | PROC-4, PROC-AL-5, PROC-15 | geometry-output lane |
| **B6b** | Planar face triangulation and winding | GEOM-3, PROC-S10, PROC-S5, PROC-S16 | geometry-output lane |
| **B6c** | Curves and B-splines | PROC-S2, PROC-S20 (diagnostic now, trimming later), PROC-S21, PROC-13, PROC-S24 | geometry-output lane |
| **B6d** | Processor registry and boolean operands | PROC-S6, S17, S18, S19, S25 | geometry-output lane |
| **B6e** | Index and ref handling in tessellation | PROC-3, PROC-14, CORE-11, CORE-12 | geometry-output lane |
| **B7** | Native/browser/server parity bugs | EDGE-WASM-5, PROCESSING-4, EDGE-WASM-4/25/26, PROCESSING-5 / SERVER-18, PROCESSING-18/23 | WASM-5 and PROCESSING-4 now; the rest fold into C4 |
| **B8** | Energy exporters (HBJSON/DFJSON) | EXPORT-DATA-4/5/7 | none |
| **B9** | LandXML numerics and units | EDGE-LXMATH-1/9/10/11, EDGE-LXPARSE-7/27 | Check against the shipped #7642 (LandXML georef assumptions) before changing unit policy |
| **B10** | Fail-closed exports and front-end I/O | EXPORT-GEOM-9/15, EDGE-FFI-2/12, EDGE-WASM-14, SERVER-37/41, XCUT-25 | none |

**The B6 sub-packages are serialised in one geometry-output lane (§5.3).** Order: B6e, B6a, B6b, B6c, B6d. Each one re-pins both manifests and the parity reference, and shows a before/after on a real model.

## 5. Phases F and C: foundations and consolidations (waves 2–5)

### 5.1 Foundations (F)

| WP | What | Themes / core IDs | Depends on |
|---|---|---|---|
| **F0** | Manifest hygiene: `[workspace.dependencies]` for third-party crates, align `sha2`, delete 7 unused deps, `[lints] workspace = true` on python/bench, `cargo machete` in the clippy lane (**G6**) | XCUT-16/17/18 | none |
| **F1** | `ifc-lite-testkit` dev crate: fixture resolution that honours `IFC_LITE_REQUIRE_FIXTURES` everywhere, `step_file(schema, lines)`, and mesh oracles (`EdgeLedger`, `signed_volume`, `is_closed`) with one documented definition of "watertight" | theme O + I (test side): GEOM-4/5, KERNEL-2, PROC-S31, XCUT-22, test-fixture items | F0 |
| **F2** | Shared math home: `v3`, `mat4`, `Aabb3`, `frame` (Z-up↔Y-up, conjugation, AABB swap) and `tol` (unit-aware tolerances with documented units) | theme E: XCUT-3/4/5/8/12, EDGE-CLASH-2/8/12, EXPORT-GEOM-3, PROCESSING-10..13, SERVER-15, EDGE-WASM-9, PROC-S8 | F0; design note (Fable). **Decision D1.** |
| **F3a** | Core units and project: one `ProjectUnits` path, a cached `length_unit_scale`, one IFCPROJECT locator, one SI-prefix table, exact US survey foot | theme D: CORE-2/3/15, XCUT-6, EDGE-WASM-8, EXPORT-DATA-9, EXPORT-STEP-20, PROC-AL-12 | F0 |
| **F3b** | Core entity reading: `point3`/`direction3` (refuse rather than default to 0), `Axis2Placement::{2d,3d}` → one `build_axis2_matrix`, `Axis1Placement`, `placement::resolve_chain` (depth from `core::limits`) | theme A: XCUT-1/2, ROUTER-3, PROC-1, PROC-S7/S9, GEOM-1/2, PROCESSING-SYM-2/6/16, PROC-AL-10, CORE-37 | F2 (vector types) |
| **F3c** | Typed values: `AttributeValue::Typed`, `as_logical()`, symmetric accessors | CORE-4/33, PROC-S11, PROC-AL-9 | F0. **Decision D3** (fail-closed policy). |
| **F3d** | Micro-homes: `core::guid`, `core::hash` (FNV and one xxh3 content key), `fmt_num`, colour keys | theme N: EXPORT-MERGE-3/14, XCUT-9..13 | F0 |
| **F4** | One STEP grammar in core: `StepRecord::parse` (trivia-tolerant), a single `split_top_level_args` with grammar options, one numeric grammar, trivia/comment handling, binary literals. Add a **differential fuzz target** across the grammars (**G7**). | theme C (core side): CORE-1/6/8/9/10/13/30/32 | F0; design note (Fable) |
| **F5** | Error policy: per-crate `thiserror` enums with `kind()` and a `#[from]` chain, one `From` into `JsError` and `ApiError`, and a ratchet on `Result<_, String>` in `pub` signatures (**G5**) | XCUT-15 and every error-type finding | F3/F4 landed in that crate |
| **F6** | Runtime configuration: `GeometryConfig` replaces the env `OnceLock`s and global atomics; a `WorkObserver` for cancel, progress and budget; consolidated telemetry counters; kebab-case features | XCUT-14/20, GEOM-20/21, ROUTER-17/18 | C2 (touches the router) |

**Consumer migrations after F2, F3a–d and F4.** One R-class PR per (foundation × crate): geometry, processing, export, server, wasm, landxml, clash, python. Each one deletes that crate's copies. These are mechanical, so they suit Sonnet lanes, and they run in parallel across crates. A **G3 "single-home" parity test**, in the style of `styling_parity`, lands with the last migration of each foundation. It fails if a private copy of the placement reader, frame swap, IFCPROJECT scan, unit resolver or STEP splitter reappears.

### 5.2 Consolidations (C)

| WP | What | Themes / core IDs | Depends on |
|---|---|---|---|
| **C1** | Geometry curves and faces: a single curve sampler (`profiles::get_curve_points`) with a 2D projection; `triangulate_planar_face`; one face-bound extractor; processor scaffolding (`Mesh::from_buffers`, `RtcRebased` blanket); delete the `profile_extractor` fork; shared `clothoid_integral`, `vertical_curve` and `locate`, also consumed by landxml | theme H: PROC-S1/S3/S4/S12/S13, PROC-2/5/6/11, PROC-AL-3/4/29, EDGE-LXMATH-2/7/17 | F2, F3b, B6 |
| **C2** | Router restructure: `RepresentationWalk` (one cycle guard and the `meshed_representations` de-dup); route the four mapped walks through `process_representation_item` (fixes ROUTER-26/27/28); `CutStrategy` list replacing `apply_void_context_inner`; `EdgeLedger` from F1; split `GeometryRouter` into `RouterConfig`, `SharedCaches` and `RouterDiagnostics`; opening-meshing perf | ROUTER-* themes, ROUTER-20/21/22/26..28/33/37 | F1, F3b, C1 |
| **C3** | Kernel: generate the predicate tiers from one definition (macro or generic over the number tier); derive the `SNAP_GRID` constants; one predicate-cascade builder (fixes the `tritri::cmp_along` budget drift); `union_all` acceleration; tolerances via F2 `tol` | KERNEL-1/3/5.., KERNEL-18/19/31, PROC-S14, PROC-AL-20 | F1, F2; `determinism.yml` dispatched before merge |
| **C4** | Processing orchestration and thin wasm: a `Discovery` visitor shared by the native scan, shard classes and the three wasm scans; `BatchRouterConfig::build()`; public `resolve_element_color`; one `process(content, &ProcessingRequest, &mut dyn ProcessingSink)` replacing the 12 entry points; wire encoders and decoders in processing; `ContentCaches` with one `reset()` | theme G: PROCESSING-1..8, EDGE-WASM-1..12/17/18, B7 leftovers | F3a, C2 (router config) |
| **C5** | Symbolic 2D onto the geometry primitives (operator, placement, curves) | PROCESSING-SYM-1/2/3/15/17 | C1, F3b |
| **C6** | `ifc-lite-model` crate: export's entity-data code extracted; the server depends on it; the server's `data_model/{properties,quantities,relationships,materials,classifications}` and its TS-fed generator deleted; per-schema data from core `SchemaVersion`; one `SchemaFamily` | themes F and J: XCUT-7, SERVER-3/4/28, EXPORT-DATA-2/3/17/18, EXPORT-MERGE-2/4, EXPORT-STEP-12/24, PROCESSING-5 | F3a, F3c. **Decision D2.** |
| **C7** | Export pipeline core: one glTF assembler; `mesh_input::is_exportable`; `step_real`; an `Emitter`; STEP readers migrated to F4; a `ladybug` module; shared energy-exporter geometry | theme M: EXPORT-GEOM-2/4/6, EXPORT-STEP-2/4/6/7/17..22, EXPORT-MERGE-5/6/13, EXPORT-DATA-10/11/22 | F4, F2 |
| **C8** | Server HTTP scaffold: a `parse_route<Req, Out>` combinator and one `CacheEntry` reader; delete the stale bench fork | theme L: SERVER-1/2/9/13/14 | S4 |
| **C9** | LandXML driver: `xml::driver` + `FamilyHandler`, a `Budget` type, one `TokenScanner`, one decoder, unified model types, units resolved once, performance | theme K: EDGE-LXPARSE-1/5/6/8..22, EDGE-LXMATH-3..8/12..21/23/24 | B1, B9, C1 (for the shared alignment math) |
| **C10** | Surface slimming: generated-code reduction (one `IfcType` plus per-schema tables); dead core surface (`streaming.rs`, the `fast_parse` TFS path, `geometry_types`, unused `Error` variants); geometry re-export trimming; dead wasm exports | CORE-7/20..22, GEOM-9/10, EDGE-WASM-30, PROC-S29 | C4/C6, since consumers must be settled first |

### 5.3 The geometry-output lane

Any X-class PR that changes mesh output belongs to the lane: B6a–e, the behaviour-changing parts of C1/C2/C3, ROUTER-27 and PROC-S20 trimming.
- **One lane, serialised.** Each PR re-pins `mesh_determinism.json` and `mesh_determinism.wasm32.json`, regenerates `tools/ifcopenshell_reference/`, dispatches `determinism.yml`, and attaches a real-model before/after.
- **R-class geometry refactors may run in parallel with the lane.** They must stay byte-identical against the *current* pins, so after each X merge they rebase and re-verify.

## 6. Prevention gates (G)

Each gate lands with the WP that makes it pass.

| Gate | What | Lands with |
|---|---|---|
| G1 | `check-refwalk-guards` covers all Rust crates | S1 |
| G2 | No non-total float comparators | S2 |
| G3 | Single-home parity tests (placement/point reader, frame swap, IFCPROJECT scan, unit resolver, STEP splitter, curve sampler) | last migration of F2/F3/F4, and C1 |
| G4 | Function-length ratchet (like `module_size_ratchet`, for functions ≥150 lines) | after C2/C4 shrink the worst offenders |
| G5 | `Result<_, String>` in `pub` signatures ratchets down | F5 |
| G6 | `cargo machete` and the workspace-inheritance check | F0 |
| G7 | Fuzz targets in CI (STEP grammars differential, `decode_ifc_string`, the LandXML driver) | F4, B1/C9 |
| G8 | Export golden corpus `--check` in CI | T3 |
| G9 | Docs-truth: a test that resolves every "single home" referenced in `AGENTS.md` / `rust/AGENTS.md` to an existing symbol | L-docs |

## 7. Phase L: long tail (wave 5)

Remaining Low and Maintainability findings not absorbed above are swept **per crate, with one charter issue per crate**: L-core, L-geometry, L-kernel, L-router, L-processing, L-export, L-server, L-landxml, L-bindings (wasm/ffi/python/clash). Typical content: stale docs, small DRY items, god-function splits not covered by C-WPs, magic constants, test-fixture leftovers.

**L-docs** fixes the stale AGENTS.md and rust/AGENTS.md claims (XCUT-24, etc.) and adds G9.

Rule: fix docs drift inside the WP that touches the code. L-docs only sweeps what is left.

## 8. Waves and parallelism

| Wave | Contents | Parallel lanes (max) |
|---|---|---|
| 0 | T1, T2, T3, F0 | 4–6 (T2 per crate) |
| 1 | S1–S6, B1, B2, B3, B5, B7 (WASM-5, PROCESSING-4), B8, B10, F1 | 6 (one per crate, to avoid conflicts) |
| 2 | F2, F3a, F3c, F3d, F4 (design notes first); B4; B9; the geometry-output lane starts on B6e→B6d | 4 + 1 serial lane |
| 3 | F3b; consumer migrations (Sonnet, per crate); C3; C8; F6 design | 6 |
| 4 | C1 → C2; C4 (after C2's `RouterConfig`); C6; C7; C9 | 4 + the serial lane |
| 5 | C5, C10, F5 (per crate), F6, Phase L, G4, G9, ledger closure | 6 |

**Conflict rule:** at most one lane per crate per wave touches non-test code in that crate's hot files (router, `processor/mod.rs`, `gltf.rs`, the LandXML parsers). Sonnet migrations wait for the C-WP that owns a file.

**Rough size:** ~110–130 PRs. Phases S and B are ~35 small PRs; F plus migrations ~35; C ~40 (stacked); L ~15. The critical path is F2 → F3b → C1 → C2 → C4 → C10.

## 9. Decisions needed from the maintainer

| ID | Question | Recommendation |
|---|---|---|
| D1 | Should the math home be a new zero-dependency crate (`ifc-lite-math`, which clash can depend on) or a module in geometry (which clash cannot depend on)? | New crate. Clash keeps its Plato-generated TS-parity helpers but takes constants from it. |
| D2 | Should the server depend on a new `ifc-lite-model` crate, deleting its own data model? | Yes. This is the only way to make "Rust is the source of truth for the server" true. Cost: a bigger server dependency graph. |
| D3 | Fail-closed vs default-to-zero for malformed points, placements and units. | Refuse the item and record a diagnostic (AGENTS.md #3421 direction). **Visible effect:** some malformed files lose elements that render today at the origin. |
| D4 | Issue intake: should each WP issue get `ready` individually, or the umbrella charter get `unqueued` with child issues inheriting it? | One charter with `unqueued`, children listed in it. |
| D5 | Order of TS-twin fixes (STEP log writer, clash, schema converter): same PR, or Rust first with a parity vector marked pending? | Same PR. A vector marked pending is a drift we would be choosing. |
| D6 | Generated-code slimming (C10/CORE-7) changes the public `IfcType` surface of `ifc-lite-core` (a crates.io crate?). | Do it in a major bump, batched with the F5 error-type changes. |

## 10. Risks

- **Refactors that hide behaviour changes.** Mitigated by the R/X split, the three oracles, and reconcile-then-delete.
- **Perf regressions from collapsing fast paths** (rect_fast, the CoordIndex fast path, point fast readers). Every R PR in a perf-sensitive path carries a base-vs-branch probe, and Holter/ISSUE_053 is run for C1/C2/C3.
- **Manifest and parity churn.** One serial lane; R PRs rebase and re-verify.
- **Scope creep.** The charter ends at §0. New findings discovered on the way go into new issues, not into this campaign, unless they belong to a WP's defect class.
- **Review-finding false positives.** T2 catches them before any fix work.
- **Session limits.** Sonnet takes the mechanical lanes, and no more than 6 concurrent lanes run.

## Appendix: coverage

`plan-coverage.csv` maps each finding ID to: `id, file, severity, category, wp, disposition_hint (fix-now | fix-in-wp | verify-first | likely-reject | doc-only), note`. `check-coverage.py` asserts that all 622 IDs map to exactly one existing WP.
