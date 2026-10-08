/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The bSDD picker view model (IDS-069): filters, debounced search, cards. */

import { beforeAll, describe, expect, it } from 'vitest';
import { DEMO, demoClass, demoSource, replayFetch } from '../../test/bsdd/replay.js';
import { specDoc } from '../../test/gate-helpers.js';
import { createGateContext, type GateContext } from '../gate/context.js';
import { cardFromClass, createBsddSearch, initialPickerFilters, type BsddSearchTimers } from './picker.js';
import { BsddUnavailableError, type BsddSource } from './types.js';

let gate: GateContext;
beforeAll(async () => {
  gate = await createGateContext();
});

/** Manual timers: nothing fires until `tick()`. */
function manualTimers(): BsddSearchTimers & { tick(): void; armed(): number[] } {
  const queue = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    set: (fn, ms) => {
      queue.set(next, { fn, ms });
      return next++;
    },
    clear: (h) => {
      queue.delete(h as number);
    },
    tick: () => {
      const due = [...queue.values()];
      queue.clear();
      for (const t of due) t.fn();
    },
    armed: () => [...queue.values()].map((t) => t.ms),
  };
}

describe('initialPickerFilters', () => {
  it('pre-fills the related IFC entity from a single applicability entity, in PascalCase', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    expect(initialPickerFilters(doc, specId, { dictionaryUris: [DEMO], gate })).toEqual({ dictionaryUris: [DEMO], activeOnly: true, relatedIfcEntity: 'IfcWall' });
    const bare = specDoc(['IFC4']);
    expect(initialPickerFilters(bare.doc, bare.specId).relatedIfcEntity).toBeUndefined();
    expect(initialPickerFilters(doc, undefined, { languageCode: 'de' })).toEqual({ dictionaryUris: [], activeOnly: true, languageCode: 'de' });
  });
});

describe('createBsddSearch', () => {
  it('debounces at 250 ms, ignores short queries and hides inactive classes by default', async () => {
    const timers = manualTimers();
    const replay = replayFetch();
    const search = createBsddSearch({ source: demoSource(replay), filters: { dictionaryUris: [], activeOnly: true }, timers });
    search.setQuery('w');
    expect(search.getState().phase).toBe('idle');
    expect(timers.armed()).toEqual([]);
    search.setQuery('wa');
    search.setQuery('wall');
    expect(timers.armed()).toEqual([250]); // the earlier keystroke's timer was cancelled
    expect(search.getState().phase).toBe('debouncing');
    timers.tick();
    await search.flush();
    const state = search.getState();
    expect(replay.requests).toHaveLength(1);
    expect(state.phase).toBe('ready');
    expect(state.total).toBe(4);
    // Search hits carry no status: none is hidden; the class status shows once details load.
    expect(state.cards.map((c) => c.code)).toEqual(['WAL', 'WAL-EXT', 'WAL-INT', 'WAL-PRT']);
    expect(state.cards[0]).toMatchObject({ dictionary: { uri: DEMO, name: 'Demo Elements' }, relatedIfcEntities: ['IfcWall'] });
  });

  it('drops a superseded response', async () => {
    const resolvers: (() => void)[] = [];
    const base = demoSource();
    const slow: BsddSource = {
      ...base,
      searchClasses: (q) => new Promise((resolve) => resolvers.push(() => resolve(base.searchClasses(q)))),
    };
    const timers = manualTimers();
    const search = createBsddSearch({ source: slow, filters: { dictionaryUris: [], activeOnly: false }, timers });
    search.setQuery('door');
    timers.tick();
    search.setQuery('wall');
    timers.tick();
    resolvers[1]();
    await new Promise((r) => setTimeout(r, 0));
    resolvers[0]();
    await search.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(search.getState().cards.map((c) => c.code)).toContain('WAL');
    expect(search.getState().cards.map((c) => c.code)).not.toContain('DOR');
  });

  it('filters out classes marked inactive, unless asked not to', async () => {
    const base = demoSource();
    const withStatus: BsddSource = {
      ...base,
      searchClasses: async (q) => {
        const page = await base.searchClasses(q);
        return { ...page, classes: page.classes.map((c) => (c.code === 'WAL-PRT' ? { ...c, status: 'inactive' as const } : c)) };
      },
    };
    const timers = manualTimers();
    const search = createBsddSearch({ source: withStatus, filters: { dictionaryUris: [], activeOnly: true }, timers });
    search.setQuery('wall');
    await search.flush();
    expect(search.getState().cards.map((c) => c.code)).not.toContain('WAL-PRT');
    search.setFilters({ activeOnly: false });
    await search.flush();
    expect(search.getState().cards.map((c) => c.code)).toContain('WAL-PRT');
  });

  it('reports "offline and not cached" distinctly from other failures', async () => {
    const offline: BsddSource = { ...demoSource(), searchClasses: async () => Promise.reject(new BsddUnavailableError('search:x', { cause: new TypeError('fetch failed') })) };
    const search = createBsddSearch({ source: offline, filters: { dictionaryUris: [], activeOnly: true }, timers: manualTimers() });
    search.setQuery('wall');
    await search.flush();
    expect(search.getState()).toMatchObject({ phase: 'error', offline: true, cards: [] });
  });
});

describe('class cards', () => {
  it('shows status, property count and a preview with the required flag', async () => {
    const cls = await demoSource().getClass(demoClass('DOR'));
    if (!cls) throw new Error('fixture missing');
    const dicts = new Map((await demoSource().listDictionaries()).map((d) => [d.uri, d]));
    const card = cardFromClass(cls, dicts, 2);
    expect(card).toMatchObject({ code: 'DOR', status: 'active', propertyCount: 8, dictionary: { uri: DEMO, name: 'Demo Elements', version: '1.0' } });
    expect(card.properties).toEqual([
      { code: 'FireExit', name: 'FireExit', propertySet: 'Demo_Door', dataType: 'Boolean', required: true },
      { code: 'ClearWidth', name: 'ClearWidth', propertySet: 'Demo_Door', dataType: 'Real', required: true },
    ]);
  });
});
