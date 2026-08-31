# Agent Guidelines: ifc-lite

Project-specific gotchas and guardrails: the things that bite you *here* and that you can't infer from the code. Generic good practice is assumed, not repeated. This file is the single source of truth; `CLAUDE.md` and `.cursorrules` just point here.

## What this is
Browser-first IFC toolkit: a WebGPU web viewer plus a headless CLI/MCP/server. No first-party desktop app. Domain logic (decode, geometry, styling, export) lives in Rust crates under `rust/*` and is the source of truth for the server, CLI, SDK, and wasm; TypeScript packages under `packages/*` and apps under `apps/*` consume it (TS mostly does GPU upload and UI). Architecture docs: `docs/architecture/overview.md`.

## Accountability, and what a PR has to be able to answer

Everything here is agent-written, including the maintainer's own commits, so there is no AI-disclosure rule and no point in one. What matters is not who typed the code, it is whether anyone can answer for it.

**Every PR has an accountable submitter, and the test is answering, not authorship.** When review asks a question, the submitter answers with evidence: a test, a run, a measurement, a model file that reproduces it. "The agent wrote it" is never an answer. "Here is the run that proves it" always is. You do not need to be able to write the code. You do need to be able to demonstrate what it does. Unanswered questions block the merge.

**A PR claiming user-visible behaviour shows that behaviour.** Not "should work". For this repo that usually means a real IFC model from a real authoring tool, an oracle run, or a viewer screenshot: ground truth an agent cannot fabricate, and the contribution it cannot make. Supplying one is worth more than another sweep.

## Work selection

**Default lane: a PR closes an issue carrying the `ready` label.** `ready` means the maintainer has decided it is in scope, wanted now, and scoped. `scripts/check-issue-queue.mjs` checks this and **prints its own mode**; read that line, not this one, because no prose here tracks a config key. The escape hatch is the `unqueued` label, applied by the maintainer.

Filing issues is welcome and unrestricted: an audit producing twenty good issue reports is a real contribution. Filing is not claiming, and an unlabelled issue is not a work item.

**One defect class per issue, one issue per PR.** A defect class found once and paid for N times is N review contexts for one decision: nine separate PRs once landed one state-reset class, one call site at a time. Fix the class. Above roughly 1,500 changed lines, stack PRs against the same issue rather than shipping one unreviewable diff.

**A sweep needs a charter.** Audit-driven work is valuable and not discouraged, but it has no natural stopping point, so it needs an issue naming one: what is swept, and what ends it. Approved once, instead of adjudicated per PR.

## Commands
- Install: `corepack enable && pnpm install` (Node 22.x, `pnpm@10.8.1` pinned via `packageManager`).
- Build: `pnpm build` (turbo). WASM: `pnpm build:wasm` (needs Rust nightly + `wasm-pack`); `pnpm build:wasm:fetch` pulls the prebuilt wasm from npm when Rust is unavailable (e.g. Windows without WSL).
- Typecheck: `pnpm typecheck` (turbo, wasm-free: no Rust toolchain needed). This covers **test sources too**, which for a long time it did not: the root `tsconfig.json` excludes `**/*.test.ts` so tests never reach `dist/`, every `packages/*` config inherits that through `tsconfig.packages.json`, and `exclude` filters `include` — so a package's `"include": ["src/**/*"]` cannot pull its own tests back and 652 of 960 test files were in no typecheck program at all (#2457). Since vitest and `tsx --test` transpile per file without checking types, an unchecked test still *runs* while everything it asserts at type level (`expectTypeOf`, `@ts-expect-error`, a typed fixture) is silently unverified. Each package's `typecheck` script therefore runs `scripts/typecheck-tests.mjs`, which derives a no-emit test program from that package's own tsconfig and lists the test files under `files` — unlike `include`, `files` is not filtered by `exclude`. The generated `<pkg>/tsconfig.tests.json` is gitignored (rebuilt every run); the shared emit-off overrides live in `tsconfig.tests.base.json`. Do not "fix" a test-only type error by putting tests back into a package's emit tsconfig — that ships them to `dist/`.
- Test: `pnpm test` (turbo, TS); `cargo test --workspace` (Rust, not `cargo check`); `pnpm test:wasm-contract` (real wasm boundary); `pnpm test:collab` (collab pair).
- Always run typecheck/test through the root `pnpm typecheck` / `pnpm test` (turbo), never a package-local script (`pnpm --filter <pkg> typecheck`, `cd packages/<pkg> && tsc --noEmit` / `vitest run`) or an editor's TS server in isolation. `turbo.json` makes `typecheck`/`test` depend on `^build`, but that dependency graph only fires through turbo; a package-local script or IDE process resolves workspace siblings straight off their `dist/` (root `tsconfig.json` path-maps most packages to `dist/*.d.ts`; the rest, e.g. `@ifc-lite/pointcloud`, resolve via `package.json#types` → `dist/index.d.ts`). An unbuilt or stale sibling `dist/` then throws "Cannot find module" / missing-export errors that name real files and symbols but describe no bug in the source — rebuild (`pnpm build`) before trusting a bypass-turbo result that disagrees with `pnpm typecheck`/`pnpm test`.
- Dev viewer: `pnpm dev` (full monorepo build, then `--filter viewer dev`; needs a built `@ifc-lite/wasm`).
- Fixtures: `pnpm fixtures` (tests skip when absent). Dead code: `pnpm knip` (TS) / `cargo test --workspace` (Rust).
- Publish: `pnpm changeset`; refresh the API-surface snapshot with `pnpm api-surface:update`.

**House rules.** No `as any` / `@ts-ignore` (fix the types or add a `.d.ts`); no silent `catch {}` (log or rethrow); split production modules over ~400 non-generated lines; new packages and features ship tests; package-specific deps go in the consuming package, never root.

**Which of those a machine enforces, and which you self-police.** The TypeScript house rules above are SELF-POLICED: `tsc --strict` does not flag `as any`, `@ts-ignore` or `catch {}`, and no lint rule here does either. `pnpm lint` runs oxlint over `apps`, `packages` and `scripts`, but only its ERROR tier is a gate. Errors are the curated list in `.oxlintrc.json`: rules whose every hit in this repo was a real defect. Everything else is a warning, visible and not blocking, and a rule you never see in that config is still running at warn severity. oxlint honours `// eslint-disable-next-line <rule>` with the directive on the line DIRECTLY above the offence and a reason above that. Clear warnings in files you are already touching, never in a sweep.

**Rust is NOT self-policed.** CI runs `cargo clippy --workspace --all-targets -- -D warnings`, so a warning-only defect (an unused import, a needless borrow) is a hard CI failure even when `cargo test --workspace` is green locally, because `cargo test` does not fail on warnings. Run that clippy line verbatim before pushing Rust.

**The ~400-line rule is enforced on both sides**: for Rust by the `module_size_ratchet` test in `rust/processing/tests/`, for TypeScript by `scripts/check-module-size.mjs`. A new non-generated, non-test file over 400 lines fails unless it has an allowlist row, and an allowlisted file may not grow past its recorded budget. Prefer splitting to allowlisting. For a module whose bulk is `#[cfg(test)]`, the house pattern is a sibling `<name>_tests.rs` included via `#[cfg(test)] #[path = "<name>_tests.rs"] mod tests;` (see `stream_meta.rs`). The rule binds production modules only; test files are exempt, though a long test file should still be split where it has a genuine logical seam, never merely to hit a line count.

**Do not trust any list of CI gates written down in this file.** The authoritative list of gates is `.github/workflows/`; the authoritative list of REQUIRED ones is the `main` ruleset, `gh api repos/:owner/:repo/rulesets`. Read them. This paragraph replaced a prose copy that told agents to run clippy with `--exclude ifc-lite-wasm` and `cargo test --no-fail-fast` long after #2108 removed the exclude from CI and when no `--no-fail-fast` ever appeared in `.github/`: an agent following it ran a strictly WEAKER check than the gate and pushed red PRs believing it had verified. A gate list is a measurement, and a measurement recorded as prose goes stale by the next merged workflow.

## IFC schema fidelity
- User-facing APIs/exports/scripts use exact IFC EXPRESS names: PascalCase attributes (`GlobalId`, `Name`, `ObjectType`), full relationship names (`IfcRelAggregates`, not `Aggregates`). Never invent aliases.
- STEP type names are stored UPPERCASE; render via `store.entities.getTypeName(id)` to get `IfcPascalCase`.
- The rule binds **where an EXPRESS name exists**. A *derived* collection with no EXPRESS counterpart is named for what it holds, and renaming it to an `IfcRel*` type would be a fresh inaccuracy: `EntityRelationshipsData`'s `voids` / `fills` / `groups` / `connections` hold the related **objects**, not the `IfcRel*` entities, so they keep their names (#2422 — reasoning at the type, don't re-open). Two pre-existing camelCase surfaces are likewise frozen, not endorsed: `withAliases` (`packages/sandbox`) emits every entity attribute under both spellings, PascalCase canonical, camelCase kept because sandbox scripts have no version channel; and the built-in templates' non-entity types (`BimPropertySet.name`, `BimModelInfo.name`, …) are plain data-shape fields. New surface still gets the EXPRESS name, once.

## Models & federation
- **One canonical load path:** every model, primary *and* federated, any format, loads via `useIfcLoader.loadFile(file, target)`; `useIfcFederation.addModel` is a thin wrapper. Never add a second load/ingest pipeline: a federated-only path that drifts from `loadFile` silently skips load-time features.
- Resolve selections/IDs through `FederationRegistry` (`toGlobalId`/`fromGlobalId`/`getModelForGlobalId`), never ad-hoc math; honor the single-model fallback `globalId === expressId`. Verify behaviour at `models.size` of 1 *and* N.
  - **Resolving a globalId back to a model+expressId is the exception: use `modelSlice.resolveGlobalIdFromModels`** (via `resolveEntityRef`, the canonical caller), not the registry. Two reasons, and the first applies always, not just in a narrow window: the registry knows nothing about **overlay-allocated ids**, so an entity created through `StoreEditor` fails to resolve through it entirely — `modelSlice.ts`'s second pass consults `mutationViews` precisely for that. It is also store-backed rather than a singleton, so it cannot be stale right after a model swap. `toGlobalId` and the registry rule above still stand for everything else; do **not** hand-roll the offset arithmetic as a third copy.
- `extractEntityAttributesOnDemand` re-parses the source buffer, so never call it in loops; use cached `EntityNode` getters.

## Geometry & WASM
- Free every WASM handle (`MeshCollection`, `MeshDataJs`, pre-pass cache) deterministically: wrap pre-pass + job batches in `try/finally` so `.free()` / `clearPrePassCache()` run on early return, on throw, **and** when an async generator is abandoned (`.return()` runs `finally`). Getters copy into JS arrays, so `.free()` right after extraction is safe; don't deep-copy already-extracted meshes.
- Coordinates: IFC is Z-up, the viewer is Y-up (converted during mesh parsing). `/api/create` (the `ifc-lite view` CLI REST endpoint) expects IFC Z-up `[x, y, z]`.
- CSG: the **pure-Rust exact kernel** (`rust/geometry/src/kernel/`) is the only CSG kernel on every target; Manifold C++ and the BSP port are deleted, and there is no kernel selection, build-time or runtime. Diagnostics: `csg::take_csg_census()`, `GeometryRouter::take_csg_failures()` / `take_host_opening_diagnostics()`.
- All per-element mesh production converges in `produce_element_meshes` (`rust/processing/src/element.rs`), called by both the native orchestrator and the browser batch (`processGeometryBatch`). Any mesh-shape change (void cut, submesh split, texturing, type geometry) lands there once; a fix applied to only one pipeline silently diverges (the bug class behind #858/#913/#957/#961/#1071). The only sanctioned behavioural fork is `TypeGeometryMode`.
- Workspace `[profile.release]` sets `panic = 'abort'`; harnesses/examples that need `catch_unwind` (per-element panic isolation) must build with `--profile server-release` (panic=unwind).
- Driving `GeometryRouter` directly in examples/harnesses skips the RTC rebase: georeferenced models (>10 km coords, e.g. ISSUE_098 at ~5,000 km) produce f32-fabricated geometry "failures"; bucket by coordinate magnitude or rebase before blaming the kernel.
- Colour and coordinate resolution is canonical Rust shared by the server (`process_geometry`) and viewer (`process_geometry_batch`) so they can't drift; don't re-fork it. Single homes: `default_color_for_type`, `resolve_submesh_color`, **`extract_surface_style_colors`** (the IfcSurfaceStyle to Rendering to Colour leaf; SurfaceColour is the apparent colour, a distinct DiffuseColour IfcColourRgb is only `shading_color`, per #859/#871), and the indexed-colour resolvers, all in `ifc_lite_processing::style`; **`rotation_angle_about_z`** (site/building rotation, off `resolve_scaled_placement`) in `ifc_lite_geometry`. `styling_parity` Rust tests fail the build if a duplicate `get_default_color*` table or a per-pipeline `extract_color_from_rendering`/`extract_color_rgb` reappears. New type default: edit `default_color_for_type` and extend the mesh fixture. Sanctioned exceptions: the 2D drafting palette in `section-2d-overlay.ts` (`PARITY-ALLOW`) and standalone debug tools under `rust/geometry/examples/` (can't reach the downstream crate). (#913, #996, #997)
- Cross-platform determinism is enforced weekly by `.github/workflows/determinism.yml` (free `ubuntu-24.04-arm` runner, also `workflow_dispatch`-able before kernel-sensitive merges): it re-runs `exact_predicate_determinism` and `geometry_correctness_harness` on arm64 against the committed x86_64-generated insta snapshots; a snapshot mismatch there means platform-dependent geometry (a real bug, not flake). It also pins the mesh-output manifests `rust/processing/tests/manifests/mesh_determinism.json` (x86_64/arm64) and `mesh_determinism.wasm32.json` (identical except the documented libm-trig gap), so a legitimate geometry-output change must re-pin **both** manifests, not just the snapshots (#1492, see `docs/architecture/mesh-determinism.md`).
- Geometry-affecting PRs also run `.github/workflows/ifcopenshell-parity.yml` (path-gated): a per-PR quick lane diffs ifc-lite against committed reference dumps in `tools/ifcopenshell_reference/`, plus a nightly full lane on the pinned engine. **It IS blocking**: `parity (in-tree fixtures, committed reference)` is one of only two contexts in the `main` ruleset, so a legitimate output change means regenerating the committed reference in the same PR (#1519). Being absent from `test.yml`s `needs:` list is a different thing from being non-required, and this line asserted the opposite until the ruleset was read.

## Performance
- **Perf-sensitive paths:** `rust/geometry`, `rust/processing`, `rust/core`, `packages/geometry`, `packages/wasm`, `scripts/build-wasm.sh`. A change under these must carry a perf verdict in the PR.
- **Read the ledger before optimizing:** `scripts/perf/README.md` (lever ledger) lists shipped wins, dead ends, and un-shipped levers. Do **not** re-spike a listed dead end without a genuinely new mechanism — isolated microbench wins have been refuted end-to-end three times (#1429 threaded WASM, Manifold, #1445 shared-index). A perf claim is only real as an **end-to-end worker-pool number**, never a kernel-only microbench.
- **Measure base-vs-branch, never vs the committed baseline.** Run `scripts/perf/probe.sh <fixture> --iters 5 --json` on both your base and your branch, and paste the parse/geometry/total deltas **plus a byte-identity statement** (mesh/triangle counts unchanged, or an FNV hash if outputs may legitimately differ). Default fixture: `tests/models/ara3d/AC20-FZK-Haus.ifc`; for CSG/void/mesher changes also run `tests/models/ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc`, and when feasible a heavy CSG model (Holter/ISSUE_053) since CI never touches that class and that is where every shipped regression has lived.
- **Never cite a local `pnpm benchmark:check` against `tests/benchmark/baseline.json` as evidence** — the baseline is CI-recorded (SwiftShader), so faster local hardware makes it vacuously green. Use the scratch-baseline flow in `tests/benchmark/README.md`.
- **Guard against contaminated measurement:** confirm `packages/wasm/pkg/ifc-lite_bg.wasm` is newer than your `rust/` edits before trusting a WASM number (stale artifacts and turbo overwriting `pkg/` have each caused phantom regression hunts); run each A/B interleaved on an otherwise-idle machine; in the browser, load the target file **first** in a fresh tab (the 7th load in a session runs 2-4x slower from memory pressure, not code).
- **Record the verdict in the repo, not chat.** When a perf PR closes with a measured result, record the *verdict and lesson* (what won/lost and why, so the next agent doesn't re-walk it) in the `scripts/perf/README.md` ledger in the same PR. This is distinct from the *numeric baseline*, which lives only in the generated `perf-numbers` region of `docs/guide/performance.md` (see Documentation upkeep) — the ledger carries the narrative, the docs carry the numbers; don't duplicate a benchmark figure into the ledger prose.

## Build, CI & generated artifacts
- Don't hand-edit `packages/wasm/pkg/*`: change the Rust crates and regenerate with `scripts/build-wasm.sh`. The wasm **runtime** (`.wasm`/`.js`) is gitignored and rebuilt on every Rust-capable host; the **type surface** `pkg/ifc-lite.d.ts` is **committed** (force-added past the wasm-pack `pkg/.gitignore` `*`) for the wasm-free typecheck lane (#952), so `pnpm typecheck` runs **without the Rust toolchain** (`tsconfig.json` path-maps `@ifc-lite/wasm` to `pkg/ifc-lite.d.ts`, and `build-wasm.sh` soft-skips when wasm-pack is absent). `build-wasm.sh` strips the platform-variant `__wasm_bindgen_func_elem_*` trampoline indices from the `.d.ts` so the sync gate can exact-diff across macOS/Linux, so only ever regenerate it via that script. When a Rust public-API change alters the bindings, re-run `build-wasm.sh` and **commit** the regenerated `pkg/ifc-lite.d.ts`; CI (`test.yml`, "Verify committed wasm types are in sync") fails if it drifts. `build-wasm.sh` also rewrites `pkg/README.md` and `pkg/package.json`, which is why **neither is tracked** — they fall under the `pkg/.gitignore` `*` like the runtime, so the churn can no longer reach a commit. Nothing reads them: the workspace member is `packages/wasm/package.json` (a different package name, and its `files` ships only the runtime plus the `.d.ts`), and the package README the docs gate checks is `packages/wasm/README.md`.
- The wasm build needs only the pinned Rust nightly + `wasm-pack` (the Manifold C++ / LLVM-20 cross-toolchain was removed at M9; the bundle is pure Rust). That toolchain is single-sourced in the `.github/actions/setup-wasm-build` composite action (used by `test`, `release`, `sdk-canary`, `benchmark`, `determinism`): change it there once, not per-workflow. `scripts/build-wasm.sh` itself runs directly in `test`, `sdk-canary`, and `benchmark`; `release` invokes it via `pnpm build`.
- ifc-lite ships a **web viewer** plus a headless CLI/MCP/server only; there is no first-party desktop app (removed: the `apps/desktop` Tauri shell and the viewer override-contract are gone). The desktop **capability** lives in `@ifc-lite/geometry` (`IPlatformBridge` / `NativeBridge` / `isTauri()`, `@tauri-apps/api` optional dep) for third parties building their own Tauri shell; keep it web-pure (it must never be imported on the web path, and is lazy-loaded only under `isTauri()`).
- The Rust tree is intentionally not rustfmt-clean and no CI runs fmt: never run a repo-wide `cargo fmt` (it produces a 100+ file reformat blast that buries the real diff). Format only the lines you touch.
- Beyond the server, CLI, SDK, and wasm, a fifth Rust consumer exists: the PyO3 wheel `ifclite_geom` (`rust/python`, abi3-py39). Public-API changes in `rust/core`, `rust/processing`, or `rust/geometry` can break it; `.github/workflows/python-wheels.yml` is path-gated to those crates and publishes on an `ifclite-geom-v*` tag.
- Adding or changing a sandbox bridge method (`packages/sandbox/src/bridge-*.ts`, i.e. `NAMESPACE_SCHEMAS`) also changes the generated ambient `bim` type surface, `apps/viewer/src/lib/scripts/templates/bim-globals.d.ts` (the types the built-in template scripts under that folder are written against). Run `pnpm generate:bim-globals` and commit it; CI (`node scripts/generate-bim-globals.mjs --check`, node-tests job) fails on drift. The editor completions and the LLM system prompt read `NAMESPACE_SCHEMAS` live, so the `.d.ts` is the only consumer that *can* rot — and it did: it never carried `bim.clash` (#891 → #2418) and lost two `create` parameters at #598, because the generator had stopped running and the file got hand-edited instead. Never hand-edit it; fix the schema and regenerate.
- A `tsReturn` / `tsParamTypes` may NAME a type instead of spelling its shape inline (`Promise<BimClash.ClashResult>`). Those declarations are extracted from their defining package by `scripts/generate-bim-globals.mjs` (`DERIVED_TYPE_SOURCES` / `DERIVED_TYPE_ROOTS`) — never transcribe another package's types into the generator, which would be a hand-maintained copy in the one script whose purpose is to stop copies rotting (#2422). Referencing a type the generator cannot resolve is a hard error telling you which list to add the file to. `pnpm check:templates` (node-tests job) typechecks the built-in templates against the generated surface and is what catches a `tsReturn` naming a type that is never emitted; its tsconfig keeps `skipLibCheck: false` on purpose, because the generated `.d.ts` is the subject of that check rather than a dependency of it.
- `Cargo.lock` is committed (app crates need reproducibility; an upstream yank broke CI once). Refresh with `cargo update -p <crate>`, never by deleting it.
- Pushing a PR branch does **not** spin up a Vercel preview: preview builds on the Rust+WASM projects (`ifc-lite` viewer, `ifc-lite-viewer-embed`) are turned off via each project's Ignored Build Step to save build minutes (`main` still deploys to production). To preview a branch, trigger it on demand: `vercel link` (once per app dir; `.vercel` is gitignored) then `vercel deploy` (`--prod` to promote); `vercel build && vercel deploy --prebuilt` both skips the remote WASM compile and is never gated by the Ignored Build Step. Per-project setup and rationale: [`scripts/README-vercel-cost.md`](./scripts/README-vercel-cost.md) section 3d.

## Documentation upkeep
- A public API or CLI flag change updates the matching guide in the **same PR**. `docs/guide/*.md`, `docs/tutorials/*.md`, and the README carry live `ts`/`typescript` snippets that CI typechecks against each package's `src` (`pnpm docs:check-samples`), so a renamed export or changed signature fails the build until the snippet is fixed. Snippets use shared ambient globals (`scripts/docs/doc-samples-globals.d.ts`); a snippet that is deliberately illustrative pseudo-code opts out with `<!-- docs-check: skip -->` on the line directly above the fence (use sparingly — prefer fixing it).
- Perf and size numbers live **only** inside the generated `perf-numbers` region of `docs/guide/performance.md`, stamped from `tests/benchmark/baseline.json`. Don't hand-write a benchmark number into prose; refresh the region with `pnpm docs:generate` after recording a new baseline.
- The package table in `docs/api/typescript.md` and the CLI command table in `docs/guide/cli.md` are generated (`<!-- BEGIN/END GENERATED -->` regions). Edit the source (each `package.json` description, the CLI `HELP` text), then run `pnpm docs:generate`; CI (`pnpm docs:check-generated`) fails if a region is stale.
- Every new published package ships a `README.md` (it is the npm landing page); CI enforces this with `pnpm docs:check-readmes`.

## Changesets & published API
- Changes to published `packages/*` need `pnpm changeset` (never hand-edit versions or `CHANGELOG.md`). Bump level = biggest API change: removing/renaming an export is `major` (>=1.0 pkg) or `minor` (0.x), never `patch` when the surface shrank.
- Only re-export from a package's `index.ts` what has a real consumer: an unused public export is permanent semver liability.
- The exported surface of every published package is snapshotted in `scripts/api-surface.json` and CI-enforced (`scripts/check-api-surface.mjs`): when you intentionally add/remove/rename an export, run `pnpm api-surface:update` and commit the snapshot alongside the changeset.

## Removing & replacing code (anti-cruft)
- Supersede means delete: replace a path, remove the old one in the *same* PR. No "legacy"/"fallback"/"just-in-case" path; if one must stay, gate it behind `// TODO(remove-by: <cond>, <owner>)` and a tracking issue.
- Delete dead code with the change that orphans it. When renaming/removing a public symbol, grep the whole repo (`docs/`, `examples/`, `scripts/`, `*.md`) and fix every reference in the same PR.
- Prove removals: TS with `pnpm knip` (on-demand, not a CI gate); Rust with `cargo test --workspace`, **not** `cargo check` (check skips `#[cfg(test)]`, so a test-only reference to a deleted fn slips through). Intentionally-unused Rust items need `#[allow(dead_code)]` and a why.

## Test fixtures
- Not committed (no LFS): catalogued in `tests/models/manifest.json`, fetched via `pnpm fixtures`. Tests must **skip** (never throw/panic) when a fixture is absent; point to `pnpm fixtures` in the skip message. Add one: drop under `tests/models/<group>/`, run `pnpm fixtures:manifest`, then `pnpm fixtures:upload`; commit only the manifest. CI runs `pnpm fixtures` before tests.

## Bounding walks over file-supplied references

Entity references come from the file, so their shape is exporter- and
attacker-controlled. An unbounded recursive walk over one self-referential
entity dies by `SIGABRT`, which is not a catchable panic: nothing upstream turns
it into a load error, and in the wasm geometry worker it takes down the
instance. #2866 found seven such sites.

The three mechanisms are not interchangeable, and each alone leaves a hole:

- a **depth cap** bounds one path's LENGTH, not its breadth. `k` items each
  leading back into a cycle cost `O(k^depth)`, turning an abort into a hang
  (measured 7.21s at k=3). A hang is worse: nothing reports it.
- a **visited set** bounds cycles and revisits. While the walk still recurses it
  does NOT bound a long *acyclic* chain: every insert succeeds, the set never
  fires, and the stack still overflows.
- a **work budget** bounds acyclic DAG fan-out, which neither of the others
  sees. A DAG where every branch succeeds never errors and never repeats an id;
  it just emits `2^levels` outputs.

Choose the visited set's SCOPE by what the walk returns:

- **global / memoising** when the result is a pure function of the id (a colour
  is determined by item id plus style map). Safe and strictly stronger: it kills
  fan-out outright.
- **path-scoped** (insert on the way in, remove on the way out) when output
  ACCUMULATES. A boolean operand tree is a DAG and geometry accumulates, so the
  same node down two branches is two real pieces of geometry. A global set
  silently drops the second: **missing geometry, not a cycle guard**, and no
  termination test notices.

Prefer making the walk **iterative** over adding a cap: with no stack to consume
there is nothing left for a cap to protect, and the visited set becomes
sufficient alone. A cap tight enough to stop a cycle usually rejects legitimate
input — #960 records Revit `FirstOperand` chains 42 nodes deep.

Reuse the shared bound where the chain is shared: `ifc_lite_core::limits`.

A guard that both ACTS and REPORTS has a two-part contract — bound the work, and
report that you bounded it. Mutate the halves separately; they fail differently
(a missing bound hangs, a missing report returns a truncated success).

`scripts/check-refwalk-guards.mjs` (CI) enforces the *presence* of a guard, not
its choice: it fails when a self- or mutually-recursive function, or a
cursor-chasing loop, reaches `decode_by_id`/`resolve_ref`/`resolve_ref_list`
under `rust/geometry/src`, `rust/processing/src` or `rust/wasm-bindings/src`
with no visited set, path stack or depth cap in scope. Five of the six #2866
fixes are detected at their parent commit and clear at the fix; the sixth
(#2870) spans two files and is missed, which is the documented blind spot. Which
guard is right stays a review question — everything above still applies. The
allowlist is `scripts/refwalk-guard-allowlist.txt` and is empty.

## Writing tests
- A new test must assert behavior through a real fixture or a stated invariant. Don't write: set-state-then-read-it-back store tests, tests that assert a mock's return value (they test the mock), constructor/setter tautologies, or byte-for-byte output pinning unless the byte layout IS the compatibility contract (e.g. signed bundles). Regression tests cite the issue/PR number in the test name or a comment.
- Every package with test files needs a `test` script in its package.json or `turbo test` silently skips it; `scripts/check-test-wiring.mjs` (CI) enforces this. Packages use vitest OR node:test via `tsx --test`; match the package's existing convention, never mix within a package.
- **A new gate under `scripts/` must be INVOKED, and a package.json entry is not invocation.** A guard nothing runs is the same absence as a guard that finds nothing, and it is invisible in exactly the same way: #3062 shipped a gate script and its test with no workflow step, no `package.json` script and no turbo task, and nothing flagged it.

  `scripts/check-test-wiring.mjs` audits `scripts/` — every `check-*` / `verify-*` file at **any depth** and in `.mjs`, `.js` or `.cjs` (`verify-npm-publish.js` and `check-benchmark-regression.js` are real gates, and `scripts/ci/` is exactly where the advice "move it to a covered directory" puts a file). It accepts exactly the wiring this repo actually uses: a `.github/workflows/` step running `node scripts/<gate>.mjs` (the common case, see the `node-tests` job); a root `package.json` script a workflow reaches through `pnpm <name>`, possibly transitively (`check-changesets.mjs` <- `lint` <- the Lint job); a **workspace** package's script reached by a turbo task (`check-tla-chunk-await.mjs` is the viewer `build` script's tail, deliberately, so Vercel runs it too and not only CI); or a file that an already-reached script imports or spawns (below the top level a `verify-*` name is as often a module as a gate: `moonshot/diff-spike/verify-common.mjs` is imported by the workflow-wired `verify-trajectory.mjs`, and a file a running gate runs does run). A root `package.json` entry no workflow ever calls executes exactly as often as no entry at all, and is rejected.

  `scripts/*.test.mjs` is audited separately from the gate itself. The `node --test scripts/*.test.mjs scripts/lib/*.test.mjs` catch-all covers those two directories and no others, because a shell glob has no `**`, and a gate whose test runs while its script never executes is still the #3062 failure.

  A script that genuinely should not run in CI declares `@unwired-by-design <reason>` in its own header and is then listed in the checker's OK output rather than hidden. Today that is `check-generated.mjs` (a pre-push aggregator of gates CI already runs), `check-git-lfs.mjs` (reports on the developer's own clone), `check-whole-state-reset.mjs` (an unadopted heuristic, issue #2802) and `moonshot/b45-m1-midterm/verify-worker.mjs` (a worker of a hand-run benchmark). The marker is a blanket escape and nothing judges the reason's quality, so its only safeguard is that every declaration is printed and lives in the diff. STATED HOLES: the check is lexical and does not evaluate workflow expressions, so a gate whose only step sits in a job with `if: false` still counts as wired; and `audit-*.mjs` reports rather than gates, so it is not demanded.
- **Never assert on a source file's text.** A test that reads `Thing.tsx` and greps it certifies a string exists, not that the code works: `SearchModal.filter.wiring.test.tsx` asserted the whole body of `handleRowClick` and stayed 5/5 green when `onRowClick={handleRowClick}` was replaced with `onRowClick={() => {}}` — defect #2396 verbatim. `scripts/check-source-text-assertions.mjs` (CI) blocks new ones; the remaining list is in `scripts/source-text-assertion-allowlist.txt` and only ratchets down (#2434).
- **Testing a viewer component.** It is mountable — including one that reads `useViewerStore`, which is a module-level Zustand store you seed with `setState`. Three test files claimed otherwise for months; the real blockers were two Vite-isms, fixed once in `apps/viewer/src/test/`. The recipe:
  ```tsx
  import '@/test/setup-dom.js';               // MUST be first: registers happy-dom
  import { installLayout } from '@/test/dom-layout.js';
  installLayout();                            // only if it virtualizes or measures
  import { render, click, advance, cleanup } from '@/test/render.js';
  import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';

  useViewerStore.setState({ ...fixtureModels(fixtureModel('m', { idOffset: 1_000_000 })) });
  const ui = render(<YourPanel />);
  click(/* what a user clicks */);
  assert.equal(useViewerStore.getState().selectedEntityId, expected);
  ```
  `~icons/*` (unplugin-icons virtual modules) and `import.meta.env` are handled by `src/test/vite-module-hooks.mjs`, registered from the `--import` flag in the viewer's `test` script — it cannot be registered from inside a test file, because module resolution finishes before any module body runs. `installLayout()` also makes `ResizeObserver` deliver an entry: happy-dom ships the class but never fires it, which is why a virtualized list otherwise renders zero rows.
  Four more surfaces were said to be unmountable and are not (#2434): `MainToolbar`, `RibbonToolbar` and its tabs mount as-is; `FileTab` needs its `fileCommands` prop; `PropertiesPanel` and anything reading a `ModelQuery` needs a REAL store (`new IfcParser().parseColumnar(...)` over a few inline STEP lines — see `tools/measure-parity.test.tsx`), not a cast stub; `ViewportContainer` needs a stubbed `navigator.gpu` plus one loaded model, or it renders the "WebGPU Not Available" screen. A Radix dropdown opens on `pointerdown` (then `click`) and portals its items onto `document.body`, so query them there, not inside the container. `RibbonLargeButton` sets `aria-label={tooltip ?? label}`, so match its visible text when it has a tooltip.
  Assert on the OUTPUT, not on the wiring: `<Thing />` written into a panel but never reached, a hook whose result is ignored, and a handler that nothing invokes all read correctly in source. Every conversion under #2434 that asserted "the component is present" instead of "its numbers appear" survived deleting the component — one shipped that way and was caught only by mutation.
- Geometry/WASM changes: mocked `@ifc-lite/wasm` tests prove nothing about the boundary; `pnpm test:wasm-contract` runs the real `buildPrePassOnce`/`processGeometryBatch` path and pins the field surface plus unit-scale contract. Extend it when adding wasm API surface. It skips clean (exit 0) if the wasm runtime isn't built, so a local green there proves nothing unless you ran `scripts/build-wasm.sh` first (CI restores the built artifact before the step).

## CLI
- Discover the full SDK API with `ifc-lite schema` (JSON). `eval` runs SDK expressions (`ifc-lite eval model.ifc "bim.query().byType('IfcWall').count()"`); always pass `--json` for machine output. `HeadlessBackend` (`packages/cli/src/headless-backend.ts`) runs query/export/create/IDS/BCF without a renderer.

## Collaboration server
- `collab-server` (`packages/collab-server`) persists CRDT state (Yjs update frames plus room/audit logs) to disk, so a persistence-format change needs legacy migration or you poison existing rooms (a data-loss class, #1501). Exercise the pair with `pnpm test:collab` (beyond `turbo test`); run the server with `pnpm collab:server`. Recipients rebuild the model from the CRDT via IFCX (`snapshotToIfcx` then `parseIfcxViewerModel`), not a legacy STEP transport.

## Browser exports (viewer)
- One way to save a file: `apps/viewer/src/lib/export/download.ts`. Use `downloadBlob` / `downloadFile` / `downloadDataUrl`; never hand-roll an `<a download>` plus `URL.createObjectURL` dance, and never write another filename regex. `downloadFile` already copies the wasm `Uint8Array<ArrayBufferLike>` into a `BlobPart`, and emits `emitFileDownloaded` (`lib/tours/events`) so task-gated tours can observe saves; a bespoke download path breaks tour progression, not just filename handling.
- Run every user/model-derived filename through `sanitizeFilename` (preserves case and dots, strips only OS-unsafe chars, see #1299). It is *not* a slug; don't lowercase or hyphenate names for filenames. Slugs (extension IDs) are a separate concern.
- CSV and list exports neutralize spreadsheet formula injection on user-derived cells, including BOM-prefixed values (#1506). Route any new export column through the existing sanitizer; never hand-roll a CSV writer that skips it.

## Tour anchors & demo kit (viewer walkthroughs)
- Elements carrying `data-tour` are interactive-tour anchors. If you move, rename, or delete one, update `apps/viewer/src/lib/tours/anchors.ts` and the referencing steps under `apps/viewer/src/lib/tours/tours/` in the same PR. A broken anchor does not fail CI: it auto-skips at runtime and fires a `tour_step_broken` PostHog event, so rot surfaces on the dashboard, not in review. Tour telemetry (`lib/tours/telemetry.ts`) carries only registry ids, enums, and numbers, never file or model names (scrub-safe).
- The tour demo kit reuses the committed `building-architecture.ifc` sample as its base; its variants (`building-architecture-rev-b.ifc`, `building-architecture.ids`, `demo-kit.json`) are derived from that base by `tools/demo-kit/derive-variants.mts`. Revision B preserves the base's GlobalIds (diff matches on GlobalId, so a regenerated base would make compare read as 100% added/deleted) and carries the injected clash. Never hand-edit or regenerate one artifact in isolation; rerun the derivation script, which self-verifies the IDS/clash/diff invariants.

## This repository is public
- Everything here is world-readable the moment it is pushed: code, docs, comments, commit messages, PR titles and bodies, changesets, issue text. Write as if a competitor and a client are both reading, because they are.
- Never name a client, customer, prospect, or partner organisation, and never describe a commercial relationship (engagement, contract, statement of work, pricing, fee, or the intent to convert one into another). Use a generic segment instead: "an AEC design platform", "a desktop authoring client", "an enterprise buyer".
- The same rule applies to anything a named party would consider non-public: their customer base or buyer profile, internal or unreleased API schemas, unreleased product plans, architecture they have not published, and any data they supplied.
- This binds commit messages and PR text as much as file contents. A commit that removes a client name but explains itself by naming the client has published it again.
- Roadmap, strategy and ecosystem docs are the usual offenders, because naming a real partner feels like it makes the argument concrete. It does not; the generic segment carries the same argument. If a claim only works with the real name attached, it belongs in a private repo.
- If you find such a reference, remove it and say so without repeating it. Removing it from the working tree stops further publication but does not erase git history, so flag it rather than assuming the fix is complete.

## New source files
- MPL-2.0 header on every new file: see [`./LICENSE_HEADER.md`](./LICENSE_HEADER.md).

## Claiming work

**Respect assignments, and assign yourself before you start.** This is not etiquette, it is the mechanism that stops two people building the same thing.

Before touching an issue:

1. `gh issue view <n> --json assignees,title` — **if someone else is assigned, it is theirs.** See "Helping on someone else's issue" below for the two ways that changes.
2. Look for an open PR on it. `gh pr list --search "<n>"` is a TEXT search: it
   matches comment bodies, so it both misses linked PRs that never mention the
   number and returns unrelated ones that happen to contain it. Treat a hit as a
   reason to look, not as an answer, and confirm by opening the PR. The linked-PR
   list on the issue page is authoritative where the two disagree.
3. If both are clear, `gh issue edit <n> --add-assignee <you>` **before** writing code, not when you open the PR. An assignment made at PR time claims nothing; the window it needed to cover has already closed.

Check again immediately before opening the PR. A claim can appear while you work, and the second check is the cheap one.

### Every agent is the same GitHub account

`gh issue edit --add-assignee` cannot tell two agents apart: they all push and assign as the **same account**. An assignment to that account means *somebody* claimed this. It does not mean *you* did, and the field cannot tell you which. So treat it as a claim by someone else until you can show otherwise, and **leave a claim comment naming the session**, which is the only artifact that can:

    gh issue comment <n> --body "Claiming this. Session <id>, branch <name>."

If the account is assigned with no claim comment, ask on the issue rather than reading the field as your own. This applies to OUR sessions only. An outside contributor has their own account, so for them the field says what it appears to say.

### The contributor check and the session check are different checks

Doing one does not do the other. Run both, every time:

    gh issue view <n> --json assignees      # is one of us on it
    gh pr list --search "<n>"               # CANDIDATES; confirm on the issue page

That search is TEXT: it misses linked PRs that never name the number and returns
unrelated ones that do. A hit is a reason to look, not an answer; the issue's
linked-PR list is authoritative where they disagree.

On #3012 the account was self-assigned and a PR appeared 47 minutes later. That looked like a session ignoring the claim; it was an outside contributor, who has no reason to know about an internal assignment. No assignee field would have helped, because no session held it. Only the PR search would have.

### When you collide mid-flight

The expensive case is that both of you are already half-built when the claim appears. **The session named in the earliest claim comment decides. The other stops immediately** and hands over what it has as a comment or a patch on that session's PR. "The assignee decides" cannot work here, because the field holds one shared account and cannot name a session.

**An outside contributor's PR takes precedence over any internal claim, however early.** They cannot see our claims and are not bound by them. Stopping mid-build is cheap; two finished implementations of the same thing is not.

### Helping on someone else's issue

Helping is welcome. **Taking over is not.** Two things make it help: they accepted an offer (silence is not a yes), or it has gone quiet (no commits, no word, about a week; even then comment first and wait a couple of days).

Help, no permission needed: reviewing their PR including finding real defects; diagnosing a failing check and posting the cause; answering a question they asked; reporting a defect in shipped code even if their PR introduced it.

Not help, however good the code: building a parallel implementation and announcing it afterwards; carrying an unraised branch that duplicates their work; pushing to their branch; opening a competing PR on their issue.

If you built something before noticing, say so plainly, hand it over, and let them decide. That is recoverable; landing it is not. When you find you have duplicated someone, the owner follows the rules above in
order: an outside contributor's PR beats any internal claim; else the earliest
claim comment wins; the assignee field decides only when neither applies, since it
cannot name a session. Never whoever is further along or noticed first. Do not
close the duplicate silently: enumerate what it holds that the survivor does not,
and never push to a branch you do not own to "help".

This rule exists because it was broken twice in two days against the same external contributor (#2951 filed, assigned and implemented by them as #2952, with #2970 arriving fifteen hours later doing the same thing; and #2670, where they were mid-development when told a parallel implementation existed). The cost is not the wasted effort. It is that a contributor who did everything correctly had to be the one to raise it, twice.

Applies to every agent and every session, including short-lived subagents.

## Delegating to subagents
- Any delegated agent must obey this file: use the canonical load/geometry/export paths here, preserve IFC EXPRESS names, add no second load path, and prove changes with the narrowest local verification command. Treat delegated implementation output as a patch proposal until `git diff` plus local verification pass.
- Keep the orchestrator's context clean: delegate token-heavy filesystem work (broad search, log triage, fixture inspection, first-pass test repair) and get back a concise summary (files changed, commands run, result, risks), not raw logs or fixture dumps.
- The Fable 5 / Codex orchestration playbook (effort policy, subagent model routing, `codex exec` recipes, `/codex:*` commands, handoff hygiene) lives in [`./ORCHESTRATION.md`](./ORCHESTRATION.md).

## Per-package notes
This root file is the shared contract; the closest `AGENTS.md` to an edited file also applies. Package-specific gotchas live in code-adjacent files: [`apps/viewer/AGENTS.md`](./apps/viewer/AGENTS.md), [`rust/AGENTS.md`](./rust/AGENTS.md), [`packages/geometry/AGENTS.md`](./packages/geometry/AGENTS.md), [`packages/collab/AGENTS.md`](./packages/collab/AGENTS.md), [`packages/collab-server/AGENTS.md`](./packages/collab-server/AGENTS.md). Add more as a package accumulates its own footguns.
