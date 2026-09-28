/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The commit conformance suite against the real `DaluxBuildProvider`, driven
 * by the Dalux REST mock — the same arrangement as `conformance.test.ts` for
 * the 2.0.0 surface.
 *
 * What this is really checking is the MAPPING: that version sets, which are
 * project-wide snapshots pinning one revision of every file, come back out
 * as a per-model history the contract accepts — newest first, one commit per
 * distinct revision, parents that resolve, and bytes that match the commit
 * the host asked for.
 */

import { beforeEach, describe } from 'vitest';

import { runCommitConformanceSuite } from '@ifc-lite/source-fixture/conformance';

import { DaluxBuildProvider } from '../src/provider.js';
import { invalidateCommitIndex } from '../src/commit-index.js';
import {
  createDaluxApiMock,
  createDaluxMockContext,
  type DaluxMockWorld,
} from './dalux-api-mock.js';

/**
 * One file area, one model file with three revisions, and four version sets:
 *
 *   vs-1  "Initial delivery"      pins structural rev-1
 *   vs-2  "Coordination round 14" pins structural rev-2
 *   vs-3  "Issued for tender"     pins structural rev-2  ← SAME revision
 *   vs-4  "Coordination round 15" pins structural rev-3
 *
 * vs-3 is the case the mapping exists to get right: the model did not change
 * between vs-2 and vs-3, so it must read as ONE commit carrying both set
 * names — not as two versions of a model that was never edited.
 *
 * `site.ifc` appears in one set only, so the suite also covers a model whose
 * whole history is a single commit.
 */
const WORLD: DaluxMockWorld = {
  projects: [
    {
      projectId: 'p-alpha',
      projectName: 'Alpha Tower',
      fileAreas: [
        {
          fileAreaId: 'fa-models',
          fileAreaName: 'Models',
          fileAreaType: 'DOCUMENTS',
          folders: [{ folderId: 'fld-ifc', folderName: 'IFC' }],
          files: [
            {
              fileId: 'file-structural',
              fileName: 'structural.ifc',
              folderId: 'fld-ifc',
              fileRevisionId: 'rev-structural-3',
              contentHash: 'hash-structural-3',
              content: 'STRUCTURAL-R3',
              revisions: [
                {
                  fileRevisionId: 'rev-structural-1',
                  content: 'STRUCTURAL-R1',
                  contentHash: 'hash-structural-1',
                  version: '1',
                  lastModified: '2026-03-03T08:00:00Z',
                  lastModifiedByUserId: 'user-holm',
                  fileSize: 13,
                },
                {
                  fileRevisionId: 'rev-structural-2',
                  content: 'STRUCTURAL-R2',
                  contentHash: 'hash-structural-2',
                  version: '2',
                  lastModified: '2026-09-12T11:30:00Z',
                  lastModifiedByUserId: 'user-berg',
                  fileSize: 13,
                },
                {
                  fileRevisionId: 'rev-structural-3',
                  content: 'STRUCTURAL-R3',
                  contentHash: 'hash-structural-3',
                  version: '3',
                  lastModified: '2026-09-25T09:15:00Z',
                  lastModifiedByUserId: 'user-hansen',
                  fileSize: 13,
                },
              ],
            },
            {
              fileId: 'file-site',
              fileName: 'site.ifc',
              folderId: 'fld-ifc',
              fileRevisionId: 'rev-site-1',
              contentHash: 'hash-site-1',
              content: 'SITE-R1',
              revisions: [
                {
                  fileRevisionId: 'rev-site-1',
                  content: 'SITE-R1',
                  contentHash: 'hash-site-1',
                  version: '1',
                  lastModified: '2026-03-03T08:00:00Z',
                  fileSize: 7,
                },
              ],
            },
            // A document, not a model: it is pinned by every set and must
            // never appear as a model.
            {
              fileId: 'file-spec',
              fileName: 'specification.pdf',
              folderId: 'fld-ifc',
              fileRevisionId: 'rev-spec-1',
              content: 'SPEC',
            },
          ],
        },
      ],
      versionSets: [
        {
          versionSetId: 'vs-1',
          name: 'Initial delivery',
          fileAreaId: 'fa-models',
          files: { 'file-structural': 'rev-structural-1', 'file-site': 'rev-site-1', 'file-spec': 'rev-spec-1' },
        },
        {
          versionSetId: 'vs-2',
          name: 'Coordination round 14',
          fileAreaId: 'fa-models',
          files: { 'file-structural': 'rev-structural-2', 'file-spec': 'rev-spec-1' },
        },
        {
          versionSetId: 'vs-3',
          name: 'Issued for tender',
          fileAreaId: 'fa-models',
          files: { 'file-structural': 'rev-structural-2' },
        },
        {
          versionSetId: 'vs-4',
          name: 'Coordination round 15',
          fileAreaId: 'fa-models',
          files: { 'file-structural': 'rev-structural-3' },
        },
      ],
    },
  ],
};

describe('DaluxBuildProvider — version sets as commit history', () => {
  const provider = new DaluxBuildProvider();
  // One row per response, as everywhere else in this package: Dalux picks
  // its own page size, so the version-set sweep has to follow bookmarks for
  // both the set listing AND every set's file listing.
  const fetchImpl = createDaluxApiMock(WORLD, { pageSize: 1 });

  beforeEach(() => {
    // The index is cached per project for five minutes and shared across
    // contexts; leaving it in place would let one suite's sweep answer the
    // next one's, which is exactly the staleness a test must not have.
    invalidateCommitIndex();
  });

  runCommitConformanceSuite(provider, {
    createContext: () => createDaluxMockContext(fetchImpl),
    fixtures: {
      projectId: 'p-alpha',
      modelId: 'file-structural',
    },
    // The bytes are `ifc-step`; `ifcx` is a format Dalux would serve for a
    // `.ifcx` file and never for this one, so it is the honest way to prove
    // `loadCommit` refuses rather than substituting.
    unsupportedFormat: 'ifcx',
  });
});
