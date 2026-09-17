/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for #4858's teardown requirement: removing the model
 * a Cost panel selection belongs to must not leave the detail pane holding
 * a stale ref. This renders the REAL `CostPanel` (production component,
 * real store, real `@ifc-lite/sdk` cost backend) and calls the REAL
 * `removeModel` action — the same shape `modelLifecycle.solid-teardown.test.ts`
 * already established for the clash-focus teardown regression.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createCostBackend } from '@ifc-lite/sdk';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { CostPanel } from './CostPanel.js';

interface LocalStepRef { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }

function buildStoreFromStep(lines: string[]): IfcDataStore {
  const text = lines.join('\n');
  const source = new TextEncoder().encode(text);
  const byId = new Map<number, LocalStepRef>();
  const byType = new Map<string, number[]>();
  let cursor = 0;
  for (const line of lines) {
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\(/);
    if (!match) continue;
    const expressId = parseInt(match[1], 10);
    const type = match[2];
    const idx = text.indexOf(line, cursor);
    const byteOffset = idx >= 0 ? idx : cursor;
    byId.set(expressId, { expressId, type, byteOffset, byteLength: line.length, lineNumber: 1 });
    const list = byType.get(type.toUpperCase()) ?? [];
    list.push(expressId);
    byType.set(type.toUpperCase(), list);
    cursor = byteOffset + line.length + 1;
  }
  const entities = { getGlobalId: () => '', getName: (id: number) => `entity${id}` };
  return { source, schemaVersion: 'IFC4', entityIndex: { byId, byType }, entities } as unknown as IfcDataStore;
}

const STEP = [
  "#1=IFCPROJECT('proj',$,'P',$,$,$,$,$,#2);",
  '#2=IFCUNITASSIGNMENT((#5));',
  "#5=IFCMONETARYUNIT('GBP');",
  "#10=IFCWALL('w',$,'Priced wall',$,$,$,$,$,$);",
  "#30=IFCCOSTVALUE('Priced',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
  "#40=IFCCOSTITEM('ci',$,'Teardown item',$,$,$,.USERDEFINED.,(#30),$);",
  "#50=IFCCOSTSCHEDULE('cs',$,'Budget',$,$,$,.BUDGET.,$,$,$);",
  "#60=IFCRELASSIGNSTOCONTROL('r1',$,$,$,(#40),$,#50);",
  "#61=IFCRELASSIGNSTOPRODUCT('r2',$,$,$,(#40),$,#10);",
];

function model(id: string): FederatedModel {
  return {
    id,
    name: id,
    fileName: `${id}.ifc`,
    fileSize: 0,
    ifcDataStore: buildStoreFromStep(STEP),
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    idOffset: 0,
    maxExpressId: 1000,
  } as unknown as FederatedModel;
}

const originalState = useViewerStore.getState();
const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => {
  useViewerStore.setState({ models: new Map([['modelA', model('modelA')]]), activeModelId: 'modelA' });
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  useViewerStore.setState(originalState, true);
});

function renderPanel(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<CostPanel onClose={() => {}} />);
  });
  mounted.push({ root, container });
  return container;
}

function clickText(container: HTMLElement, text: string): void {
  const el = Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
    (n) => n.textContent?.includes(text),
  );
  assert.ok(el, `a tree row containing "${text}" rendered`);
  act(() => el!.click());
}

describe('CostPanel teardown (#4858)', () => {
  it('drops the selected cost item when its model is removed — no stale ref', () => {
    // Sanity check the fixture can actually fail: extraction really has data.
    const graph = createCostBackend(() => ({ modelId: 'modelA', store: model('modelA').ifcDataStore! })).data();
    assert.equal(graph.HasCostData, true);

    const container = renderPanel();
    clickText(container, 'Teardown item');
    assert.match(container.textContent ?? '', /Resolved value/, 'detail pane shows the selected item');
    assert.match(container.textContent ?? '', /10 GBP/, 'resolved amount rendered');

    act(() => {
      useViewerStore.getState().removeModel('modelA');
    });

    assert.doesNotMatch(
      container.textContent ?? '',
      /Resolved value/,
      'teardown must clear the detail pane, not leave a stale cross-model-removed selection',
    );
    assert.match(container.textContent ?? '', /Select a cost item to inspect it\.|No models loaded\./);
  });

  it('an item selected then left alone is NOT cleared by an unrelated re-render (fixture can fail)', () => {
    const container = renderPanel();
    clickText(container, 'Teardown item');
    assert.match(container.textContent ?? '', /Resolved value/);

    // Touch an unrelated bit of store state — must not trip the teardown guard.
    act(() => {
      useViewerStore.setState({ activeModelId: 'modelA' });
    });
    assert.match(container.textContent ?? '', /Resolved value/, 'selection survives an unrelated store update');
  });
});
