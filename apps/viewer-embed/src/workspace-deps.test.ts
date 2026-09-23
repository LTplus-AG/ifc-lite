/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * This app must declare every workspace package `apps/viewer` declares.
 *
 * The embed has almost no component tree of its own. `vite.config.ts` aliases
 * `@` to `../viewer/src`, so it bundles the viewer's store, hooks and Viewport
 * out of the other app's source tree — and reaches, transitively, whatever
 * those files import. Its package.json used to carry a hand-picked subset of
 * the viewer's `@ifc-lite/*` dependencies, which is a guess about reachability,
 * and reachability is decided by files in a directory this package does not
 * own. It changes without touching the embed at all.
 *
 * WHY NOTHING ELSE CATCHES A MISSING ONE. Each Vercel project builds only its
 * own closure — `apps/viewer-embed/vercel.json` runs
 * `turbo build --filter='@ifc-lite/viewer-embed...'` — so a package the embed
 * does not depend on is never built, has no `dist/`, and a bare
 * `@ifc-lite/<pkg>` specifier in the viewer source it bundles does not resolve.
 * CI cannot see that: the root `pnpm build` is an UNFILTERED `turbo build` that
 * builds every package's `dist/` first, which makes the undeclared dependency
 * resolve anyway. The production deploy is the only thing that runs this app
 * the way production does.
 *
 * That is #5208. `feat(flow)` (0eafae1cb) added
 * `apps/viewer/src/lib/flow/persistence.ts`, imported by the viewer store slice
 * this app mounts, importing `@ifc-lite/flow` — a viewer dependency, not an
 * embed one. `Build + WASM + Rust + Node` was green on that commit; the nightly
 * deploy then failed with
 *
 *     [vite]: Rolldown failed to resolve import "@ifc-lite/flow" from
 *     "apps/viewer/src/lib/flow/persistence.ts"
 *
 * and, because the nightly only fast-forwards `production` to a commit whose
 * build it can verify, every production site froze — the viewer and the docs
 * included, neither of which had anything wrong with them.
 *
 * So the invariant is parity, not reachability: whatever the viewer can import,
 * this app can end up bundling. A workspace dependency is a build-graph edge
 * rather than bundle weight — an unreached package is tree-shaken out of the
 * output exactly as before — so declaring the superset costs a few seconds of
 * `tsc` in this app's deploy and removes the guessing.
 *
 * The direction is one-way on purpose: the embed may hold dependencies the
 * viewer does not (`@ifc-lite/embed-protocol` is its own), and nothing about
 * those is a guess. Non-`@ifc-lite/*` dependencies are out of scope — they
 * resolve from `node_modules` with no build step, so the filtered-closure
 * failure mode cannot reach them, and `devDependencies` never reach a
 * production bundle.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Manifest {
  dependencies?: Record<string, string>;
}

const manifest = (relativeToRepoRoot: string): Manifest =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../${relativeToRepoRoot}`, import.meta.url)), 'utf8'),
  ) as Manifest;

const workspaceDeps = (pkg: Manifest): string[] =>
  Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith('@ifc-lite/'));

describe('viewer-embed workspace dependencies', () => {
  it('declares every @ifc-lite/* dependency apps/viewer declares (#5208)', () => {
    const declared = new Set(workspaceDeps(manifest('apps/viewer-embed/package.json')));
    const missing = workspaceDeps(manifest('apps/viewer/package.json'))
      .filter((name) => !declared.has(name))
      .sort();

    expect(
      missing,
      missing.length === 0
        ? ''
        : `apps/viewer-embed/package.json is missing ${missing.length} workspace ` +
          `dependenc${missing.length === 1 ? 'y' : 'ies'} apps/viewer declares:\n` +
          missing.map((name) => `    "${name}": "workspace:^",`).join('\n') +
          '\nThis app bundles apps/viewer/src, and its Vercel build only builds its own ' +
          "turbo closure, so an undeclared package has no dist/ and the import fails to " +
          'resolve in the production deploy only. Add the entries above and run ' +
          '`pnpm install --lockfile-only`.',
    ).toEqual([]);
  });

  it('may hold dependencies the viewer does not', () => {
    // The rule is one-way. @ifc-lite/embed-protocol is this app's own, and the
    // viewer has no reason to carry it — pinned so a future tightening to
    // set-equality has to argue with this case rather than silently pass.
    const embedOnly = new Set(workspaceDeps(manifest('apps/viewer-embed/package.json')));
    for (const name of workspaceDeps(manifest('apps/viewer/package.json'))) embedOnly.delete(name);
    expect([...embedOnly]).toContain('@ifc-lite/embed-protocol');
  });
});
