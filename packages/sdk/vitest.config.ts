/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Load sibling workspace packages as the built JS they already are,
    // instead of re-transforming them.
    //
    // pnpm links `@ifc-lite/*` as symlinks into the monorepo, so the specifier
    // resolves to `packages/<name>/dist/index.js` -- a real path inside the
    // project root. Vite therefore treats that built file as SOURCE and runs it
    // through its SSR transform on every run. That transform, not module
    // loading, is the cost: Node imports those same files in 12-40ms.
    //
    // It surfaced as a timeout rather than as slowness because the namespaces
    // load their implementations with a dynamic `import()` on first use, so the
    // whole transform landed inside the 5000ms budget of whichever test
    // happened to touch one first. Measured at 2002ms, it crossed the limit
    // under CI load and took `main` red on 19 of 20 runs (#2935), after being
    // patched one test file at a time three times before that (3a00b5e64,
    // #2248).
    //
    // Full sdk suite, `--maxWorkers=2`, 3 reps, 173/173 green in every column:
    //
    //   before                       1.60s   (transform 1.38s)
    //   warming the imports instead  2.28s   (transform 3.41s, setup 2.50s)
    //   this                         0.61s   (transform 129ms)
    //
    // The two tests that flaked go to 29ms and 38ms with nothing warmed.
    //
    // Same file either way, so nothing about what is under test changes -- the
    // import already resolved to `dist`; it was only the transform that was
    // added. It does mean the siblings must be BUILT, which `turbo test`
    // already guarantees via `dependsOn: ["^build"]` (AGENTS.md).
    //
    // Written as a path pattern on purpose: `external: [/@ifc-lite\//]` does
    // NOT work, because `external` matches resolved paths rather than
    // specifiers.
    server: { deps: { external: [/packages\/[^/]+\/dist\//] } },
  },
});
