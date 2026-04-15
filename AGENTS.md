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
- **Changesets:** If changes affect published `packages/*`, add a changeset with `pnpm changeset`. Never manually edit package versions or `CHANGELOG.md`.
- **Generated Artifacts:** Do not edit generated WASM JS/TS declaration outputs in `packages/wasm/`; make source changes in Rust crates and regenerate.

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

## 8. Rust Dependency Policy
- **`Cargo.lock` is committed.** This workspace mixes libraries (`rust/core`, `rust/geometry`, etc.) and application binaries (`apps/server`, `apps/desktop/src-tauri`). App crates need a committed lockfile to stay reproducible, and CI runs a fresh resolve on every build — without a lockfile, any upstream yank instantly breaks the pipeline. See commit history for the `core2` incident (every published version yanked in 2025) that motivated this decision.
- **Don't delete `Cargo.lock` to "refresh" dependencies.** Use `cargo update -p <crate>` for targeted upgrades, or `cargo update` for a full refresh. Review the resulting lockfile diff before committing.
- **`[patch.crates-io]` lives in the workspace root `Cargo.toml`.** Local patch targets go under `rust/vendor/<crate>/`. Every vendored stub must explain, in its own `src/lib.rs` header comment, why it exists and the exact upstream condition that would let it be deleted.
- **Don't silently bump dep ranges.** If `cargo update` would cross a major or patched version you actively depend on (e.g. `csgrs`), surface it in the PR description so reviewers can sanity-check for behaviour changes.

## 9. Feedback Loop
- If a pattern is confusing or repeatedly error-prone, call it out explicitly in your PR notes.
- Prefer refactors that make the correct path the easiest path (single source of truth helpers, stricter types, fewer implicit fallbacks).
