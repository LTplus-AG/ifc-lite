/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An extension-contributed graph is read-only and never a saved graph
 * (#5431 review). Whether one is open is read off `flowDoc` itself, so it
 * cannot drift from what the canvas shows: before, a local marker could be
 * cleared (uninstall, a cancelled "New", a failed import) while `flowDoc`
 * still held the contributed graph, re-enabling Save and Delete on it; and
 * because opening it kept the previous `activeFlowId`, Save then wrote the
 * contributed graph over the user's saved one.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { newFlowDocument } from '@/lib/flow/persistence';
import { BimProvider } from '@/sdk/BimProvider';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import type { ExtensionHostService } from '@/services/extensions/host.js';
import { contributedFlowId, type ContributedFlow, type ResolveFlowContributionsResult } from '@/services/extensions/host-flows.js';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render';
import { FlowPanel } from './FlowPanel.js';

class MemoryStorage {
  readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });

const initialState = useViewerStore.getState();

/** Just the two members `useContributedFlows` reads, driven by the test. */
class FakeHost {
  graphs: ContributedFlow[] = [];
  private listeners = new Set<() => void>();
  listContributedFlows = async (): Promise<ResolveFlowContributionsResult> => {
    if (this.failing) throw new Error('storage unavailable');
    return { graphs: this.graphs, diagnostics: [] };
  };
  onChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  failing = false;
  async publish(graphs: ContributedFlow[]): Promise<void> {
    this.graphs = graphs;
    await act(async () => {
      for (const listener of this.listeners) listener();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function contributedGraph(): ContributedFlow {
  const doc = { ...newFlowDocument('Ext graph'), id: contributedFlowId('acme', 'check') };
  return { doc, extensionId: 'acme', extensionName: 'Acme', graphId: 'check' };
}

async function mount(host: FakeHost) {
  const view = render(
    <BimProvider>
      <ExtensionHostContext.Provider value={host as unknown as ExtensionHostService}>
        <FlowPanel onClose={() => {}} />
      </ExtensionHostContext.Provider>
    </BimProvider>,
  );
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return view;
}

function buttonLabels(container: ParentNode): string[] {
  return [...container.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
}

function selectGraph(container: ParentNode, id: string): void {
  const select = container.querySelector('select')!;
  act(() => {
    select.value = id;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

describe('FlowPanel — extension-contributed graphs (#5431 review)', () => {
  beforeEach(() => {
    useViewerStore.setState({ ...initialState, savedFlows: [], activeFlowId: null, flowDoc: null, flowDirty: false });
  });

  afterEach(() => {
    cleanup();
    useViewerStore.setState(initialState);
  });

  it('opening a contributed graph leaves the previously open saved graph unsaveable-over', async () => {
    const mine = useViewerStore.getState().createFlow('Mine');
    assert.ok(mine);
    const host = new FakeHost();
    host.graphs = [contributedGraph()];
    const container = await mount(host);

    selectGraph(container, host.graphs[0].doc.id);

    const state = useViewerStore.getState();
    assert.equal(state.flowDoc?.id, host.graphs[0].doc.id);
    assert.equal(state.activeFlowId, null, 'a contributed graph is not a saved graph, so Save has no target');
    assert.equal(state.flowDirty, false);
    assert.ok(!buttonLabels(container).includes('Save'), 'Save is not offered on a read-only graph');
    assert.equal(state.savedFlows.find((f) => f.doc.id === mine)?.doc.name, 'Mine');
  });

  it('closes the contributed graph when its extension is uninstalled, rather than leaving it editable', async () => {
    const host = new FakeHost();
    host.graphs = [contributedGraph()];
    const container = await mount(host);
    selectGraph(container, host.graphs[0].doc.id);
    assert.ok(buttonLabels(container).includes('Duplicate to my graphs'), 'opened read-only');

    await host.publish([]);

    assert.equal(useViewerStore.getState().flowDoc, null, 'the graph is closed, not left open without its origin');
    for (const label of ['Save', 'Delete', 'Export']) {
      assert.ok(!buttonLabels(container).includes(label), `${label} is not offered for a graph that is gone`);
    }
  });

  it('closes the contributed graph when the list can no longer be read, rather than trusting the stale one', async () => {
    const host = new FakeHost();
    host.graphs = [contributedGraph()];
    const container = await mount(host);
    selectGraph(container, host.graphs[0].doc.id);
    assert.equal(useViewerStore.getState().flowDoc?.id, host.graphs[0].doc.id);

    host.failing = true;
    const error = console.error;
    console.error = () => {};
    try {
      await host.publish(host.graphs);
    } finally {
      console.error = error;
    }

    assert.equal(useViewerStore.getState().flowDoc, null, 'a graph from an extension that may be gone is not left runnable');
  });

  it('treats a SAVED graph as editable whatever its id, even one that looks like a contribution', async () => {
    // A graph saved before `ext:` ids were reserved (or written to storage by
    // hand) has a save target; it is the user's, not a contribution to close.
    const saved = { ...newFlowDocument('Mine'), id: contributedFlowId('acme', 'check') };
    useViewerStore.setState({ savedFlows: [{ doc: saved, updatedAt: 0 }] });
    useViewerStore.getState().openFlow(saved.id);
    const container = await mount(new FakeHost());

    assert.equal(useViewerStore.getState().flowDoc?.id, saved.id, 'not closed once the (empty) list loads');
    assert.ok(buttonLabels(container).includes('Save'));
    assert.ok(buttonLabels(container).includes('Delete'));
  });

  it('keeps a contributed graph read-only when "New" is cancelled', async () => {
    const host = new FakeHost();
    host.graphs = [contributedGraph()];
    const container = await mount(host);
    selectGraph(container, host.graphs[0].doc.id);

    const prompt = window.prompt;
    window.prompt = () => null;
    try {
      const newButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New');
      assert.ok(newButton);
      act(() => { newButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    } finally {
      window.prompt = prompt;
    }

    assert.equal(useViewerStore.getState().flowDoc?.id, host.graphs[0].doc.id);
    assert.ok(!buttonLabels(container).includes('Save'));
    assert.ok(!buttonLabels(container).includes('Delete'));
  });
});
