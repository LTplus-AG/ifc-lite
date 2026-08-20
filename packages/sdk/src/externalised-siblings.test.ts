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
 * would be flaky by construction. A natively-imported ES module namespace is
 * sealed; one built by vite's SSR transform is an ordinary object.
 */
it('imports sibling workspace packages natively, not through vite (#2935)', async () => {
  const namespace = await import('@ifc-lite/lists');
  const someExport = Object.keys(namespace)[0];
  expect(someExport, 'the module must export something to inspect').toBeTruthy();

  const descriptor = Object.getOwnPropertyDescriptor(namespace, someExport);
  expect(
    { configurable: descriptor?.configurable, extensible: Object.isExtensible(namespace) },
    'a vite-transformed namespace is configurable and extensible; a native ESM one is ' +
      'neither. Both true means server.deps.external in vitest.config.ts stopped ' +
      'applying, and the cold-transform flake is back',
  ).toEqual({ configurable: false, extensible: false });
});
