/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Offline behaviour (IDS-074): a session online fills the IndexedDB cache;
 * a later session with no connection still searches, opens and inserts the
 * classes it saw, and says "offline" for the rest.
 */

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEMO, demoClass, offlineFetch, replayFetch } from '../../test/bsdd/replay.js';
import { ids, specDoc } from '../../test/gate-helpers.js';
import { checkOps } from '../gate/check.js';
import { createGateContext, type GateContext } from '../gate/context.js';
import { createLintContext } from '../lint/context.js';
import { createLinter } from '../lint/engine.js';
import { apply } from '../reducer/apply.js';
import { createCachedBsddSource, createMemoryBsddStore, loadUriIndex, type BsddCacheStore } from './cache.js';
import { createHttpBsddSource } from './http-source.js';
import { createIndexedDbBsddStore } from './idb-store.js';
import { bsddInsertOp, snapshotBsddClass } from './insert.js';
import { createBsddSearch } from './picker.js';
import { BsddHttpError, BsddUnavailableError } from './types.js';
import { checkUriHealth } from './uri-health.js';

const DAY = 24 * 60 * 60 * 1000;
let gate: GateContext;
beforeAll(async () => {
  gate = await createGateContext();
});

/** Timers that never fire: `flush()` runs the pending search. */
const timers = { set: () => 1, clear: () => {} };

describe('IndexedDB-backed bSDD cache', () => {
  it('a later offline session searches, opens and inserts the classes an online session saw', async () => {
    const factory = new IDBFactory();
    let now = 1_700_000_000_000;
    const clock = () => now;
    // Session 1: online.
    const online = createCachedBsddSource(createHttpBsddSource({ fetch: replayFetch().fetch, now: clock }), { store: createIndexedDbBsddStore({ indexedDB: factory, keyRange: IDBKeyRange }), now: clock });
    const search1 = createBsddSearch({ source: online, filters: { dictionaryUris: [], activeOnly: true }, timers });
    search1.setQuery('wall');
    await search1.flush();
    expect(search1.getState().cards).toHaveLength(4);
    await online.getClass(demoClass('WAL-EXT'));
    await online.getDictionary(DEMO);
    await checkUriHealth([demoClass('WAL-PRT')], { source: online, index: await loadUriIndex(createMemoryBsddStore()), sleep: async () => {} });

    // Session 2, two days later: a fresh store object on the same database, and no network.
    now += 2 * DAY;
    const store = createIndexedDbBsddStore({ indexedDB: factory, keyRange: IDBKeyRange });
    const offline = createCachedBsddSource(createHttpBsddSource({ fetch: offlineFetch, now: clock }), { store, now: clock });
    const search2 = createBsddSearch({ source: offline, filters: { dictionaryUris: [], activeOnly: true }, timers });
    search2.setQuery('Wall ');
    await search2.flush();
    expect(search2.getState()).toMatchObject({ phase: 'ready', offline: false });
    expect(search2.getState().cards.map((c) => c.code)).toEqual(['WAL', 'WAL-EXT', 'WAL-INT', 'WAL-PRT']);
    expect(offline.offline).toBe(true); // served stale because bSDD was unreachable

    const cls = await offline.getClass(demoClass('WAL-EXT'));
    if (!cls) throw new Error('class not cached');
    const { doc, specId } = specDoc(['IFC4']);
    const op = bsddInsertOp({ classes: [snapshotBsddClass(cls, { dictionaryName: 'Demo Elements', gate })], target: { specId }, mode: 'both', properties: { select: ['IsExternal'] }, opId: ids() });
    expect(checkOps([op], doc, gate).ok).toBe(true);
    expect(apply(doc, [op]).doc.ids.specifications[0].requirements).toHaveLength(1);

    // The URI-health records of the earlier session drive lint offline.
    const index = await loadUriIndex(store);
    expect(index.get(demoClass('WAL-PRT'))).toMatchObject({ state: 'inactive' });
    const lint = await createLintContext({ gate, bsdd: index });
    const withUri = apply(doc, [bsddInsertOp({ classes: [{ uri: demoClass('WAL-PRT'), code: 'WAL-PRT', name: 'Partition wall', dictionaryUri: DEMO, dictionaryName: 'Demo Elements' }], target: { specId }, mode: 'classification', section: 'requirements', opId: ids() })]).doc;
    expect(createLinter(lint, { rules: ['IDSL-BSDD-001'] }).lint(withUri).diagnostics).toHaveLength(1);

    // What was never seen is reported as offline, not as "no results".
    search2.setQuery('door');
    await search2.flush();
    expect(search2.getState()).toMatchObject({ phase: 'error', offline: true });
    await expect(offline.getClass(demoClass('DOR'))).rejects.toBeInstanceOf(BsddUnavailableError);
  });

  it('serves fresh entries without asking bSDD and refreshes stale ones when online', async () => {
    const store = createMemoryBsddStore();
    let now = 0;
    const replay = replayFetch();
    const src = createCachedBsddSource(createHttpBsddSource({ fetch: replay.fetch }), { store, now: () => now, ttlMs: DAY });
    await src.getClass(demoClass('DOR'));
    await src.getClass(demoClass('DOR'));
    expect(replay.requests).toHaveLength(1);
    now = DAY;
    await src.getClass(demoClass('DOR'));
    expect(replay.requests).toHaveLength(2);
    expect(src.offline).toBe(false);
  });

  it('caches "not found" too, passes definitive HTTP errors through, and treats a damaged entry as a miss', async () => {
    const store = createMemoryBsddStore();
    const replay = replayFetch();
    const src = createCachedBsddSource(createHttpBsddSource({ fetch: replay.fetch }), { store });
    expect(await src.getClass(demoClass('GONE'))).toBeNull();
    expect(await src.getClass(demoClass('GONE'))).toBeNull();
    expect(replay.requests).toHaveLength(1);
    const forbidden = createCachedBsddSource(createHttpBsddSource({ fetch: async () => new Response('{}', { status: 403 }) }), { store: createMemoryBsddStore() });
    await expect(forbidden.getClass(demoClass('WAL'))).rejects.toBeInstanceOf(BsddHttpError);
    const damaged: BsddCacheStore = { ...createMemoryBsddStore(), get: async () => ({ v: 1, kind: 'class', storedAt: Date.now(), value: { uri: 'x' } }) };
    const healed = createCachedBsddSource(createHttpBsddSource({ fetch: replayFetch().fetch }), { store: damaged });
    expect((await healed.getClass(demoClass('WAL')))?.code).toBe('WAL');
  });
});
