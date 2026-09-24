/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for the Player mode and Publish button added to the
 * Flow panel (#5167 items 1 and 2). `FlowPanel` needs a `<BimProvider>`
 * (its Run/Player/Publish actions all go through `useBim()`), same
 * requirement `ScriptPanel.i18n.test.tsx` documents for its own
 * `useSandbox()`.
 *
 * These tests render the EXISTING `FlowPanel` (not a brand-new component)
 * and drive it exactly as a user would — this is the revert-oracle seam:
 * reverting the Player/Publish production hunks leaves `FlowPanel` loadable
 * but makes these assertions fail on their own merits (missing toggle,
 * missing field, Run left enabled on bad input), not on an import error.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { newFlowDocument } from '@/lib/flow/persistence';
import { addNode, toggleInput, toggleOutput } from '@/lib/flow/editor-ops';
import { BimProvider } from '@/sdk/BimProvider';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { FlowPanel } from './FlowPanel.js';

class MemoryStorage {
  readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

const localStorageMock = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorageMock });

const initialState = useViewerStore.getState();

function numberGraph(name: string) {
  let doc = newFlowDocument(name);
  doc = addNode(doc, 'core.number', [0, 0]).doc; // id: number-1
  doc = toggleInput(doc, 'number-1', 'value', 'Value');
  doc = toggleOutput(doc, 'number-1', 'value', 'Result');
  return doc;
}

/** A number field plus a `json`-kind field (a `core.list`'s `items` param): the
 * number `<input type="number">` cannot even HOLD non-numeric text in jsdom
 * (the browser resets it to `''`), so the "invalid value blocks Run" case
 * needs a widget whose raw text survives being invalid. */
function twoFieldGraph(name: string) {
  let doc = numberGraph(name);
  doc = addNode(doc, 'core.list', [0, 120]).doc; // id: list-1
  doc = toggleInput(doc, 'list-1', 'items', 'Items');
  return doc;
}

function mountFlowPanel() {
  return render(
    <BimProvider>
      <FlowPanel onClose={() => {}} />
    </BimProvider>,
  );
}

function byText<T extends Element>(container: ParentNode, selector: string, text: string): T {
  const el = [...container.querySelectorAll(selector)].find((c) => c.textContent?.trim() === text);
  assert.ok(el, `expected a "${selector}" with text "${text}"`);
  return el as T;
}

async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('FlowPanel — Player mode and Publish button (#5167)', () => {
  beforeEach(() => {
    localStorageMock.clear();
    useViewerStore.setState({
      ...initialState,
      ...fixtureModels(fixtureModel('model-1')),
      savedFlows: [],
      activeFlowId: null,
      flowDoc: null,
      flowDirty: false,
      flowSelectedNodeId: null,
      flowRunning: false,
      flowLastRun: null,
      flowLastError: null,
      flowLastRunWindow: null,
    });
  });

  afterEach(() => {
    cleanup();
    useViewerStore.setState(initialState);
  });

  it('shows an Editor/Player toggle and a Publish button once a graph is open', () => {
    const doc = numberGraph('Toggle graph');
    useViewerStore.getState().importFlow(doc);
    const container = mountFlowPanel();

    const toggle = container.querySelector('[data-flow-view-toggle]');
    assert.ok(toggle, 'the Editor/Player toggle is rendered');
    byText(container, 'button', 'Editor');
    byText(container, 'button', 'Player');
    byText(container, 'button', 'Publish');
  });

  it('Player renders one field per declared input, pre-filled from the node default, and switches away from the canvas', () => {
    const doc = numberGraph('Player fields');
    useViewerStore.getState().importFlow(doc);
    const container = mountFlowPanel();

    assert.ok(container.querySelector('[data-flow-canvas]'), 'the editor view shows the canvas');
    click(byText(container, 'button', 'Player'));

    const player = container.querySelector('[data-flow-player]');
    assert.ok(player, 'the Player view is mounted');
    assert.equal(container.querySelector('[data-flow-canvas]'), null, 'Player replaces the canvas, not sits beside it');
    const numberInput = player!.querySelector('input[type="number"]') as HTMLInputElement | null;
    assert.ok(numberInput, 'the number-kind Player input renders a number field');
    assert.equal(numberInput!.value, '0', 'pre-filled from the node\'s declared default');
  });

  it('an invalid value blocks Run and shows why', async () => {
    const doc = twoFieldGraph('Run graph');
    useViewerStore.getState().importFlow(doc);
    const container = mountFlowPanel();
    click(byText(container, 'button', 'Player'));

    const player = container.querySelector('[data-flow-player]')!;
    const jsonField = player.querySelector('textarea') as HTMLTextAreaElement;
    const runButton = byText<HTMLButtonElement>(player, 'button', 'Run');

    assert.equal(runButton.disabled, false, 'both fields start valid (numeric default, empty-array default)');
    await typeInto(jsonField, 'not json at all');
    assert.equal(runButton.disabled, true, 'Run is blocked by the invalid value');
    assert.match(player.textContent ?? '', /Not valid JSON/, 'the field shows why');

    await typeInto(jsonField, '[]');
    assert.equal(runButton.disabled, false, 'a valid value un-blocks Run');
  });

  it('running with a changed value produces a different output than the default', async () => {
    const doc = numberGraph('Run graph');
    useViewerStore.getState().importFlow(doc);
    const container = mountFlowPanel();
    click(byText(container, 'button', 'Player'));

    const player = container.querySelector('[data-flow-player]')!;
    const numberInput = player.querySelector('input[type="number"]') as HTMLInputElement;
    const runButton = byText<HTMLButtonElement>(player, 'button', 'Run');

    await typeInto(numberInput, '42');
    assert.equal(runButton.disabled, false);
    await act(async () => {
      click(runButton);
      // Let the async run settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(useViewerStore.getState().flowLastRun?.ok, true);
    assert.match(player.textContent ?? '', /42/, 'the graph output reflects the changed input, not the default (0)');
  });

  it('records the graph AS RUN with the run window, so an edit afterwards does not change Publish provenance', async () => {
    // Publish credits the run's writes to its graph (id, writing nodes,
    // tracking keys). Reading those from the working copy credited an edit
    // made after the run, e.g. a changed tracking key (#5380 review).
    const doc = numberGraph('Provenance graph');
    useViewerStore.getState().importFlow(doc);
    const container = mountFlowPanel();
    click(byText(container, 'button', 'Player'));
    const player = container.querySelector('[data-flow-player]')!;
    await act(async () => {
      click(byText<HTMLButtonElement>(player, 'button', 'Run'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const ran = useViewerStore.getState().flowDoc;
    assert.ok(ran);
    act(() => useViewerStore.getState().setFlowDoc({ ...ran, name: 'Edited after the run' }));

    const window = useViewerStore.getState().flowLastRunWindow;
    assert.equal(window?.doc, ran, 'the run window holds the document that ran');
    assert.equal(window?.doc.name, 'Provenance graph');
  });

  it('last-used values persist per graph id and are not inherited by a different graph', async () => {
    const docA = numberGraph('Graph A');
    const docB = numberGraph('Graph B');
    useViewerStore.getState().importFlow(docA);
    useViewerStore.getState().importFlow(docB);

    let container = mountFlowPanel();
    act(() => useViewerStore.getState().openFlow(docA.id));
    click(byText(container, 'button', 'Player'));
    let numberInput = container.querySelector('[data-flow-player] input[type="number"]') as HTMLInputElement;
    await typeInto(numberInput, '17');
    const runButton = byText<HTMLButtonElement>(container.querySelector('[data-flow-player]')!, 'button', 'Run');
    await act(async () => {
      click(runButton);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    cleanup();
    container = mountFlowPanel();
    act(() => useViewerStore.getState().openFlow(docA.id));
    click(byText(container, 'button', 'Player'));
    numberInput = container.querySelector('[data-flow-player] input[type="number"]') as HTMLInputElement;
    assert.equal(numberInput.value, '17', 'graph A restores its last-used value');

    act(() => useViewerStore.getState().openFlow(docB.id));
    numberInput = container.querySelector('[data-flow-player] input[type="number"]') as HTMLInputElement;
    assert.equal(numberInput.value, '0', 'graph B never inherits graph A\'s last-used value');
  });

  it('Publish is disabled with a reason before a run and after a run that wrote nothing, enabled after a writing run', () => {
    const doc = numberGraph('Publish graph');
    useViewerStore.getState().importFlow(doc);
    const container = mountFlowPanel();

    const publishBefore = byText<HTMLButtonElement>(container, 'button', 'Publish');
    assert.equal(publishBefore.disabled, true);
    assert.match(container.textContent ?? '', /Run the graph before publishing/);

    act(() => {
      useViewerStore.getState().setFlowLastRun(
        { ok: true, writes: 0, outputs: new Map(), graphOutputs: [], reports: [{ nodeId: 'number-1', status: 'ok', durationMs: 0, lanes: 1, laneErrors: 0, missing: {}, warnings: [] }], log: [] },
        undefined,
        { start: Date.now(), end: Date.now(), doc },
      );
    });
    const publishNoWrites = byText<HTMLButtonElement>(container, 'button', 'Publish');
    assert.equal(publishNoWrites.disabled, true);
    assert.match(container.textContent ?? '', /wrote nothing/);

    // The run's write, still pending: only then is there something to publish.
    const at = Date.now();
    act(() => {
      useViewerStore.setState({ undoStacks: new Map([['model-1', [{ timestamp: at } as never]]]) });
      useViewerStore.getState().setFlowLastRun(
        { ok: true, writes: 1, outputs: new Map(), graphOutputs: [], reports: [{ nodeId: 'number-1', status: 'ok', durationMs: 0, lanes: 1, laneErrors: 0, missing: {}, warnings: [] }], log: [] },
        undefined,
        { start: at, end: at, doc },
      );
    });
    // `writingNodes` only counts nodes whose registry def declares `writes:
    // 'model'`; `core.number` never does, so this graph's own run can only
    // ever report `writes: 0` in practice — this branch simulates what a
    // real write-node run's result shape looks like to prove the button
    // reacts to `RunResult.writes`, independent of which node produced it.
    const publishAfterWrite = byText<HTMLButtonElement>(container, 'button', 'Publish');
    assert.equal(publishAfterWrite.disabled, false, 'a run that wrote something enables Publish');

    // Publishing clears the run's edits; the button must not come back for
    // the same run and publish an empty layer (#5380 review).
    act(() => useViewerStore.getState().clearAllMutations());
    assert.equal(byText<HTMLButtonElement>(container, 'button', 'Publish').disabled, true);
    assert.match(container.textContent ?? '', /no longer pending/);
  });
});
