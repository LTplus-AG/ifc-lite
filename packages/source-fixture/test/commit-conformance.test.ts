/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The commit suite run against the fixture itself — the oracle proving it is
 * its own first conformant provider, exactly as `fixture.test.ts` does for
 * the 2.0.0 surface.
 *
 * Two runs, and the second is the one that matters: with every flag off but
 * the required reads, the suite must shrink to the checks those reads own
 * rather than failing a provider for methods it correctly does not have.
 */

import { describe } from 'vitest';

import { createFixtureContext, createFixtureSourceProvider } from '../src/index.js';
import { runCommitConformanceSuite } from '../src/conformance/index.js';
import { buildCommitWorldSpec } from './commit-world.js';

describe('fixture provider, every commit capability on', () => {
  const provider = createFixtureSourceProvider({
    world: buildCommitWorldSpec(),
    // Two formats so the `accept`-ordering check has something to order, and
    // so one format is left over to prove `unsupported-format`.
    capabilities: { commits: { payloadFormats: ['ifc-step', 'ifcx'] } },
    pageSize: 2,
  });

  runCommitConformanceSuite(provider, {
    createContext: () => createFixtureContext(),
    fixtures: {
      projectId: 'proj-1',
      modelId: 'model-structural',
      elementKey: 'wall-a2',
      writableProjectId: 'proj-1',
      writableModelId: 'model-uploads',
    },
  });
});

describe('fixture provider, only the required reads', () => {
  const provider = createFixtureSourceProvider({
    world: buildCommitWorldSpec(),
    capabilities: {
      commits: {
        payloadFormats: ['ifc-step'],
        fingerprints: false,
        storedDiffs: false,
        elementHistory: false,
        identityRecords: false,
        write: false,
        watch: false,
      },
    },
  });

  runCommitConformanceSuite(provider, {
    createContext: () => createFixtureContext(),
    fixtures: { projectId: 'proj-1', modelId: 'model-structural' },
  });
});

describe('fixture provider with commits switched off entirely', () => {
  // The control for "additive only": a 2.0.0 provider must pass the
  // capability check by having NONE of the commit surface, not by having
  // some of it.
  const provider = createFixtureSourceProvider({
    world: buildCommitWorldSpec(),
    capabilities: { commits: false },
  });

  runCommitConformanceSuite(provider, {
    createContext: () => createFixtureContext(),
    fixtures: { projectId: 'proj-1', modelId: 'model-structural' },
  });
});
