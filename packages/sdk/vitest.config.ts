/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Sibling workspace packages, matched by their BUILT output.
 *
 * Anchored at the repo root rather than left as a floating substring: vitest
 * tests this against a resolved absolute path, so an unanchored
 * `packages/<x>/dist/` would also match a checkout that happens to live
 * beneath some other `packages/<x>/dist/` directory -- and then it matches
 * this package's own `src/*.ts` too, which Node cannot execute.
 *
 * `pkg` as well as `dist`, because `@ifc-lite/wasm` builds to
 * `packages/wasm/pkg/ifc-lite.js` (turbo's build outputs are
 * `["dist/**", "pkg/**"]`). It is reachable from here through
 * `@ifc-lite/clash/wasm`, and it is a large generated bundle -- exactly the
 * thing that must not be re-transformed inside a lazy import's budget.
 */
const BUILT_SIBLING = new RegExp(
  `^${repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}packages/[^/]+/(dist|pkg)/`,
);

export default defineConfig({
  test: {
    environment: 'node',
    // Load sibling workspace packages as the built JS they already are,
    // instead of re-transforming them.
    //
    // pnpm links `@ifc-lite/*` as symlinks, so the specifier resolves to
    // `packages/<name>/dist/index.js` -- a real path inside the project root.
    // Vite therefore treats that built file as SOURCE and runs it through its
    // SSR transform on every run. That transform, not module loading, is the
    // cost: Node imports those same files in 12-40ms.
    //
    // It surfaced as a timeout rather than as slowness because the namespaces
    // load their implementations with a dynamic `import()` on first use, so the
    // whole transform landed inside the 5000ms budget of whichever test touched
    // one first. Measured at 2002ms, it crossed the limit under CI load and took
    // `main` red on 19 of 20 runs (#2935), after being patched one test file at
    // a time three times before that (3a00b5e64, #2248).
    //
    // Full sdk suite, `--maxWorkers=2`, 3 reps, 173/173 green in every column:
    //
    //   before                       1.60s   (transform 1.38s)
    //   warming the imports instead  2.28s   (transform 3.41s, setup 2.50s)
    //   this                         0.61s   (transform 129ms)
    //
    // The two tests that flaked go to 29ms and 38ms with nothing warmed.
    //
    // Resolution is unchanged -- the import already resolved to `dist`; only the
    // transform is removed, and every sibling `exports` map in this closure is a
    // plain `{types, import, default}` with no condition that would pick a
    // different file. It does mean the siblings must be BUILT: `turbo.json` gives
    // `test` a `dependsOn: ["build"]`, and `build` in turn `["^build"]`, so turbo
    // covers it transitively. Running `vitest` package-locally does not, but that
    // was already true -- the import resolved to `dist` before this too.
    //
    // ONE REAL BEHAVIOUR CHANGE: externalised modules are native ESM, so their
    // namespace objects are non-configurable and `vi.spyOn(await
    // import('@ifc-lite/...'), 'someExport')` now throws "Module namespace is not
    // configurable". `vi.mock` is unaffected and still wins over externalisation,
    // for both static and dynamic imports. Nothing in the suite spies that way
    // today; if you need to, use `vi.mock` with a factory.
    //
    // Written as a path pattern on purpose: `external: [/@ifc-lite\//]` does NOT
    // work, because `external` matches resolved paths rather than specifiers, and
    // pnpm realpaths the symlink so the id contains neither the specifier nor
    // `/node_modules/`.
    server: { deps: { external: [BUILT_SIBLING] } },
  },
});
