/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Runs the shared `FileSourceProvider` conformance suite against the real
// `DaluxBuildProvider`, driven by `createDaluxApiMock`'s stand-in for the
// Dalux Build REST API (#2493). The kit named Dalux as a consumer from the
// day it was written but nothing ever ran it here, so nothing checked that
// the provider matches the capabilities its own manifest declares.

import { describe } from 'vitest';

import type { ConformanceFixtures } from '@ifc-lite/source-fixture/conformance';
import { runConformanceSuite } from '@ifc-lite/source-fixture/conformance';

import { DaluxBuildProvider } from '../src/provider.js';
import { fileAreaContainerId } from '../src/mapping.js';
import {
  createDaluxApiMock,
  createDaluxMockContext,
  type DaluxMockWorld,
  type DaluxRemainingSemantics,
} from './dalux-api-mock.js';

/**
 * Two projects (so `listProjects` has a second item to page past), and a
 * file area whose folders nest two deep with files at every level — enough
 * for the recursive-listing, connected-subtree and cross-reference checks
 * to all have something real to fail on.
 */
const WORLD: DaluxMockWorld = {
  projects: [
    {
      projectId: 'p-alpha',
      projectName: 'Alpha Tower',
      fileAreas: [
        {
          fileAreaId: 'fa-docs',
          fileAreaName: 'Documents',
          fileAreaType: 'DOCUMENTS',
          folders: [
            { folderId: 'fld-design', folderName: 'Design' },
            { folderId: 'fld-structural', folderName: 'Structural', parentFolderId: 'fld-design' },
            { folderId: 'fld-ifc', folderName: 'IFC', parentFolderId: 'fld-structural' },
          ],
          files: [
            {
              fileId: 'file-root-readme',
              fileName: 'readme.txt',
              fileRevisionId: 'rev-root-1',
              fileType: 'text/plain',
              content: 'ROOT-README',
            },
            {
              fileId: 'file-structural-model',
              fileName: 'structural.ifc',
              folderId: 'fld-structural',
              fileRevisionId: 'rev-structural-2',
              fileType: 'application/octet-stream',
              content: 'STRUCTURAL-MODEL-BYTES',
            },
            {
              fileId: 'file-deep-model',
              fileName: 'deep.ifc',
              folderId: 'fld-ifc',
              contentHash: 'hash-deep-1',
              fileType: 'application/octet-stream',
              content: 'DEEP-MODEL-BYTES',
            },
            {
              fileId: 'file-deleted',
              fileName: 'gone.ifc',
              folderId: 'fld-ifc',
              fileRevisionId: 'rev-gone-1',
              deleted: true,
              content: 'NEVER-SERVED',
            },
          ],
        },
        {
          fileAreaId: 'fa-models',
          fileAreaName: 'Models',
          fileAreaType: 'DOCUMENTS',
          folders: [],
          files: [],
        },
      ],
    },
    {
      projectId: 'p-beta',
      projectName: 'Beta Campus',
      fileAreas: [],
    },
  ],
};

const fixtures: ConformanceFixtures = {
  projectId: 'p-alpha',
  containerWithChildrenId: fileAreaContainerId('fa-docs'),
  containerWithFilesId: fileAreaContainerId('fa-docs'),
  secondProjectId: 'p-beta',
  // No revision-history endpoint exists (capabilities.revisionHistory is
  // false), so there is no `fileWithRevisions` to point the suite at.
};

/**
 * The same provider and the same world, browsed once per shape Dalux's
 * `metadata.totalRemainingItems` arrives in. That field carries no authority
 * over whether more pages exist — the `nextPage` link does — so every
 * reading must produce identical browsing.
 *
 * `'total'` is deliberately absent, and it is the interesting one: it is the
 * shape observed live on `GET /5.1/projects` (a complete, link-less page
 * reporting `totalRemainingItems === items.length`), and running the suite
 * against it on current `main` fails ten of these checks with
 * `DaluxPaginationError: pagination truncated`. That is #2252, and #2253
 * fixes it in `fetchPage`. Add `'total'` here once that lands — the mock
 * already serves it, and `dalux-api-mock.test.ts` pins that it serves it
 * faithfully in the meantime.
 */
const remainingShapes: readonly DaluxRemainingSemantics[] = ['after-page', 'omitted'];

for (const remainingSemantics of remainingShapes) {
  describe(`totalRemainingItems=${remainingSemantics}`, () => {
    const provider = new DaluxBuildProvider();
    // One item per response. Dalux picks its own page size and never
    // forwards `ListOptions.limit` (a hint, per the contract), so the only
    // way to force a page boundary is from the server side — which is what
    // `pageBoundary: 'backend'` tells the suite to measure.
    const fetchImpl = createDaluxApiMock(WORLD, { pageSize: 1, remainingSemantics });

    runConformanceSuite(provider, {
      createContext: () => createDaluxMockContext(fetchImpl),
      fixtures,
      pageBoundary: 'backend',
      // Dalux has no delta endpoint: `watchRevisions` re-polls the given
      // refs every call and correctly returns no resumable cursor.
      watchRevisionsHasDeltaFeed: false,
    });
  });
}
