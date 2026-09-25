/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A run records, and Publish takes, only the mutations the run itself made
 * (#5634). The run is asynchronous: a property edit the user makes by hand
 * while it is in flight used to be "pending after, not before" the run and
 * so was published as the run's. The graph here holds one node that writes,
 * waits on a gate the test holds, and writes again; the manual edit lands
 * while it waits.
 */

import '@/test/setup-dom.js';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { newFlowDocument } from '@/lib/flow/persistence';
import { addNode } from '@/lib/flow/editor-ops';
import { mutationsInRun } from '@/lib/flow/publish-provenance';
import { flowRegistry } from '@/lib/flow/runner';
import { BimProvider } from '@/sdk/BimProvider';
import { useViewerStore, type FederatedModel } from '@/store';
import { cleanup, render } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { FlowPanel } from './FlowPanel.js';

const MODEL_ID = 'model-1';
const GATED_WRITE = 'test.gatedWrite';

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('attribution.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT($,#21);
#50=IFCWALL('1wall00000000000000000',$,'W1',$,$,#41,$,$,.SOLIDWALL.);
#51=IFCWALL('2wall00000000000000000',$,'W2',$,$,#41,$,$,.SOLIDWALL.);
#52=IFCWALL('3wall00000000000000000',$,'W3',$,$,#41,$,$,.SOLIDWALL.);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#40));
#71=IFCRELCONTAINEDINSPATIALSTRUCTURE('0cont00000000000000000',$,$,$,(#50,#51,#52),#40);
ENDSEC;
END-ISO-10303-21;
`;

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

/** Opened by the test once the manual edit is in; re-armed per test. */
let gate: { entered: Promise<void>; open: () => void };
function armGate(): void {
  let entered!: () => void;
  let open!: () => void;
  const enteredP = new Promise<void>((resolve) => { entered = resolve; });
  const opened = new Promise<void>((resolve) => { open = resolve; });
  gate = { entered: enteredP, open };
  gateWait = async () => { entered(); await opened; };
}
let gateWait: () => Promise<void> = async () => {};

before(() => {
  flowRegistry().register({
    type: GATED_WRITE,
    title: 'Gated write',
    category: 'test',
    inputs: [],
    outputs: [],
    params: [],
    capabilities: [],
    writes: 'model',
    volatile: true,
    run: async (ctx) => {
      const { bim } = ctx.host;
      bim.mutate.setProperty({ modelId: MODEL_ID, expressId: 50 }, 'Pset_WallCommon', 'FireRating', 'run-before');
      await gateWait();
      bim.mutate.setProperty({ modelId: MODEL_ID, expressId: 52 }, 'Pset_WallCommon', 'FireRating', 'run-after');
      return {};
    },
  });
});

function byText<T extends Element>(container: ParentNode, selector: string, text: string): T {
  const el = [...container.querySelectorAll(selector)].find((c) => c.textContent?.trim() === text);
  assert.ok(el, `expected a "${selector}" with text "${text}"`);
  return el as T;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('FlowPanel — a run records only its own mutations (#5634)', () => {
  beforeEach(async () => {
    localStorageMock.clear();
    armGate();
    const bytes = new TextEncoder().encode(FIXTURE);
    const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
    const model = { ...fixtureModel(MODEL_ID), ifcDataStore: dataStore } as unknown as FederatedModel;
    useViewerStore.setState({
      ...initialState,
      ...fixtureModels(model),
      mutationViews: new Map([[MODEL_ID, new MutablePropertyView(dataStore.properties || null, MODEL_ID)]]),
      storeEditors: new Map(),
      undoStacks: new Map(),
      redoStacks: new Map(),
      mutationBatchTags: new Map(),
      mutationVersion: 0,
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

  it('a manual edit made while the run is in flight is not recorded or published as the run\'s', async () => {
    let doc = newFlowDocument('Gated graph');
    doc = addNode(doc, GATED_WRITE, [0, 0]).doc;
    useViewerStore.getState().importFlow(doc);
    const container = render(
      <BimProvider>
        <FlowPanel onClose={() => {}} />
      </BimProvider>,
    );
    click(byText(container, 'button', 'Player'));
    const player = container.querySelector('[data-flow-player]')!;

    await act(async () => {
      click(byText<HTMLButtonElement>(player, 'button', 'Run'));
      await gate.entered;
    });
    // The property panel writes straight to the store, while the run waits.
    act(() => useViewerStore.getState().setProperty(MODEL_ID, 51, 'Pset_WallCommon', 'FireRating', 'manual'));
    await act(async () => {
      gate.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = useViewerStore.getState();
    assert.equal(state.flowRunning, false, 'the run finished');
    assert.ok(state.flowLastRunWindow, 'the run was recorded');
    const pending = [...state.undoStacks.values()].flat();
    const byEntity = new Map(pending.map((m) => [m.entityId, m.id]));
    assert.equal(pending.length, 3, 'two run writes and the manual edit are pending');
    assert.deepEqual(
      new Set(mutationsInRun(pending, state.flowLastRunWindow).map((m) => m.entityId)),
      new Set([50, 52]),
      'Publish takes the run\'s two writes and not the manual edit',
    );
    assert.equal(state.flowLastRunWindow.mutationIds.has(byEntity.get(51)!), false);
  });
});
