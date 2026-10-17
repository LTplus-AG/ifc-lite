# ifc-lite Rust review — shared brief for every reviewer

Repo (git worktree, read-only for you): /home/louistrue/.t3/worktrees/ifc-lite/t3code-b066fae6
Workspace manifest: repo-root Cargo.toml. Crates: rust/{core,geometry,processing,clash,ffi,export,wasm-bindings,landxml,cloud-import,python,csg-thread-bench}, apps/server.
Read first: AGENTS.md (root) and rust/AGENTS.md, plus any AGENTS.md / README inside your area. They document deliberate decisions — do NOT report something as a defect if it is a documented, justified choice (but DO report it if the justification is stale or the doc contradicts the code).

## Goal
The owner wants a long-term-maintainability review. Priority order:
1. **DRY violations (TOP PRIORITY).** Both textual copy-paste AND semantic duplication: the same concept implemented 2+ times (e.g. several polygon-normal / plane-fit / transform-compose / unit-scale / entity-attribute-read / triangulation / tolerance constants / bbox / hashing helpers; parallel code paths for wasm vs native vs server that drifted; near-identical match arms; copy-pasted test fixtures/builders). For each, list EVERY site you found, say whether they have already drifted (behavioural difference = possible bug), and name the single home it should collapse into.
2. **Bugs and quirks.** Real correctness issues: panics on untrusted input (indexing, unwrap, slicing on UTF-8, integer overflow given overflow-checks=false in release), NaN handling, f32/f64 precision loss, silent error swallowing, wrong units, off-by-one, non-determinism (HashMap iteration order leaking into output, par_iter ordering), unsound unsafe, race conditions. Verify each by reading the code paths — state confidence (CONFIRMED / LIKELY / SUSPECT) and a concrete failure scenario.
3. **Inefficiencies.** Needless allocation/clone in hot paths, O(n²) where O(n) is easy, repeated parsing/decoding of the same entity, String building in loops, Vec<Vec<>> where flat works, lock contention, redundant passes.
4. **Best-practice / maintainability.** God files/functions (give line counts), deep nesting, stringly-typed APIs, magic numbers/tolerances scattered without a named home, inconsistent error types (anyhow vs thiserror vs String vs Option), pub surface too wide, dead code / dead features / stale comments, cfg/feature soup, tests that are huge copy-paste, module layout that hides ownership, `#[allow(...)]` blankets, unsafe without SAFETY comments, unidiomatic patterns.

## Tooling already run (use these, don't re-run)
- ~/rust-review/jscpd-clones.txt — textual clone list (min 12 lines) grouped by crate. Start from the entries for your area, but go far beyond it: semantic duplication is what matters most and jscpd can't see it.
- Pedantic clippy is running in the background into ~/rust-review/clippy-pedantic.txt (may be incomplete while you work). Optional to consult; do not dump lint noise into findings.
- Do NOT run cargo (build/test/clippy) — a workspace build is already running and target-dir lock contention will stall you. Use rg/grep/sed/read only. Do NOT edit any repo file.

## Output
Write your findings to the file path given in your task, in this format:

```
# <Area> review

## Summary
3-8 bullet headline takeaways, most important first.

## Findings
### <AREA-PREFIX>-<n>: <one-line title>
- Category: DRY | Bug | Quirk | Perf | Maintainability | Best-practice
- Severity: High | Medium | Low
- Confidence: CONFIRMED | LIKELY | SUSPECT   (mainly for bugs)
- Where: path/to/file.rs:LINE (list all sites for DRY)
- What: concise description with evidence (short code quotes ok)
- Why it matters: concrete failure scenario or maintenance cost
- Fix: specific recommendation (where the single home should live, what API)
- Effort: S | M | L
```
Order findings by severity then category (DRY first within a severity). Be exhaustive — the owner explicitly wants ALL DRY violations listed, not a sample. Better 60 precise findings than 15 vague ones, but no padding with trivial lint noise. Paths repo-relative with line numbers.

Also append a section `## Concept inventory` listing cross-cutting helpers you saw defined in your area (name + path:line, one line each) for: vector/matrix math, transforms/placements, tolerances/epsilons, unit conversion, bbox/AABB, hashing, triangulation/polygon ops, entity attribute access/decoding, colour/style resolution, error types. The lead will cross-reference these across crates to find cross-crate duplication.

Your final reply to the lead: just the path to your file plus your top 5 findings in one line each.
