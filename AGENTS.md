# Agent Guidelines: ifc-lite

Project-specific gotchas and guardrails — the things that bite you *here* and that you can't infer from the code. Generic good practice is assumed, not repeated.

**House rules (enforced, but easy to violate):** no `as any` / `@ts-ignore` (fix the types or add a `.d.ts`); no silent `catch {}` (log or rethrow); split modules over ~400 non-generated lines; new packages/features ship tests; package-specific deps go in the consuming package, never root.

## IFC schema fidelity
- User-facing APIs/exports/scripts use exact IFC EXPRESS names — PascalCase attributes (`GlobalId`, `Name`, `ObjectType`), full relationship names (`IfcRelAggregates`, not `Aggregates`). Never invent aliases.
- STEP type names are stored UPPERCASE; render via `store.entities.getTypeName(id)` to get `IfcPascalCase`.

## Models & federation
- **One canonical load path:** every model — primary *and* federated, any format — loads via `useIfcLoader.loadFile(file, target)`; `useIfcFederation.addModel` is a thin wrapper. Never add a second load/ingest pipeline: a federated-only path that drifts from `loadFile` silently skips load-time features.
- Resolve selections/IDs through `FederationRegistry` (`toGlobalId`/`fromGlobalId`/`getModelForGlobalId`), never ad-hoc math; honor the single-model fallback `globalId === expressId`. Verify behaviour at `models.size` of 1 *and* N.
- `extractEntityAttributesOnDemand` re-parses the source buffer — never call it in loops; use cached `EntityNode` getters.

## Geometry & WASM
- Free every WASM handle (`MeshCollection`, `MeshDataJs`, pre-pass cache) deterministically: wrap pre-pass + job batches in `try/finally` so `.free()` / `clearPrePassCache()` run on early return, on throw, **and** when an async generator is abandoned (`.return()` runs `finally`). Getters copy into JS arrays, so `.free()` right after extraction is safe — don't deep-copy already-extracted meshes.
- Coordinates: IFC is Z-up, the viewer is Y-up (converted during mesh parsing). `/api/create` expects IFC Z-up `[x, y, z]`.
- Colour + coordinate resolution is canonical Rust shared by the server (`process_geometry`) and viewer (`process_geometry_batch`) so they can't drift. Don't re-fork it. Single homes: `default_color_for_type`, `resolve_submesh_color`, **`extract_surface_style_colors`** (the IfcSurfaceStyle→Rendering→Colour leaf — SurfaceColour is the apparent colour, a distinct DiffuseColour IfcColourRgb is only `shading_color`, per #859/#871), and the indexed-colour resolvers — all in `ifc_lite_processing::style`; **`rotation_angle_about_z`** (site/building rotation, off `resolve_scaled_placement`) in `ifc_lite_geometry`. `styling_parity` Rust tests fail the build if a duplicate `get_default_color*` table or a per-pipeline `extract_color_from_rendering`/`extract_color_rgb` reappears. New type default = edit `default_color_for_type` + extend the mesh fixture. Sanctioned exceptions: the 2D drafting palette in `section-2d-overlay.ts` (`PARITY-ALLOW`) and standalone debug tools under `rust/geometry/examples/` (can't reach the downstream crate). (#913, #996, #997)

## Build, CI & generated artifacts
- Don't edit `packages/wasm/pkg/*` — change the Rust crates and regenerate. `scripts/build-wasm.sh` also rewrites `pkg/README.md` + `pkg/package.json` (version/README churn); `git checkout` those two before committing.
- `scripts/build-wasm.sh` needs the pinned Rust toolchain + `wasm-pack` + clang/LLVM-20 and runs in **three** workflows (`test`, `release`, `sdk-canary`) — change its toolchain requirements in all three together, or one drifts and fails only when its path filter triggers.
- ifc-lite ships a **web viewer** + headless CLI/MCP/server only — there is no first-party desktop app (removed; the `apps/desktop` Tauri shell and the viewer override-contract are gone). The desktop **capability** lives in `@ifc-lite/geometry` (`IPlatformBridge` / `NativeBridge` / `isTauri()`, `@tauri-apps/api` optional dep) for third parties building their own Tauri shell — keep it web-pure (it must never be imported on the web path; it's lazy-loaded only under `isTauri()`).
- `Cargo.lock` is committed (app crates need reproducibility; an upstream yank broke CI once). Refresh with `cargo update -p <crate>`, never by deleting it. `[patch.crates-io]` lives in the root `Cargo.toml`; vendored stubs under `rust/vendor/<crate>/` must document why they exist.

## Changesets & published API
- Changes to published `packages/*` need `pnpm changeset` (never hand-edit versions/`CHANGELOG.md`). Bump level = biggest API change: removing/renaming an export is `major` (≥1.0 pkg) / `minor` (0.x), never `patch` when the surface shrank.
- Only re-export from a package's `index.ts` what has a real consumer — an unused public export is permanent semver liability.

## Removing & replacing code (anti-cruft)
- Supersede means delete: replace a path → remove the old one in the *same* PR. No "legacy"/"fallback"/"just-in-case" path; if one must stay, gate it behind `// TODO(remove-by: <cond>, <owner>)` + a tracking issue.
- Delete dead code with the change that orphans it. When renaming/removing a public symbol, grep the whole repo (`docs/`, `examples/`, `scripts/`, `*.md`) and fix every reference in the same PR.
- Prove removals: TS → `pnpm knip` (on-demand, not a CI gate); Rust → `cargo test --workspace`, **not** `cargo check` (check skips `#[cfg(test)]`, so a test-only reference to a deleted fn slips through). Intentionally-unused Rust items need `#[allow(dead_code)]` + a why.

## Test fixtures
- Not committed (no LFS): catalogued in `tests/models/manifest.json`, fetched via `pnpm fixtures`. Tests must **skip** (never throw/panic) when a fixture is absent — point to `pnpm fixtures` in the skip message. Add one: drop under `tests/models/<group>/` → `pnpm fixtures:manifest` → `pnpm fixtures:upload`; commit only the manifest. CI runs `pnpm fixtures` before tests.

## CLI
- Discover the full SDK API with `ifc-lite schema` (JSON). `eval` runs SDK expressions (`ifc-lite eval model.ifc "bim.query().byType('IfcWall').count()"`); always pass `--json` for machine output. `HeadlessBackend` (`packages/cli/src/headless-backend.ts`) runs query/export/create/IDS/BCF without a renderer.

## New source files
- MPL-2.0 header on every new file — see [`./LICENSE_HEADER.md`](./LICENSE_HEADER.md).
