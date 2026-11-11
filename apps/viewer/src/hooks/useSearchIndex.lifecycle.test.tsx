/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, StrictMode, useState, type ReactNode } from 'react';
import { createSyntheticDataStore } from '@ifc-lite/parser';
import { render, cleanup, click } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { SearchInline } from '@/components/viewer/SearchInline.js';
import { SearchModal } from '@/components/viewer/SearchModal.js';
import { useSearchIndex } from './useSearchIndex.js';
import { createLoadTracer } from '@ifc-lite/load-trace';
import { publishLoadTrace } from '@/lib/perf/activeLoadTrace.js';
import { collectSearchResults } from '@/lib/search/collect-results.js';

const initial = useViewerStore.getState();
let unsubscribe = () => {};
let starts: string[];
let completions: string[];

function model(id: string) {
  return {
    ...fixtureModel(id),
    ifcDataStore: createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 0, entities: [
      { expressId: 42, type: 'IfcWall', name: 'Wall A', globalId: `${id}-wall` },
      { expressId: 43, type: 'IfcSlab', name: 'Slab B', globalId: `${id}-slab` },
    ] }),
  };
}

function Owner({ children }: { children?: ReactNode }) {
  useSearchIndex();
  return children;
}

function SwitchingToolbar() {
  const [ribbon, setRibbon] = useState(false);
  return <><button onClick={() => setRibbon(value => !value)}>Switch toolbar</button><SearchInline key={String(ribbon)} /><SearchModal /></>;
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  starts = []; completions = [];
  useViewerStore.setState({ ...initial, ...fixtureModels(model('one')), searchIndexes: new Map(), searchFilterSchema: new Map(), searchQuery: 'Wall', searchOpen: true });
  unsubscribe = useViewerStore.subscribe((state, previous) => {
    for (const [id, record] of state.searchIndexes) {
      if (previous.searchIndexes.get(id) === record) continue;
      if (record.status === 'building' && record.progress === 0) starts.push(id);
      if (record.status === 'ready') completions.push(id);
    }
  });
});

afterEach(() => {
  cleanup(); unsubscribe(); useViewerStore.setState(initial, true);
});

describe('one search-index owner across viewer lifecycle (#3993)', () => {
  it('a search issued at interactive, before tier-1 is built, answers from Tier-0 with the results tier-1 gives once ready', async () => {
    const entities = Array.from({ length: 60 }, (_, i) => ({ expressId: 100 + i, type: ['IfcWall', 'IfcSlab', 'IfcDoor', 'IfcSpace'][i % 4],
      name: `${['Wall', 'Slab', 'Door', 'Room'][i % 4]} ${String.fromCharCode(65 + (i % 26))}${i}`, globalId: `g-${i.toString(36)}-${i % 7}` }));
    useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('one'), ifcDataStore: createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 0, entities }) }),
      searchIndexes: new Map(), loading: true });
    const idle: IdleRequestCallback[] = [];
    const originalIdle = window.requestIdleCallback;
    window.requestIdleCallback = ((cb: IdleRequestCallback) => { idle.push(cb); return idle.length; }) as typeof window.requestIdleCallback;
    // Single-term queries. A query with a one-letter word ('Room A') differs by design: tier-1 drops
    // one-letter tokens, Tier-0 matches the whole phrase, as during any in-flight build before this change.
    const queries = ['Wall', 'door', 'Room', 'IfcSlab', 'slab', 'D3', 'nothing-matches'];
    const results = () => { const s = useViewerStore.getState(); return queries.map((q) => collectSearchResults(s.models, s.searchIndexes, q)); };
    try {
      render(<Owner />);
      await settle();
      await act(async () => { useViewerStore.setState({ loading: false }); }); // interactive
      await settle();
      assert.notEqual(useViewerStore.getState().searchIndexes.get('one')?.status, 'ready', 'tier-1 is not built yet at interactive');
      const atInteractive = results();
      assert.ok(atInteractive[0].length > 0 && atInteractive[1].length > 0, 'Tier-0 answers at interactive');
      await act(async () => { for (const cb of idle.splice(0)) cb({ didTimeout: false, timeRemaining: () => 50 }); });
      await settle();
      assert.equal(useViewerStore.getState().searchIndexes.get('one')?.status, 'ready');
      const ids = (rs: ReturnType<typeof results>) => rs.map((r) => r.map((row) => `${row.modelId}:${row.expressId}`).join(','));
      assert.deepEqual(ids(results()), ids(atInteractive), 'the same results, in the same order, once tier-1 answers');
    } finally {
      window.requestIdleCallback = originalIdle;
    }
  });

  it('builds a model published during a load only after the load settles and the page is idle', async () => {
    const idle: IdleRequestCallback[] = [];
    const originalIdle = window.requestIdleCallback;
    window.requestIdleCallback = ((cb: IdleRequestCallback) => { idle.push(cb); return idle.length; }) as typeof window.requestIdleCallback;
    try {
      useViewerStore.setState({ loading: true });
      const container = render(<Owner><SearchInline /></Owner>);
      await settle();
      assert.ok(container.textContent?.includes('Wall A'), 'Tier-0 answers while the build waits');
      assert.deepEqual(completions, [], 'no tier-1 build while the load runs');
      await act(async () => { useViewerStore.setState({ loading: false }); });
      await settle();
      assert.deepEqual(completions, [], 'settled: the build waits for an idle period');
      await act(async () => { for (const cb of idle.splice(0)) cb({ didTimeout: false, timeRemaining: () => 50 }); });
      await settle();
      assert.deepEqual(completions, ['one']);
    } finally {
      window.requestIdleCallback = originalIdle;
    }
  });

  it('records the model\'s first tier-1 build as its load\'s search.tier1 span (#6979)', async () => {
    const tracer = createLoadTracer({ enabled: true, sink: null });
    publishLoadTrace('one', tracer.startLoad('one'));
    render(<Owner />);
    await settle();
    const spans = tracer.latest()!.spans.filter(span => span.name === 'search.tier1');
    assert.equal(spans.length, 1);
    assert.notEqual(spans[0].end, null, 'the span ends when the build resolves');
  });

  it('both mounted search interfaces consume one build and keep immediate Tier-0 results', async () => {
    const container = render(<Owner><SearchInline /><SearchModal /></Owner>);
    assert.ok(container.textContent?.includes('Wall A'));
    await settle();
    assert.deepEqual(starts, ['one']);
    assert.deepEqual(completions, ['one']);
    assert.deepEqual(useViewerStore.getState().searchIndexes.get('one')?.index?.entries.map(entry => entry.name), ['Wall A', 'Slab B']);
  });

  it('toolbar remounts leave the viewer owner and its ready index intact', async () => {
    const container = render(<Owner><SwitchingToolbar /></Owner>);
    await settle();
    const index = useViewerStore.getState().searchIndexes.get('one')?.index;
    click(container.querySelector('button')!);
    await settle();
    assert.equal(useViewerStore.getState().searchIndexes.get('one')?.index, index);
    assert.deepEqual(starts, ['one']);
  });

  it('partial/final wrappers reuse the existing index while another federated model builds', async () => {
    render(<Owner />); await settle();
    const index = useViewerStore.getState().searchIndexes.get('one')?.index;
    act(() => {
      const current = useViewerStore.getState().models.get('one')!;
      useViewerStore.getState().updateModel('one', { ifcDataStore: { ...current.ifcDataStore! } });
      useViewerStore.setState(state => ({ models: new Map([...state.models, ['two', model('two')]]) }));
    });
    await settle();
    assert.deepEqual(starts, ['one', 'two']);
    assert.equal(useViewerStore.getState().searchIndexes.get('one')?.index, index);
    assert.equal(useViewerStore.getState().searchIndexes.get('two')?.index?.modelId, 'two');
  });

  it('StrictMode cleanup releases the building claim for a preloaded model', async () => {
    render(<StrictMode><Owner /></StrictMode>); await settle();
    assert.equal(useViewerStore.getState().searchIndexes.get('one')?.status, 'ready');
    assert.deepEqual(completions, ['one']);
  });

  it('unmount/remount cannot leave building status stranded or let an old promise clear its replacement', async () => {
    render(<Owner />);
    cleanup();
    assert.equal(useViewerStore.getState().searchIndexes.get('one')?.status, 'pending');
    render(<Owner />); await settle();
    assert.equal(useViewerStore.getState().searchIndexes.get('one')?.status, 'ready');
    assert.deepEqual(completions, ['one']);
  });

  it('model removal cancels an unpublished build without resurrecting its result', async () => {
    render(<Owner />);
    act(() => useViewerStore.setState({ models: new Map(), activeModelId: null }));
    await settle();
    assert.equal(useViewerStore.getState().searchIndexes.has('one'), false);
    assert.deepEqual(completions, []);
  });
});
