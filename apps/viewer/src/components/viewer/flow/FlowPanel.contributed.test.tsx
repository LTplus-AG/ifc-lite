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
import { addNode, toggleInput, toggleOutput } from '@/lib/flow/editor-ops';
import { loadPlayerValues } from '@/lib/flow/player-values';
import { BimProvider } from '@/sdk/BimProvider';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import type { ExtensionHostService } from '@/services/extensions/host.js';
import { contributedFlowId, type ContributedFlow, type ResolveFlowContributionsResult } from '@/services/extensions/host-flows.js';
import { useViewerStore } from '@/store';
import { cleanup, render, click } from '@/test/render';
import { loadDialogs } from '@/test/dialog-host.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
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
        <FlowPanel />
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

    const { ConfirmDialogHost } = await loadDialogs();
    render(<ConfirmDialogHost />);
    const newButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New');
    assert.ok(newButton);
    click(newButton);
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog);
    click(dialog.querySelector('button')!);

    assert.equal(useViewerStore.getState().flowDoc?.id, host.graphs[0].doc.id);
    assert.ok(!buttonLabels(container).includes('Save'));
    assert.ok(!buttonLabels(container).includes('Delete'));
  });

  it('offers Player and Publish on a contributed graph, still without Save, Delete, Export or the palette (#5634)', async () => {
    // Running a graph with inputs and publishing that run's writes neither
    // edits nor persists the graph, so read-only does not rule them out.
    let doc = { ...newFlowDocument('Ext graph'), id: contributedFlowId('acme', 'check') };
    doc = addNode(doc, 'core.number', [0, 0]).doc; // id: number-1
    doc = toggleInput(doc, 'number-1', 'value', 'Value');
    doc = toggleOutput(doc, 'number-1', 'value', 'Result');
    const graph: ContributedFlow = { doc, extensionId: 'acme', extensionName: 'Acme', graphId: 'check' };
    useViewerStore.setState(fixtureModels(fixtureModel('model-1')));
    const host = new FakeHost();
    host.graphs = [graph];
    const container = await mount(host);
    selectGraph(container, doc.id);

    assert.ok(container.querySelector('[data-flow-view-toggle]'), 'the Editor/Player toggle is offered');
    assert.ok(buttonLabels(container).includes('Publish'), 'Publish is offered');
    assert.equal(container.querySelector('[data-flow-palette]'), null, 'no palette: the canvas stays read-only');
    for (const label of ['Save', 'Delete', 'Export']) {
      assert.ok(!buttonLabels(container).includes(label), `${label} is still not offered`);
    }

    const playerButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Player');
    assert.ok(playerButton);
    act(() => { playerButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    const player = container.querySelector('[data-flow-player]');
    assert.ok(player, 'the Player view is mounted for the contributed graph');
    const numberInput = player.querySelector('input[type="number"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(numberInput), 'value')!.set!;
    await act(async () => {
      setter.call(numberInput, '42');
      numberInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const runButton = [...player.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Run');
    assert.ok(runButton);
    await act(async () => {
      runButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = useViewerStore.getState();
    assert.equal(state.flowLastRun?.ok, true, 'the Player ran the contributed graph');
    assert.equal(state.flowLastRunWindow?.doc.id, doc.id, 'Publish credits the namespaced ext:<extension>:<graph> id');
    assert.equal(state.flowDoc, doc, 'the graph itself is untouched');
    assert.equal(state.flowDirty, false);
    assert.equal(state.activeFlowId, null, 'still not a saved graph');
    assert.equal(state.savedFlows.length, 0, 'running from the Player saves nothing');
    assert.deepEqual(loadPlayerValues(doc.id), { 'number-1.value': '42' }, 'last-used values are kept per contributed id');
  });
});
