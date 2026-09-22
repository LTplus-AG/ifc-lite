/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { viewerTeardown } from '@/store/teardown-registry';
import { BrowserTrackingStore, loadSavedFlows, newFlowDocument } from '@/lib/flow/persistence';

class MemoryStorage {
  readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}

const g = globalThis as { localStorage?: unknown };

describe('flowSlice', () => {
  let ls: MemoryStorage;
  beforeEach(() => {
    ls = new MemoryStorage();
    g.localStorage = ls;
    useViewerStore.setState({ savedFlows: [], activeFlowId: null, flowDoc: null, flowDirty: false, flowSelectedNodeId: null, flowRunning: false, flowLastRun: null, flowLastError: null, flowPanelVisible: false });
  });

  it('create → edit → save persists the same document the CLI would run; open restores it', () => {
    const s = useViewerStore.getState();
    const id = s.createFlow('  Audit  ');
    assert.ok(id);
    assert.equal(useViewerStore.getState().flowDoc?.name, 'Audit');
    assert.equal(loadSavedFlows().length, 1);

    const doc = useViewerStore.getState().flowDoc!;
    useViewerStore.getState().setFlowDoc({ ...doc, nodes: [{ id: 'n1', type: 'core.number', params: { value: 3 } }] });
    assert.equal(useViewerStore.getState().flowDirty, true);
    assert.equal(loadSavedFlows()[0].doc.nodes.length, 0, 'not persisted until saved');
    useViewerStore.getState().saveFlow();
    assert.equal(useViewerStore.getState().flowDirty, false);
    assert.equal(loadSavedFlows()[0].doc.nodes[0].id, 'n1');

    useViewerStore.getState().createFlow('Other');
    useViewerStore.getState().openFlow(id!);
    assert.equal(useViewerStore.getState().flowDoc?.nodes[0].id, 'n1');
  });

  it('import keeps the id when free and mints a new one on a collision', () => {
    const doc = { ...newFlowDocument('Imported'), id: 'fixed-id' };
    assert.equal(useViewerStore.getState().importFlow(doc), 'fixed-id');
    const again = useViewerStore.getState().importFlow(doc);
    assert.ok(again && again !== 'fixed-id');
    assert.equal(useViewerStore.getState().savedFlows.length, 2);
  });

  it('delete closes the editor when the open graph is deleted, and clears its tracking sidecar', () => {
    const id = useViewerStore.getState().createFlow('A')!;
    const tracking = new BrowserTrackingStore(id, 'content:x');
    tracking.save({ trackingKey: 'A/n', generation: 0, entries: {} });
    assert.ok(BrowserTrackingStore.read(id));
    useViewerStore.getState().deleteFlow(id);
    assert.equal(useViewerStore.getState().flowDoc, null);
    assert.equal(BrowserTrackingStore.read(id), undefined);
    assert.equal(loadSavedFlows().length, 0);
  });

  it('a session reset closes the panel and drops the run, but keeps the saved graphs and the working copy', () => {
    useViewerStore.getState().createFlow('Kept');
    useViewerStore.setState({ flowPanelVisible: true, flowRunning: true, flowLastError: 'x' });
    useViewerStore.setState(viewerTeardown({ kind: 'session-reset' }, useViewerStore.getState()));
    const s = useViewerStore.getState();
    assert.equal(s.flowPanelVisible, false);
    assert.equal(s.flowRunning, false);
    assert.equal(s.flowLastError, null);
    assert.equal(s.savedFlows.length, 1);
    assert.equal(s.flowDoc?.name, 'Kept');
  });

  it('BrowserTrackingStore refuses sets pinned to another model state', () => {
    const a = new BrowserTrackingStore('g', 'content:one');
    a.save({ trackingKey: 'k', generation: 0, entries: { L: { globalId: 'G', digest: 'd' } } });
    assert.equal(new BrowserTrackingStore('g', 'content:one').load('k')?.entries.L.globalId, 'G');
    assert.equal(new BrowserTrackingStore('g', 'content:two').load('k'), undefined);
  });
});
