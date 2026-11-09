/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `DaluxBuildProvider.listRevisions`, end to end: this is what
 * `SourceResourceDetails.tsx` (the viewer's per-file "Versions" panel)
 * calls, and before this change it always got back `{ items: [] }` — Dalux
 * declared `capabilities.revisionHistory: false`, so the panel showed "no
 * versions" for every file regardless of how many revisions a version set
 * had actually pinned.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { DaluxBuildProvider } from '../src/provider.js';
import { invalidateCommitIndex } from '../src/commit-index.js';
import { fileAreaContainerId } from '../src/mapping.js';
import { createDaluxApiMock, createDaluxMockContext, type DaluxMockWorld } from './dalux-api-mock.js';

const REF = { projectId: 'p-alpha', containerId: fileAreaContainerId('fa-models'), fileId: 'file-structural' };

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
                { fileRevisionId: 'rev-1', content: 'BYTES-rev-1', version: '1', lastModified: '2026-03-03', contentHash: 'hash-1' },
                { fileRevisionId: 'rev-2', content: 'BYTES-rev-2', version: '2', lastModified: '2026-09-12', contentHash: 'hash-2' },
                { fileRevisionId: 'rev-3', content: 'BYTES-rev-3', version: '3', lastModified: '2026-09-25', contentHash: 'hash-3' },
              ],
            },
          ],
        },
      ],
      versionSets: [
        { versionSetId: 'vs-1', name: 'Initial delivery', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-1' } },
        { versionSetId: 'vs-2', name: 'Coordination round 14', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-2' } },
        { versionSetId: 'vs-3', name: 'Issued for tender', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-2' } },
        { versionSetId: 'vs-4', name: 'Coordination round 15', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-3' } },
      ],
    },
  ],
};

function setup(world: DaluxMockWorld = WORLD) {
  invalidateCommitIndex();
  const provider = new DaluxBuildProvider();
  const ctx = createDaluxMockContext(createDaluxApiMock(world, { pageSize: 1 }));
  return { provider, ctx };
}

describe('DaluxBuildProvider.listRevisions', () => {
  beforeEach(() => {
    invalidateCommitIndex();
    });

  it('declares the capability it now implements', () => {
    const provider = new DaluxBuildProvider();
    expect(provider.manifest.capabilities.revisionHistory).toBe(true);
    expect(typeof provider.listRevisions).toBe('function');
  });

  it('lists revisions newest first, labelled with the version-set name', async () => {
    const { provider, ctx } = setup();
    const page = await provider.listRevisions!(ctx, REF);
    expect(page.items.map((revision) => revision.id)).toEqual(['rev-3', 'rev-2', 'rev-1']);
    expect(page.items[0].label).toContain('Coordination round 15');
    expect(page.items[0].label).toContain('Rev 3');
  });

  it('collapses two version sets pinning the same revision into one revision row, naming both', async () => {
    const { provider, ctx } = setup();
    const page = await provider.listRevisions!(ctx, REF);
    const shared = page.items.find((revision) => revision.id === 'rev-2')!;
    expect(shared.label).toContain('Coordination round 14');
    expect(shared.label).toContain('Issued for tender');
  });

  it('includes the current revision when no version set covers the file (#8648)', async () => {
    const { provider, ctx } = setup({ projects: [{ ...WORLD.projects[0], versionSets: [] }] });
    const page = await provider.listRevisions!(ctx, REF);
    expect(page.items.map((revision) => revision.id)).toEqual(['rev-3']);
  });

  it('honors revisionId on download — two listed revisions yield different bytes', async () => {
    // The property the generic cross-provider conformance suite would have
    // asserted via a `fileWithRevisions` fixture; asserted directly here
    // instead, since this provider's `listRevisions` answers from an
    // in-memory index with no server page boundary for that suite's
    // cursor-following check to exercise (see `conformance.test.ts`).
    const { provider, ctx } = setup();
    const page = await provider.listRevisions!(ctx, REF);
    expect(page.items.length).toBeGreaterThanOrEqual(2);

    const [a, b] = await Promise.all(
      page.items.slice(0, 2).map((revision) => provider.download(ctx, { ...REF, revisionId: revision.id })),
    );
    expect(new TextDecoder().decode(a)).not.toBe(new TextDecoder().decode(b));
  });

  it('shares one sweep across repeated calls for the same project', async () => {
    let requests = 0;
    const inner = createDaluxApiMock(WORLD, { pageSize: 1 });
    const counting: typeof fetch = (input, init) => {
      requests += 1;
      return inner(input, init);
    };
    const provider = new DaluxBuildProvider();
    const ctx = createDaluxMockContext(counting);

    await provider.listRevisions!(ctx, REF);
    const afterFirst = requests;
    await provider.listRevisions!(ctx, REF);
    expect(requests).toBe(afterFirst + 1); // fresh current metadata; project sweep stays cached
  });
});

// Review regressions for #8648: current/unpinned files and honest failure states.
describe('revision history completeness (#8648)', () => {
  it('includes an unpinned current revision before older coordination pins', async () => {
    const { provider, ctx } = setup({ projects: [{ ...WORLD.projects[0], versionSets: WORLD.projects[0].versionSets?.slice(0, 3) }] });
    expect((await provider.listRevisions!(ctx, REF)).items.map((r) => r.id)).toEqual(['rev-3', 'rev-2', 'rev-1']);
  });

  it('shows an unavailable date instead of epoch and omits raw author IDs', async () => {
    const base = WORLD.projects[0];
    const world: DaluxMockWorld = { projects: [{ ...base, versionSets: [], fileAreas: [{ ...base.fileAreas[0], files: [{ ...base.fileAreas[0].files[0], lastModified: undefined, uploaded: undefined, uploadedByUserId: 'raw-user-id' }] }] }] };
    const { provider, ctx } = setup(world);
    const current = (await provider.listRevisions!(ctx, REF)).items[0];
    expect(current.createdAt).toBe('');
    expect(current.createdBy).toBeUndefined();
  });

  it('refuses an oversized history instead of implying arbitrary pins are newest', async () => {
    const sets = Array.from({ length: 251 }, (_, i) => ({ versionSetId: `vs-${i}`, name: `Set ${i}`, fileAreaId: 'fa-models', files: {} }));
    const { provider, ctx } = setup({ projects: [{ ...WORLD.projects[0], versionSets: sets }] });
    await expect(provider.listRevisions!(ctx, REF)).rejects.toThrow(/more than 250 version sets/);
  });

  it('reports a failed set listing to the host rather than returning partial rows', async () => {
    invalidateCommitIndex();
    const inner = createDaluxApiMock(WORLD);
    const ctx = createDaluxMockContext(async (input, init) => {
      const url = typeof input === 'object' && 'url' in input ? input.url : String(input);
      if (url.includes('/version_sets/vs-1/files')) return new Response('unavailable', { status: 503 });
      return inner(input, init);
    });
    await expect(new DaluxBuildProvider().listRevisions!(ctx, REF)).rejects.toThrow(/incomplete/);
  });
});
