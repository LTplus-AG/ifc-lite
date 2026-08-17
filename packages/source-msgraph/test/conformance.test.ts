/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Runs the shared `FileSourceProvider` conformance suite (`@ifc-lite/source-fixture`)
// against the real `MsGraphProvider`, driven by `createGraphApiMock`'s
// stand-in for the Microsoft Graph REST API. Mirrors
// `packages/source-dalux/test/conformance.test.ts`.

import { describe } from 'vitest';

import type { ConformanceFixtures } from '@ifc-lite/source-fixture/conformance';
import { runConformanceSuite } from '@ifc-lite/source-fixture/conformance';

import { MsGraphProvider } from '../src/provider.js';
import { createGraphMockContext } from './msgraph-api-mock.js';
import type { GraphMockWorld } from './msgraph-api-mock.js';

/**
 * Two top-level folders (so the top-level `listContainers` query has a real
 * page boundary to cross), one of which (`f-alpha`) nests a subfolder and
 * holds two files (so `listContainers`/`listFiles` scoped queries and their
 * own boundary checks all have something real to page through), plus a
 * second file elsewhere matching the same search query.
 */
const WORLD: GraphMockWorld = {
  driveId: 'drive-1',
  driveName: 'Contoso Drive',
  items: [
    { id: 'f-alpha', name: 'Alpha', kind: 'folder', childCount: 1 },
    { id: 'f-beta', name: 'Beta', kind: 'folder', childCount: 1 },
    // Files listed before the nested subfolder: `/children` mixes folder and
    // file items in one Graph response, and `listFiles` (`provider.ts`)
    // filters to `file` items only *after* paging — so with a small `$top`,
    // whichever type happens to come first in Graph's own ordering can
    // legitimately produce an all-folder page with zero files. Real listings
    // aren't guaranteed to put files first, but this fixture deliberately
    // does, so the conformance suite's single-page "does this container
    // genuinely have files" checks (`download.ts`'s aborted-signal check,
    // which reads only the first page) have something to find without
    // needing to paginate through folders first.
    { id: 'file-1', name: 'model.ifc', parentId: 'f-alpha', kind: 'file', size: 12, content: 'MODEL-BYTES-1' },
    { id: 'file-2', name: 'plan.ifc', parentId: 'f-alpha', kind: 'file', size: 8, content: 'MODEL-BYTES-2' },
    { id: 'f-alpha-sub', name: 'Sub', parentId: 'f-alpha', kind: 'folder', childCount: 0 },
    { id: 'file-3', name: 'model-copy.ifc', parentId: 'f-beta', kind: 'file', size: 4, content: 'MODEL-BYTES-3' },
  ],
};

const fixtures: ConformanceFixtures = {
  projectId: 'me',
  containerWithChildrenId: 'f-alpha',
  containerWithFilesId: 'f-alpha',
  searchQuery: 'model',
  // No `secondProjectId`: this provider exposes exactly one project (the
  // signed-in user's own drive) — see `ME_PROJECT_ID`'s doc comment in
  // `provider.ts`.
  //
  // No `fileWithRevisions`: `capabilities.downloadHistoricalRevisions` is
  // `false`, so the download-conformance check this fixture would drive is
  // gated off regardless (see `download.ts` in `@ifc-lite/source-fixture`).
};

describe('MsGraphProvider conformance', () => {
  const provider = new MsGraphProvider();
  // `$top=1` forces a page boundary on every listing below without needing a
  // large mock world — Graph genuinely honors `$top` (unlike Dalux's
  // server-chosen bookmark page size), so `pageBoundary: 'limit'` (the
  // suite's default) is the honest mode here.
  const fetchImpl = () => createGraphMockContext(WORLD, { defaultPageSize: 200 });

  runConformanceSuite(provider, {
    createContext: fetchImpl,
    fixtures,
    smallPageLimit: 1,
    watchRevisionsHasDeltaFeed: true,
  });
});
