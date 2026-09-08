/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Proves the fixture provider itself is a fully-conformant `FileSourceProvider`
// across the whole configuration matrix: both containerListing modes, both
// listFilesIsRecursive settings, and both auth kinds. This is also, in
// effect, an integration test of the conformance kit — if it can't reliably
// pass a provider that is deliberately correct, the kit itself is broken.

import { beforeAll, describe } from 'vitest';

import { createFixtureContext, createFixtureSourceProvider } from '../src/index.js';
import type { ConformanceFixtures } from '../src/conformance/index.js';
import { runConformanceSuite } from '../src/conformance/index.js';
import { buildTestWorldSpec } from './world.js';

const fixtures: ConformanceFixtures = {
  projectId: 'proj-1',
  containerWithChildrenId: 'root1',
  containerWithFilesId: 'sub1',
  fileWithRevisions: { containerId: 'sub1', fileId: 'structural-model' },
  searchQuery: 'structural',
  secondProjectId: 'proj-2',
};

const containerListingModes = ['direct-children', 'flat-subtree'] as const;
const recursionModes = [false, true] as const;

for (const containerListing of containerListingModes) {
  for (const listFilesIsRecursive of recursionModes) {
    describe(`containerListing=${containerListing} listFilesIsRecursive=${listFilesIsRecursive}`, () => {
      const provider = createFixtureSourceProvider({
        world: buildTestWorldSpec(),
        containerListing,
        listFilesIsRecursive,
      });

      runConformanceSuite(provider, {
        createContext: () => createFixtureContext(),
        fixtures,
        smallPageLimit: 1,
        // The fixture provider clamps `limit` down to its own page size but
        // otherwise honors it, so it opts into the stricter paging check a
        // provider is free not to satisfy.
        pageBoundary: 'limit',
        // POLLING, not delta-backed: `watchRevisions` walks the `refs` it is
        // given and ignores `cursor` outright (`src/provider.ts` — the
        // parameter is `_cursor`). It returns a cursor anyway, so that hosts
        // which persist and pass one back are exercised, but that is a token
        // it never reads. Declaring a delta feed here would waive the
        // empty-ref invariant — "watching nothing reports nothing" — for the
        // one provider whose whole job is to prove the kit passes a correct
        // one. The cursor round-trip the flag also gates is exercised by
        // `conformance-watch-delta-feed.test.ts`, against a stub that really
        // is delta-backed.
        watchRevisionsHasDeltaFeed: false,
      });
    });
  }
}

// Interactive auth: a single shared context, signed in once via `beforeAll`
// before any conformance test runs. The fixture provider never touches
// ctx.storage for anything other than identity, so reusing one context
// across the whole suite run is safe and mirrors how a real host reuses one
// persistent, storage-backed context for a session.
describe('auth=interactive', () => {
  const provider = createFixtureSourceProvider({
    world: buildTestWorldSpec(),
    auth: 'interactive',
  });
  const ctx = createFixtureContext();

  beforeAll(async () => {
    await provider.auth!.signIn(ctx);
  });

  runConformanceSuite(provider, {
    createContext: () => ctx,
    fixtures,
    smallPageLimit: 1,
    pageBoundary: 'limit',
    // Polling — see the note on the same flag above.
    watchRevisionsHasDeltaFeed: false,
  });
});
