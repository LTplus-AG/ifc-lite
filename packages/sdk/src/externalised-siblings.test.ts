/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';

/**
 * `vitest.config.ts` stops vite re-transforming sibling packages' built output,
 * which is what kept this package's lazily-imported namespaces inside a 5000ms
 * test budget (#2935).
 *
 * That protection is action-at-a-distance: it lives in the config, not in the
 * files it protects, and if it ever stops taking effect the tests do not fail
 * -- they silently go back to paying a ~2s transform inside a 5s budget, and
 * the flake returns on somebody else's PR. Absence of the protection looks
 * exactly like success, which is the whole reason it is asserted here.
 *
 * One concrete way it could silently stop: vitest checks `deps.inline` BEFORE
 * `deps.external`, so a later inline rule added for an unrelated reason
 * overrides the pattern with no error at all. Verified: adding
 * `inline: [/packages\/[^/]+\/dist\//]` turns this test red. Note it has to be
 * path-shaped to do so -- `inline: [/@ifc-lite/]` changes nothing, because
 * inline matches resolved paths too, which is the same trap as `external`.
 *
 * Asserted on the shape of the module namespace rather than on a timing, which
 * would be flaky by construction. Under today's vite, a natively imported ES
 * module namespace is sealed and one built by the SSR transform is not; every
 * other distinguishing bit is identical (`proto === null`,
 * `Symbol.toStringTag === 'Module'` in both). That makes sealed-ness the best
 * cheap discriminator available rather than a definition -- if vite ever seals
 * its namespaces this goes green while inlining, so the per-package coverage
 * below is the real belt.
 *
 * Every heavy sibling is checked, not a sample. An earlier version asserted
 * only `@ifc-lite/lists`, which is the SMALLEST of the eight packages
 * externalised here at 168K; the cost is `@ifc-lite/data` at 9.8M and
 * `@ifc-lite/parser` at 5.5M. Inlining just those two -- precisely the "later
 * inline rule added for an unrelated reason" named above -- left the guard
 * green while suite transform went 120ms to 944ms. The safety net had a hole
 * in the exact shape of the threat it documents.
 */
it.each([
  '@ifc-lite/data',
  '@ifc-lite/parser',
  '@ifc-lite/lists',
  '@ifc-lite/clash',
  '@ifc-lite/ids',
])('imports %s natively, not through vite (#2935)', async (specifier) => {
  const namespace: Record<string, unknown> = await import(/* @vite-ignore */ specifier);
  const someExport = Object.keys(namespace)[0];
  expect(someExport, `${specifier} must export something to inspect`).toBeTruthy();

  const descriptor = Object.getOwnPropertyDescriptor(namespace, someExport);
  expect(
    { configurable: descriptor?.configurable, extensible: Object.isExtensible(namespace) },
    `${specifier} came through vite's transform: its namespace is configurable and ` +
      'extensible, where a native ESM one is neither. server.deps.external in ' +
      'vitest.config.ts stopped applying to it, and the cold-transform flake is back',
  ).toEqual({ configurable: false, extensible: false });
});
