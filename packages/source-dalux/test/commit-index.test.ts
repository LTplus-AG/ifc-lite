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

  // Review on #8647 (louistrue, 2 Nov): the old comparator compared revision
  // numbers only when both sides had one, timestamps otherwise. With A (rev
  // 2, newest date), B (no number, middle date), C (rev 3, oldest date),
  // that rule gives C > A by number, A > B by date, and B > C by date -- a
  // cycle, so `Array.prototype.sort`'s result depends on which pairs it
  // happens to compare, i.e. on input order. Run every permutation of the
  // sweep order and require the identical result each time.
  it('orders a mix of numbered and unnumbered revisions the same way regardless of sweep order', async () => {
    const mixed = (id: string, version: string | undefined, lastModified: string) => ({
      fileRevisionId: id,
      content: `BYTES-${id}`,
      ...(version !== undefined ? { version } : {}),
      lastModified,
    });
    const world: DaluxMockWorld = {
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
                  fileRevisionId: 'rev-A',
                  content: 'BYTES-rev-A',
                  revisions: [
                    mixed('rev-A', '2', '2026-01-03'),
                    mixed('rev-B', undefined, '2026-01-02'),
                    mixed('rev-C', '3', '2026-01-01'),
                  ],
                },
              ],
            },
          ],
          versionSets: [
            { versionSetId: 'vs-A', name: 'Set A', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-A' } },
            { versionSetId: 'vs-B', name: 'Set B', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-B' } },
            { versionSetId: 'vs-C', name: 'Set C', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-C' } },
          ],
        },
      ],
    };

    const permutationsOf = <T,>(items: readonly T[]): T[][] => {
      if (items.length <= 1) return [items.slice()];
      const out: T[][] = [];
      for (let i = 0; i < items.length; i++) {
        const rest = [...items.slice(0, i), ...items.slice(i + 1)];
        for (const tail of permutationsOf(rest)) out.push([items[i], ...tail]);
      }
      return out;
    };

    let result: string[] | undefined;
    for (const order of permutationsOf(world.projects[0].versionSets!)) {
      invalidateCommitIndex();
      const client = clientFor({ projects: [{ ...world.projects[0], versionSets: order }] });
      const index = await getCommitIndex(client, 'p-alpha');
      const ids = index.models.get('file-structural')!.commits.map((commit) => commit.revisionId);
      if (result === undefined) {
        result = ids;
      } else {
        expect(ids).toEqual(result);
      }
    }
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

  // Review on #8647: the cache key was `baseUrl|projectId` only, so a node
  // switch or API-key rotation within the TTL silently returned the
  // PREVIOUS credential's index.
  it('does not share a cached index across different credentials at the same base URL', async () => {
    const spec = worldWithSets([
      { versionSetId: 'vs-1', name: 'Initial delivery', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-1' } },
    ]);
    let requests = 0;
    const inner = createDaluxApiMock(spec, { pageSize: 1 });
    const counting: typeof fetch = (input, init) => {
      requests += 1;
      return inner(input, init);
    };
    const ctx = createDaluxMockContext(counting);
    const keyOne = new BrowserDaluxApiClient({ baseUrl: DALUX_MOCK_BASE_URL, apiKey: 'key-one' }, ctx);
    const keyTwo = new BrowserDaluxApiClient({ baseUrl: DALUX_MOCK_BASE_URL, apiKey: 'key-two' }, ctx);

    await getCommitIndex(keyOne, 'p-alpha');
    const afterFirstKey = requests;
    // A different key, same TTL window: must not reuse `keyOne`'s sweep.
    await getCommitIndex(keyTwo, 'p-alpha');
    expect(requests).toBeGreaterThan(afterFirstKey);
    const afterSecondKey = requests;
    // `keyOne`'s own entry is still there, untouched by `keyTwo`'s sweep.
    await getCommitIndex(keyOne, 'p-alpha');
    expect(requests).toBe(afterSecondKey);
  });

  // Review on #8647: a failed `/files` call was logged at debug level and
  // skipped, `truncated` stayed `false`, and the (incomplete) result was
  // cached for the full TTL.
  it('marks the index partial, and retries sooner than a complete sweep would', async () => {
    const spec = worldWithSets([
      { versionSetId: 'vs-good', name: 'Good set', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-1' } },
      { versionSetId: 'vs-bad', name: 'Bad set', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-1' } },
    ]);
    const inner = createDaluxApiMock(spec, { pageSize: 50 });
    let failBadSet = true;
    let requestsToBadSet = 0;
    const flaky: typeof fetch = (input, init) => {
      const href = typeof input === 'object' && input !== null && 'url' in input ? input.url : input.toString();
      const url = new URL(href);
      if (url.pathname.includes('/version_sets/vs-bad/files')) {
        requestsToBadSet += 1;
        if (failBadSet) return Promise.resolve(new Response('boom', { status: 500, statusText: 'Error' }));
      }
      return inner(input, init);
    };
    const client = new BrowserDaluxApiClient({ baseUrl: DALUX_MOCK_BASE_URL, apiKey: 'test-key' }, createDaluxMockContext(flaky));

    const first = await getCommitIndex(client, 'p-alpha', undefined, 0);
    expect(first.partial).toBe(true);
    expect(first.truncated).toBe(false);
    // Failure isolation: the set that DID list must still contribute.
    expect(first.models.has('file-structural')).toBe(true);

    // Still within a COMPLETE sweep's TTL, but past the shorter partial one:
    // a partial result must not be remembered for the full window.
    failBadSet = false;
    const requestsBeforeRetry = requestsToBadSet;
    const second = await getCommitIndex(client, 'p-alpha', undefined, 60_000);
    expect(requestsToBadSet).toBeGreaterThan(requestsBeforeRetry);
    expect(second.partial).toBe(false);
  });

  // Review on #8647: `index.catch(() => cache.delete(key))` deleted
  // whatever entry was under the key, so a build that outlives the TTL could
  // delete a SECOND, already-started build's entry out from under it when
  // the first one finally rejected.
  it('a rejected sweep evicts only its own cache entry, not a newer one', async () => {
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    const client = new BrowserDaluxApiClient(
      { baseUrl: DALUX_MOCK_BASE_URL, apiKey: 'test-key' },
      createDaluxMockContext(async (input, init) => {
        callCount += 1;
        if (callCount === 1) {
          await firstGate;
          throw new Error('first sweep network failure');
        }
        return createDaluxApiMock(worldWithSets([]), { pageSize: 1 })(input, init);
      }),
    );

    // Starts the first sweep (now = 0); it hangs on `firstGate`.
    const first = getCommitIndex(client, 'p-alpha', undefined, 0);
    // A second call, past the first's TTL, starts a SECOND sweep under the
    // same key and succeeds immediately.
    const second = await getCommitIndex(client, 'p-alpha', undefined, 10 * 60_000);
    expect(second.models.size).toBe(0);
    // Now let the first sweep's rejection land.
    resolveFirst();
    await expect(first).rejects.toThrow('first sweep network failure');

    // The second sweep's entry must still be cached -- a third call at the
    // same `now` must not re-sweep.
    const requestsBeforeThird = callCount;
    await getCommitIndex(client, 'p-alpha', undefined, 10 * 60_000);
    expect(callCount).toBe(requestsBeforeThird);
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
