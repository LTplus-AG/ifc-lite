# Combined developer-workflow verification

`receipt.json` records the successful combined-tree run after all nine developer-experience layers were assembled. Package versions are the versions in the packed source checkout, before the normal changeset release. These are measured results, not additional CI acceptance rules.

The run used Node 24.21.0, the root-pinned pnpm version, the manifest-verified Archicad FZK model, and the real WASM artifact identified by its CI run, source commit and SHA-256 in the receipt. The artifact's committed declarations matched this checkout; Rust, Cargo and WASM build inputs were unchanged. The local build hid `wasm-pack` from PATH so the root build retained that matching runtime instead of starting another Rust build. This verifies the actual WASM path; the separate `api-reference/wasm-free.json` receipt verifies reference generation without a runtime.

Reproduce from a checkout containing all task PRs:

```sh
pnpm install --frozen-lockfile
pnpm fixtures
pnpm build:wasm
pnpm turbo build --filter='./packages/*' --force --concurrency=2
pnpm test --filter=@ifc-lite/parser --filter=@ifc-lite/sdk --filter=@ifc-lite/mcp --filter=@ifc-lite/cli --filter=@ifc-lite/geometry --filter=@ifc-lite/pointcloud --filter=create-ifc-lite
pnpm test --filter=ifc-lite-headless-workflows
pnpm test:packed
pnpm typecheck
pnpm docs:check-samples
pnpm docs:check-generated
pnpm check:api-surface
node --test scripts/docs/build-api-reference.test.mjs
bash apps/landing/build-docs.sh
```

The packed check installs actual tarballs in a fresh external directory, checks declarations with strict library checking, edits and reopens IFC, verifies lifecycle errors, produces real Node WASM GLB output, and builds the browser worker/WASM assets with Vite. GLB mesh counts, triangle counts and bytes matched the recorded baseline for both fixtures; this is output-identity evidence, not a runtime speed claim.

The skipped tests depend on additional unavailable fixtures or explicitly unsupported host capabilities. The six developer recipe tests and both packed IFC workflows ran successfully. Module size, raw entity access, source assertion, test wiring, CI path/aggregate coverage, generated documentation and license guards also passed. A full strict MkDocs/landing build produced the searchable reference in the deploy output.

The task ledger is `docs/architecture/developer-experience/tasks.json`; individual behavior receipts and observed production-revert checks remain in their respective evidence directories. The final PR's current-head CI is the acceptance record for the landed source.

The geometry coverage follow-up reproduced a partial-success bug using the real committed wall model with one oversized EXPRESS id. All six recipe tests and the standard root typecheck passed after adding the shared preflight; `../developer-recipes/geometry-coverage.json` records the failed-before/passed-after result.

The packed-command follow-up requires the committed wall before packaging or installation, while the manifest-backed FZK remains optional. Its isolated missing-wall regression and full external consumer test both passed; `../packed-workflows/required-fixture.json` records this verification. CI also restores compiled example outputs for package tests and the production-revert oracle.

The final packed-command suite passed five cases, including missing JavaScript, declarations and WASM with named build remedies before any tarball is written. `../packed-workflows/build-prerequisites.json` records the three failed-before cases and full passing consumer suite. Full root `pnpm lint` also passed after registering the example package’s measured zero-unused-code budget.
