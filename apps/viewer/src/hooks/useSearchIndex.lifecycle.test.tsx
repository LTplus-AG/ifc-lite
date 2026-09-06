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
