# Agent Guidelines: ifc-lite

## 1. Mandatory Schema Compliance
- **Strict Nomenclature:** Use exact IFC EXPRESS names in user-facing APIs, scripting, and exports. Never invent simplified aliases.
- **Attributes:** Use IFC PascalCase (`GlobalId`, `Name`, `Description`, `ObjectType`, `Type`) as the default user-facing shape.
- **Relationships:** Use full IFC relationship entity names (e.g., `IfcRelAggregates`, **not** `Aggregates`).
- **Type Casing:** STEP entity names are stored as `UPPERCASE`. For display/API output, use `store.entities.getTypeName(id)` to return proper `IfcPascalCase`.

## 2. Critical Performance Patterns
- **On-Demand Extraction:** `extractEntityAttributesOnDemand` parses the source buffer and is expensive. **Never** call it in large loops; use cached `EntityNode` getters instead.
- **Federation-Aware IDs:** Always distinguish `localExpressId` from federated `globalId`; convert via `FederationRegistry` methods (`toGlobalId`, `fromGlobalId`, `getModelForGlobalId`), never ad-hoc math in UI code.

## 3. Mandatory Workflows
- **License Headers:** Every new source file must include the MPL-2.0 header documented in [`./LICENSE_HEADER.md`](./LICENSE_HEADER.md).
- **Changesets:** If changes affect published `packages/*`, add a changeset with `pnpm changeset`. Never manually edit package versions or `CHANGELOG.md`. **The bump level must match the biggest API change in the PR:** removing or renaming a published export is `major` for ≥1.0 packages and `minor` for 0.x packages — never default to `patch` when the public surface shrank. Sanity-check with `pnpm changeset status`.
- **Generated Artifacts:** Do not edit generated WASM JS/TS declaration outputs in `packages/wasm/`; make source changes in Rust crates and regenerate. A local `scripts/build-wasm.sh` run also rewrites `packages/wasm/pkg/README.md` and `pkg/package.json` (version bump + copied README) — that churn is generated, so `git checkout` those two files before committing.
- **CI toolchain consistency:** `scripts/build-wasm.sh` cross-compiles `manifold-csg-sys` for wasm32 and needs the pinned Rust toolchain, `wasm-pack`, and clang/LLVM-20. It runs in **four** workflows — `test.yml`, `release.yml`, `desktop-compat.yml`, and `sdk-canary.yml`. When you change its toolchain requirements (Rust channel, `wasm-pack`, LLVM/clang version), update **all four** in the same PR. Otherwise one drifts and only fails when its path filter happens to trigger — exactly how `sdk-canary` shipped without LLVM-20 and went red on an unrelated PR. (A reusable composite action to single-source this is a planned follow-up.)

## 4. Single-Model vs Federated-Model Correctness (Common Failure Mode)
- **Treat both modes as first-class:** Code must work when there is exactly one model *and* when multiple federated models are loaded.
- **Use canonical resolution path:** Resolve selections/IDs through `FederationRegistry` (`toGlobalId`, `fromGlobalId`, `getModelForGlobalId`) rather than assuming federation map state.
- **Honor fallback behavior:** If federation lookup misses, support single-model fallback (`globalId === expressId`).
- **Do not hardcode multi-model assumptions:** Avoid logic that only works when `models.size > 1`; verify behavior for `models.size` of `1` and `N`.

## 5. CLI Toolkit (`@ifc-lite/cli`)
- **Headless BIM operations:** Use `ifc-lite` CLI for terminal-based IFC file operations without a browser/viewer.
- **Discovery:** Run `ifc-lite schema` to get the full SDK API as JSON (16 namespaces).
- **Key commands:** `info` (summary), `query` (filter entities with `--all` for full data), `props` (entity details), `export` (CSV/JSON/IFC), `ids` (validation), `bcf` (collaboration), `create` (generate IFC, 30+ element types), `merge` (combine IFC files), `convert` (schema version conversion), `diff` (compare files), `validate` (structural checks), `bsdd` (Data Dictionary lookup), `eval` (SDK expressions), `run` (execute scripts), `schema` (API reference), `stats` (entity statistics), `mutate` (modify entities), `ask` (AI-assisted queries).
- **Machine-readable output:** Always use `--json` flag for structured JSON output. Stdout = data, stderr = status messages.
- **`eval` is the power tool:** `ifc-lite eval model.ifc "bim.query().byType('IfcWall').count()"` — the `bim` object exposes the full `@ifc-lite/sdk` API.
- **HeadlessBackend:** `packages/cli/src/headless-backend.ts` implements `BimBackend` without a renderer. Viewer-specific operations are no-ops; query, export, create, IDS, and BCF work fully.

## 6. 3D Viewer (`@ifc-lite/viewer`)
- **Separate package** (`packages/viewer`) — browser-based 3D visualization. All headless CLI commands work without it.
- **Full API reference:** See [`docs/guide/viewer-api.md`](./docs/guide/viewer-api.md) for launch options, REST API, element creation, and analysis overlays.
- **Coordinate convention (coding-relevant):** IFC uses Z-up; the viewer uses Y-up internally. The geometry layer converts automatically during mesh parsing. When using `/api/create`, pass coordinates in IFC Z-up convention (`[x, y, z]` where Z is up).

## 7. Code Quality Standards (Non-Negotiable)

### No `as any` or `@ts-ignore`
- **Never** use `as any` to silence the compiler. If types don't align, fix the types (add proper generics, declare interfaces, write `.d.ts` stubs for untyped libraries).
- **Never** use `// @ts-ignore` or `// @ts-expect-error` without a linked issue explaining why and a plan to remove it.
- If an external library lacks types, write a minimal ambient declaration file (`foo-types.d.ts`) instead of scattering `@ts-ignore` across call sites.

### No bare `catch {}`
- Every `catch` block must either log the error or re-throw. Silent swallowing hides real bugs.
- The only exception is cleanup code where failure is truly irrelevant (e.g., `mesh.free()`), and even then add a `/* cleanup — safe to ignore */` comment.

### File size limit: ~400 lines per module
- If a file exceeds ~400 lines of non-generated code, split it. Extract cohesive helpers into separate modules.
- Generated files (e.g., `schema-registry.ts`, `entities.ts`) are exempt.

### Tests required for new packages and features
- Every new package **must** ship with at least one test file covering its public API.
- New features in existing packages must include tests. PRs adding untested logic to `ids`, `query`, or `cli` should be blocked.
- Do not use `--passWithNoTests` for any package.

### Dependencies in the right place
- Root `package.json` dependencies must only contain tooling shared by all workspaces (turbo, typescript, changesets).
- Package-specific deps (database drivers, domain libraries) go in the consuming package's `package.json`, never the root.

### Undeclared class properties
- Never use `(this as any).foo` to store state. Declare all properties in the class body with proper types.

### WASM handle lifetimes
- Every WASM handle (`MeshCollection`, `MeshDataJs`, the pre-pass cache) must be freed deterministically. Wrap pre-pass + job-batch usage in `try/finally` so `clearPrePassCache()` / `.free()` run on early return, on a thrown error, **and** when an async generator is abandoned (its `.return()` runs `finally`).
- The mesh getters copy into JS-owned typed arrays, so it is safe to `.free()` each handle immediately after extracting its data — and retaining the extracted `MeshData` across batches is safe (it is no longer a live view into WASM memory). Do not add redundant deep-copies of already-extracted meshes.

## 8. Rust Dependency Policy
- **`Cargo.lock` is committed.** This workspace mixes libraries (`rust/core`, `rust/geometry`, etc.) and application binaries (`apps/server`, `apps/desktop/src-tauri`). App crates need a committed lockfile to stay reproducible, and CI runs a fresh resolve on every build — without a lockfile, any upstream yank instantly breaks the pipeline. See commit history for the `core2` incident (every published version yanked in 2025) that motivated this decision.
- **Don't delete `Cargo.lock` to "refresh" dependencies.** Use `cargo update -p <crate>` for targeted upgrades, or `cargo update` for a full refresh. Review the resulting lockfile diff before committing.
- **`[patch.crates-io]` lives in the workspace root `Cargo.toml`.** Local patch targets go under `rust/vendor/<crate>/`. Every vendored stub must explain, in its own `src/lib.rs` header comment, why it exists and the exact upstream condition that would let it be deleted.
- **Don't silently bump dep ranges.** Major or patched-version crossings should be called out in the PR description so reviewers can sanity-check for behaviour changes.
- **Prove Rust removals with `cargo test`, not just `cargo check`.** `cargo check` on the wasm `cdylib` target does not compile `#[cfg(test)]` modules, so a removed function still referenced by a test slips through a check-only verification. Run `cargo test --workspace` before claiming a Rust deletion is clean. Items intentionally kept unused (e.g. for native/wasm parity) must carry `#[allow(dead_code)]` plus a comment stating why.

## 9. Test Fixtures

- **No Git LFS.** IFC and IFCX fixtures live under `tests/models/` but are
  *not* committed. They're catalogued in `tests/models/manifest.json`
  (path + sha256 + size) and fetched from a GitHub Release on demand via
  `pnpm fixtures`. See [`tests/models/README.md`](./tests/models/README.md)
  for the rationale and maintainer workflow.
- **Adding a fixture:** drop the file under `tests/models/<group>/`,
  run `pnpm fixtures:manifest` to regenerate the catalogue, then
  `pnpm fixtures:upload` (requires `gh` CLI write access) to publish the
  bytes. Commit only the updated `manifest.json`.
- **Tests must skip cleanly when a fixture is absent.** Use the
  `read_fixture` pattern in `rust/geometry/src/processors/tests.rs` (Rust)
  or an `existsSync` + `test.skip()` guard (TypeScript) — point to
  `pnpm fixtures` in the skip message. Never `panic!` / `throw` on
  fixture absence; that breaks fresh clones.
- **CI workflows that run tests** must run `pnpm fixtures` before the
  test step. Cache by `hashFiles('tests/models/manifest.json')` to avoid
  re-downloading on every job.

## 10. Feedback Loop
- If a pattern is confusing or repeatedly error-prone, call it out explicitly in your PR notes.
- Prefer refactors that make the correct path the easiest path (single source of truth helpers, stricter types, fewer implicit fallbacks).

## 11. Removing & Replacing Code (Anti-Cruft)
These rules exist because a single consolidation pass found ~36 pieces of dead/redundant code — old parallel paths, unused public exports, and stale docs — that each accumulated one "leave it for now" decision at a time.
- **Supersede means delete.** When you replace a code path, remove the old one in the *same* PR — never leave a second "legacy" / "fallback" / "just-in-case" path. If a path must be kept temporarily, gate it behind a `// TODO(remove-by: <condition or date>, <owner>)` and a tracking issue; "latent infrastructure" with no removal trigger is exactly how dead paths accumulate.
- **No speculative public API.** Only re-export from a package's `index.ts` what has a real consumer — in-repo, a shipped example, or documented external use. An unused public export is permanent semver liability. When you remove the last consumer of a public export, remove the export too (or justify keeping it in the PR).
- **Delete dead code with the change that orphans it.** A function, field, command, or module that loses its last caller is removed in the same PR, not "left for later."
- **Docs, examples, scripts, READMEs and benchmarks are part of the API surface.** When you remove or rename a public symbol, grep the whole repo (`docs/`, `examples/`, `scripts/`, `*.md`, tutorials, `tests/benchmark/`) and update every reference in the same PR.
- **Don't merge infrastructure ahead of its consumer.** A feature with no caller (an unused WASM export, a worker the UI never spawns) does not belong on `main`. Keep it on a branch until something uses it.
- **Run `pnpm knip` when you remove or replace code.** It reports unused files, exports, and dependencies across the workspace — run it before finishing a removal/cleanup PR (it flags orphans like a no-longer-imported module or a zero-consumer export). knip is an on-demand tool, **not** a CI gate, so a finding is a removal candidate to act on or consciously ignore, not a build failure. It does not see stale prose, so the repo-wide grep above is still required. For Rust the equivalent backstop is `cargo test --workspace` (it compiles the `#[cfg(test)]` modules that `cargo check` skips).
