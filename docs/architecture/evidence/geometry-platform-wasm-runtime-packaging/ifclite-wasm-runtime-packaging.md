# Generated WASM runtime helper packaging

Implemented in the shared root, left uncommitted. Exact final changed-file hashes are in `/tmp/ifclite-wasm-runtime-packaging-hashes.json`.

Changed paths:
- `packages/wasm/package.json`
- `packages/wasm/README.md`
- `scripts/build-wasm.sh`
- `scripts/fetch-prebuilt-wasm.mjs`
- `scripts/fetch-prebuilt-wasm.test.mjs`
- `scripts/lib/wasm-runtime-assets.mjs`
- `.changeset/green-paws-build.md`

The published files list now includes generated private `pkg/snippets/**`. A real synthetic npm packlist check exposed that wasm-pack's `pkg/.gitignore` containing `*` still excluded those helpers despite that allowlist. The canonical build and accepted-fetch paths now generate an empty `pkg/.npmignore`; the existing package files list remains authoritative. The fixture explicitly recreates that gitignore and confirms both nested helper files are packed while npm-ignore metadata itself is omitted. This is generated build metadata, not a manual edit to pkg artifacts. The build script retains its original toolchain, failures and optimization flow. No versions, changelog, committed generated type file, generated runtime, Rust source or lock was hand-edited. The actual existing Changesets CLI created a minor @ifc-lite/wasm changeset covering the new explicit retained browser API and generated helper packaging.

The fetcher now validates the complete static JS import/re-export closure starting from ifc-lite.js, plus the required root WASM file, before installing any fetched runtime asset. The helper uses TypeScript's parser from the existing declared root development dependency; it does not add a dependency or evaluate imported code. Static module references must be relative JS/mjs paths inside pkg. Missing files, foreign/bare/absolute imports, outside paths, encoded/query/fragment paths and symlinked runtime assets are refused. Rejecting symlink aliases also avoids recursive logical dependency aliases. Ordinary cyclic imports terminate through the visited asset set. Rejected fetched packages clean temporary extraction/tarball data while preserving installed JS/WASM/helpers and committed types.

An already-installed runtime now passes the same closure validation in addition to the existing committed-d.ts export parity check. Matching exports alone no longer hide missing static helpers. Old published packages with no static imports remain valid and install only their two original runtime assets. The published d.ts remains ignored and the checkout's committed d.ts preserved. Successful helper installation creates only the required nested directories and copies the referenced assets. Unreferenced existing generated assets are not deleted as unrelated ownership cleanup.

Dynamic imports remain outside this static generated-runtime closure, preserving the explicit lazy SDK asset boundary. The new retained driver's dynamic /smlib imports are not fetched, instantiated or activated by validation. The package README distinguishes required generated helpers from optional retained SDK deployment assets. This validator establishes resolvable static assets and export parity, not complete JavaScript semantics, WASM binary validity or a hard allocation envelope.

Validation: `node --test scripts/fetch-prebuilt-wasm.test.mjs scripts/lib/wasm-export-parity.test.mjs` passed27/27,0failed,0skipped, 7.672 seconds. Seventeen fetch end-to-end fixtures use a throwaway checkout and local npm stub to produce tarballs; ten existing export-parity tests remain green. New fixtures copy a nested helper/re-export cycle, include a top-level throw to demonstrate no evaluation, reject a missing nested fetched helper before replacing any installed asset, reject installed matching-export glue with a missing helper without fetching, and refuse foreign/outside/encoded imports and a symlinked foreign helper. These are actual file-install/early-exit assertions, not source-text tests or SDK geometry mocks. `git diff --check` passed for touched tracked files, and `bash -n scripts/build-wasm.sh` passed. The actual canonical build script was not executed. Log: `/tmp/ifclite-wasm-runtime-assets-tests.log`.

No real npm package was downloaded, no network request or publish occurred, and no root pnpm build/typecheck/test graph, Rust/WASM build, fleet job or heavy validation was started. The local fixture checks were explicitly authorized for this task. Actual canonical WASM generation, real generated artifact package contents, consumer bundler resolution and actual browser/default-exact/retained execution remain UNRUN pending the parent's admitted qualification. Public generated d.ts regeneration remains the canonical build owner's responsibility; this change does not claim the broader retained ProductProgram integration is complete.
