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
  });
});
