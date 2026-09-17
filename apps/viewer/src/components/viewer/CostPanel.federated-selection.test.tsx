/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Federated-selection regression for #4858: two loaded models declare the
 * SAME local expressIds (10 for the wall, 40 for the cost item) — the
 * fixture that can actually fail an unqualified-id bug. Selecting model
 * B's cost item's assigned product must resolve to model B's product,
 * through the REAL `FederationRegistry` singleton (`@ifc-lite/renderer`),
 * not model A's — an unqualified `expressId` alone cannot tell them apart.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { federationRegistry } from '@ifc-lite/renderer';
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

function stepFor(label: string): string[] {
  return [
    "#1=IFCPROJECT('proj',$,'P',$,$,$,$,$,#2);",
    '#2=IFCUNITASSIGNMENT((#5));',
    "#5=IFCMONETARYUNIT('GBP');",
    `#10=IFCWALL('w-${label}',$,'Wall ${label}',$,$,$,$,$,$);`, // SAME local id 10 in both models
    `#40=IFCCOSTITEM('ci-${label}',$,'Item ${label}',$,$,$,.USERDEFINED.,$,$);`, // SAME local id 40
    `#50=IFCCOSTSCHEDULE('cs-${label}',$,'Budget ${label}',$,$,$,.BUDGET.,$,$,$);`,
    "#60=IFCRELASSIGNSTOCONTROL('r1',$,$,$,(#40),$,#50);",
    "#61=IFCRELASSIGNSTOPRODUCT('r2',$,$,$,(#40),$,#10);",
  ];
}

function model(id: string, idOffset: number, store: IfcDataStore): FederatedModel {
  return {
    id,
    name: id,
    fileName: `${id}.ifc`,
    fileSize: 0,
    ifcDataStore: store,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    idOffset,
    maxExpressId: 1000,
  } as unknown as FederatedModel;
}

const originalState = useViewerStore.getState();
const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => {
  federationRegistry.clear();
  federationRegistry.registerModel('modelA', 1000); // offset 0
  federationRegistry.registerModel('modelB', 1000); // offset > 1000, verified below
  useViewerStore.setState({
    models: new Map([
      ['modelA', model('modelA', 0, buildStoreFromStep(stepFor('A')))],
      ['modelB', model('modelB', federationRegistry.getOffset('modelB')!, buildStoreFromStep(stepFor('B')))],
    ]),
    activeModelId: 'modelA',
    selectedEntity: null,
    selectedEntityId: null,
  });
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  federationRegistry.clear();
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

function clickText(container: HTMLElement, selector: string, text: string): void {
  const el = Array.from(container.querySelectorAll<HTMLElement>(selector)).find((n) => n.textContent?.includes(text));
  assert.ok(el, `an element matching "${selector}" containing "${text}" rendered`);
  act(() => el!.click());
}

describe('CostPanel federated selection (#4858)', () => {
  it('selecting model B item #40\'s assigned product resolves to modelB, not modelA (same local ids)', () => {
    const offsetB = federationRegistry.getOffset('modelB')!;
    assert.ok(offsetB > 1000, 'model B was actually offset by the FederationRegistry (fixture can fail)');

    const container = renderPanel();
    clickText(container, '[role="treeitem"]', 'Item B');
    clickText(container, 'button', 'Select in 3D');

    const state = useViewerStore.getState();
    assert.deepEqual(
      state.selectedEntity,
      { modelId: 'modelB', expressId: 10 },
      'the {modelId, expressId} channel must name modelB, not modelA, despite the identical local expressId',
    );
    assert.equal(
      state.selectedEntityId,
      10 + offsetB,
      'the legacy global-id channel must be translated through FederationRegistry\'s offset for modelB',
    );
    assert.notEqual(state.selectedEntityId, 10, 'must NOT be the bare unqualified local expressId');
  });

  it('selecting model A item #40\'s assigned product resolves to modelA (control: fixture can fail)', () => {
    const container = renderPanel();
    clickText(container, '[role="treeitem"]', 'Item A');
    clickText(container, 'button', 'Select in 3D');

    const state = useViewerStore.getState();
    assert.deepEqual(state.selectedEntity, { modelId: 'modelA', expressId: 10 });
    assert.equal(state.selectedEntityId, 10); // modelA's offset is 0
  });
});
