/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `getCommitIndex` (and the `getPinnedModels` cache it shares with
 * `revision-methods.ts`): sweeping a project's version sets into a
 * per-model commit history.
 *
 * The field shapes mirrored here — date-only `lastModified`, a real
 * `version` revision number on a plain `files` area — are the ones a live
 * Dalux Build project was measured sending (2026-09-26, 22 version sets, 75
 * IFC files): every revision uploaded on one calendar day ties on
 * timestamp, which is why `version` has to outrank it.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { getCommitIndex, invalidateCommitIndex } from '../src/commit-index.js';
import { getPinnedModels, invalidatePinnedModels } from '../src/version-set-browse.js';
import { BrowserDaluxApiClient } from '../src/http-client.js';
import {
  createDaluxApiMock,
  createDaluxMockContext,
  DALUX_MOCK_BASE_URL,
  type DaluxMockWorld,
} from './dalux-api-mock.js';

function clientFor(world: DaluxMockWorld, pageSize = 1): BrowserDaluxApiClient {
  const ctx = createDaluxMockContext(createDaluxApiMock(world, { pageSize }));
  return new BrowserDaluxApiClient({ baseUrl: DALUX_MOCK_BASE_URL, apiKey: 'test-key' }, ctx);
}

function revision(id: string, version: string, lastModified: string, contentHash: string) {
  return { fileRevisionId: id, content: `BYTES-${id}`, version, lastModified, contentHash };
}

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
          folders: [],
          files: [
            {
              fileId: 'file-structural',
              fileName: 'structural.ifc',
              fileRevisionId: 'rev-3',
              contentHash: 'hash-3',
              content: 'BYTES-rev-3',
              revisions: [
                revision('rev-1', '1', '2026-03-03', 'hash-1'),
                revision('rev-2', '2', '2026-09-12', 'hash-2'),
                revision('rev-3', '3', '2026-09-25', 'hash-3'),
              ],
            },
            { fileId: 'file-spec', fileName: 'spec.pdf', fileRevisionId: 'rev-spec', content: 'SPEC' },
          ],
        },
      ],
    },
  ],
};

// `versionSets` lives per-project. Rebuilt here as a function so each test
// gets its own set list rather than sharing (and mutating) one module-level
// array.
function worldWithSets(sets: DaluxMockWorld['projects'][number]['versionSets']): DaluxMockWorld {
  return {
    projects: [{ ...WORLD.projects[0], versionSets: sets }],
  };
}

describe('getCommitIndex', () => {
  beforeEach(() => {
    invalidateCommitIndex();
  });

  it('keeps only model files, dropping the documents a set also pins', async () => {
    const client = clientFor(
      worldWithSets([
        { versionSetId: 'vs-1', name: 'Initial delivery', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-1', 'file-spec': 'rev-spec' } },
      ]),
    );
    const index = await getCommitIndex(client, 'p-alpha');
    expect([...index.models.keys()]).toEqual(['file-structural']);
  });

  it('collapses two sets pinning the same revision into one commit', async () => {
    const client = clientFor(
      worldWithSets([
        { versionSetId: 'vs-2', name: 'Coordination round 14', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-2' } },
        { versionSetId: 'vs-3', name: 'Issued for tender', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-2' } },
      ]),
    );
    const index = await getCommitIndex(client, 'p-alpha');
    const history = index.models.get('file-structural')!;
    expect(history.commits).toHaveLength(1);
    expect(history.commits[0].versionSets.map((set) => set.versionSetId)).toEqual(['vs-2', 'vs-3']);
  });

  it('orders by revision number when every timestamp ties (Dalux sends date-only timestamps)', async () => {
    const flat = (id: string, version: string) => revision(id, version, '2026-09-25', `hash-${id}`);
    const client = clientFor({
      projects: [
        {
          ...WORLD.projects[0],
          fileAreas: [
            {
              ...WORLD.projects[0].fileAreas[0],
              files: [
                {
                  fileId: 'file-structural',
                  fileName: 'structural.ifc',
                  fileRevisionId: 'rev-3',
                  content: 'BYTES-rev-3',
                  revisions: [flat('rev-1', '1'), flat('rev-2', '2'), flat('rev-3', '3')],
                },
              ],
            },
          ],
          versionSets: [
            { versionSetId: 'vs-1', name: 'Set 1', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-1' } },
            { versionSetId: 'vs-2', name: 'Set 2', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-2' } },
            { versionSetId: 'vs-3', name: 'Set 3', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-3' } },
          ],
        },
      ],
    });
    const index = await getCommitIndex(client, 'p-alpha');
    const ids = index.models.get('file-structural')!.commits.map((commit) => commit.revisionId);
    expect(ids).toEqual(['rev-3', 'rev-2', 'rev-1']);
  });

  it('falls back to sweep order when neither revision numbers nor timestamps separate the rows', async () => {
    const bare = (id: string) => ({ fileRevisionId: id, content: `BYTES-${id}`, lastModified: '2026-09-25' });
    const client = clientFor({
      projects: [
        {
          ...WORLD.projects[0],
          fileAreas: [
            {
              ...WORLD.projects[0].fileAreas[0],
              files: [
                {
                  fileId: 'file-structural',
                  fileName: 'structural.ifc',
                  fileRevisionId: 'rev-3',
                  content: 'BYTES-rev-3',
                  revisions: [bare('rev-1'), bare('rev-2'), bare('rev-3')],
                },
              ],
            },
          ],
          versionSets: [
            { versionSetId: 'vs-1', name: 'Set 1', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-1' } },
            { versionSetId: 'vs-2', name: 'Set 2', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-2' } },
            { versionSetId: 'vs-3', name: 'Set 3', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-3' } },
          ],
        },
      ],
    });
    const index = await getCommitIndex(client, 'p-alpha');
    // Last set swept wins as newest — a stated assumption about an
    // undocumented list order, and the only signal left once revision
    // numbers and timestamps both tie.
    const ids = index.models.get('file-structural')!.commits.map((commit) => commit.revisionId);
    expect(ids).toEqual(['rev-3', 'rev-2', 'rev-1']);
  });

  it('marks the index truncated past the version-set sweep ceiling', async () => {
    const sets = Array.from({ length: 251 }, (_, i) => ({
      versionSetId: `vs-${i}`,
      name: `Set ${i}`,
      fileAreaId: 'fa-models',
      files: {},
    }));
    const client = clientFor(worldWithSets(sets), 50);
    const index = await getCommitIndex(client, 'p-alpha');
    expect(index.truncated).toBe(true);
    expect(index.versionSetCount).toBe(250);
  });

  it('shares its per-set fetch with getPinnedModels, and both share one sweep per TTL window', async () => {
    const spec = worldWithSets([
      { versionSetId: 'vs-1', name: 'Initial delivery', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-1' } },
    ]);
    let requests = 0;
    const inner = createDaluxApiMock(spec, { pageSize: 1 });
    const counting: typeof fetch = (input, init) => {
      requests += 1;
      return inner(input, init);
    };
    const client = new BrowserDaluxApiClient(
      { baseUrl: DALUX_MOCK_BASE_URL, apiKey: 'test-key' },
      createDaluxMockContext(counting),
    );

    await getCommitIndex(client, 'p-alpha');
    const afterFirstSweep = requests;
    // A caller browsing the same set directly reuses the fetch the sweep
    // already made, rather than re-requesting its files.
    await getPinnedModels(client, 'p-alpha', 'vs-1');
    expect(requests).toBe(afterFirstSweep);

    // A second call to the index itself, still within the TTL, is free too.
    await getCommitIndex(client, 'p-alpha');
    expect(requests).toBe(afterFirstSweep);
  });

  it('invalidateCommitIndex also drops the pinned-models cache, so a refresh re-sweeps', async () => {
    const spec = worldWithSets([
      { versionSetId: 'vs-1', name: 'Initial delivery', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-1' } },
    ]);
    let requests = 0;
    const inner = createDaluxApiMock(spec, { pageSize: 1 });
    const counting: typeof fetch = (input, init) => {
      requests += 1;
      return inner(input, init);
    };
    const client = new BrowserDaluxApiClient(
      { baseUrl: DALUX_MOCK_BASE_URL, apiKey: 'test-key' },
      createDaluxMockContext(counting),
    );

    await getCommitIndex(client, 'p-alpha');
    const afterFirstSweep = requests;
    invalidateCommitIndex();
    await getCommitIndex(client, 'p-alpha');
    expect(requests).toBeGreaterThan(afterFirstSweep);
  });
});

describe('getPinnedModels', () => {
  beforeEach(() => {
    invalidatePinnedModels();
    invalidateCommitIndex();
  });

  it('drops a pinned row with no revision id', async () => {
    // Dalux does send an empty-string `fileRevisionId` (see the note on
    // `LATEST_REVISION` in `mapping.ts`); pinning it this way is the only
    // path that reaches this provider's own drop-check rather than the
    // mock's own "nothing to pin" filter.
    const client = clientFor({
      projects: [
        {
          ...WORLD.projects[0],
          fileAreas: [
            {
              ...WORLD.projects[0].fileAreas[0],
              files: [{ fileId: 'file-blank', fileName: 'blank.ifc', fileRevisionId: '', content: 'X' }],
            },
          ],
          versionSets: [
            { versionSetId: 'vs-1', name: 'Set', fileAreaId: 'fa-models', files: { 'file-blank': '' } },
          ],
        },
      ],
    });
    const pinned = await getPinnedModels(client, 'p-alpha', 'vs-1');
    expect(pinned).toEqual([]);
  });
});
