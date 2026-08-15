/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Runs the shared `FileSourceProvider` conformance suite (`@ifc-lite/source-fixture`)
// against the real `DropboxProvider`, driven by `createDropboxApiMock`'s
// stand-in for the Dropbox API. Mirrors `packages/source-msgraph/test/conformance.test.ts`.

import { describe } from 'vitest';

import type { ConformanceFixtures } from '@ifc-lite/source-fixture/conformance';
import { runConformanceSuite } from '@ifc-lite/source-fixture/conformance';

import { DropboxProvider } from '../src/provider.js';
import { createDropboxMockContext } from './dropbox-api-mock.js';
import type { DropboxMockWorld } from './dropbox-api-mock.js';

/**
 * Two top-level folders (so the top-level `listContainers` query has a real
 * page boundary to cross), one of which (`f-alpha`) nests a subfolder and
 * holds two files (so `listContainers`/`listFiles` scoped queries and their
 * own boundary checks all have something real to page through), plus a
 * second file elsewhere matching the same search query.
 */
const WORLD: DropboxMockWorld = {
  accountId: 'account-1',
  displayName: 'Mock User',
  email: 'mock@example.com',
  items: [
    { id: 'id:f-alpha', name: 'Alpha', kind: 'folder' },
    { id: 'id:f-beta', name: 'Beta', kind: 'folder' },
    // Files listed before the nested subfolder — `listFiles` (`provider.ts`)
    // filters to `file` entries only *after* paging, so with a small
    // `limit`, whichever type happens to come first in Dropbox's own
    // ordering can legitimately produce an all-folder page with zero files.
    // Real listings aren't guaranteed to put files first, but this fixture
    // deliberately does, mirroring `source-msgraph`'s own conformance world.
    { id: 'id:file-1', name: 'model.ifc', parentId: 'id:f-alpha', kind: 'file', size: 12, rev: 'rev-2', content: 'MODEL-BYTES-1' },
    { id: 'id:file-2', name: 'plan.ifc', parentId: 'id:f-alpha', kind: 'file', size: 8, content: 'MODEL-BYTES-2' },
    { id: 'id:f-alpha-sub', name: 'Sub', parentId: 'id:f-alpha', kind: 'folder' },
    { id: 'id:file-3', name: 'model-copy.ifc', parentId: 'id:f-beta', kind: 'file', size: 4, content: 'MODEL-BYTES-3' },
  ],
  revisionsByFileId: {
    'id:file-1': [
      { rev: 'rev-2', size: 12, server_modified: '2026-08-10T00:00:00Z', content: 'MODEL-BYTES-1' },
      { rev: 'rev-1', size: 8, server_modified: '2026-08-01T00:00:00Z', content: 'MODEL-BYTES-1-OLD' },
    ],
  },
};

const fixtures: ConformanceFixtures = {
  projectId: 'me',
  containerWithChildrenId: 'id:f-alpha',
  containerWithFilesId: 'id:f-alpha',
  searchQuery: 'model',
  // No `fileWithRevisions`, deliberately — for a *different* reason than
  // `source-msgraph`'s (theirs: `downloadHistoricalRevisions` is `false`,
  // gating the check off regardless). Here `downloadHistoricalRevisions` is
  // `true` — Dropbox's `files/download` genuinely serves a `"rev:<rev-id>"`
  // path directly — but supplying this fixture would also opt into
  // `packages/source-fixture/src/conformance/paging.ts`'s unconditional
  // "listRevisions: a real page boundary forces cursor-following to work"
  // check, which assumes every `revisionHistory` provider's revision list is
  // cursor-paginated. Dropbox's `files/list_revisions` genuinely is not: one
  // call returns up to `limit` (max 100) entries with no continuation
  // concept at all (see the doc comment on `listRevisions()` in
  // `provider.ts`) — there is no second page for that check to force. Both
  // properties this fixture would otherwise exercise — `download()` honoring
  // `revisionId` with distinct bytes, and `listRevisions` ordering/size — are
  // covered directly in `provider.test.ts` instead.
  //
  // No `secondProjectId`: this provider exposes exactly one project (the
  // signed-in user's own Dropbox) — see `MY_DROPBOX_PROJECT_ID`'s doc
  // comment in `provider.ts`.
};

describe('DropboxProvider conformance', () => {
  const provider = new DropboxProvider();
  const fetchImpl = () => createDropboxMockContext(WORLD, { defaultPageSize: 200 });

  runConformanceSuite(provider, {
    createContext: fetchImpl,
    fixtures,
    smallPageLimit: 1,
    watchRevisionsHasDeltaFeed: true,
  });
});
