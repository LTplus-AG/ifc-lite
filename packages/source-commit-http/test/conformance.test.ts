/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared conformance suites, run against this provider over a mocked
 * `fetch` that speaks the REST contract (`test/mock-service.ts`).
 *
 * Because the mock is backed by the fixture provider — the same oracle the
 * suite is written against — a failure here is always attributable to the
 * HTTP layer: a query parameter the client forgets to send, a field the
 * decoder drops, a status the error mapper mislabels.
 */

import { describe } from 'vitest';

import { runCommitConformanceSuite } from '@ifc-lite/source-fixture/conformance';

import { createCommitHttpProvider } from '../src/index.js';
import { createMockContext } from './context.js';
import { createMockService } from './mock-service.js';
import { buildWorld } from './world.js';

describe('source-commit-http', () => {
  const service = createMockService({ world: buildWorld() });
  const provider = createCommitHttpProvider({
    network: ['commits.example.com', 'id.example.com'],
    // The service's own capability document, read at bootstrap — the pattern
    // `fetchCommitCapabilities` exists for, expressed here without the round
    // trip since the mock is right there.
    commits: service.fixture.manifest.capabilities.commits!,
  });

  runCommitConformanceSuite(provider, {
    createContext: () => createMockContext(service),
    fixtures: {
      projectId: 'proj-1',
      modelId: 'model-structural',
      elementKey: 'wall-a2',
      writableProjectId: 'proj-1',
      writableModelId: 'model-uploads',
    },
  });
});
