/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4881: the cost read model keeps an explicit empty IfcLabel ('') distinct
 * from an absent one ($). The Cost panel must still DISPLAY an empty Name like
 * a missing one, so the tree row, the schedule heading, the detail header and
 * the quantity label fall back instead of rendering blank. Rendered through the
 * real CostPanel, store and @ifc-lite/sdk cost backend.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { CostPanel } from '../CostPanel.js';

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

function model(id: string, store: IfcDataStore): FederatedModel {
  return {
    id, name: id, fileName: `${id}.ifc`, fileSize: 0, ifcDataStore: store, geometryResult: null,
    visible: true, collapsed: false, schemaVersion: 'IFC4', loadedAt: 0, idOffset: 0, maxExpressId: 1000,
  } as unknown as FederatedModel;
}

/** `label` is the STEP lexeme used for every Name: `''` or a quoted string. */
function step(label: string): string[] {
  return [
    "#1=IFCPROJECT('proj',$,'P',$,$,$,$,$,#2);",
    '#2=IFCUNITASSIGNMENT((#5));',
    "#5=IFCMONETARYUNIT('GBP');",
    "#30=IFCCOSTVALUE('Priced',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
    `#35=IFCQUANTITYAREA(${label},$,$,12.,$);`,
    `#40=IFCCOSTITEM('ci',$,${label},$,$,$,.USERDEFINED.,(#30),(#35));`,
    `#50=IFCCOSTSCHEDULE('cs',$,${label},$,$,$,.BUDGET.,$,$,$);`,
    "#60=IFCRELASSIGNSTOCONTROL('r1',$,$,$,(#40),$,#50);",
  ];
}

const originalState = useViewerStore.getState();
const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  useViewerStore.setState(originalState, true);
});

function renderPanel(label: string): HTMLElement {
  useViewerStore.setState({
    models: new Map([['modelA', model('modelA', buildStoreFromStep(step(label)))]]),
    activeModelId: 'modelA',
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<CostPanel onClose={() => {}} />);
  });
  mounted.push({ root, container });
  return container;
}

function itemRow(container: HTMLElement): HTMLElement {
  const rows = Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  assert.equal(rows.length, 1, 'the one cost item renders one tree row');
  return rows[0];
}

describe('CostPanel display of an explicit empty IfcLabel (#4881)', () => {
  it("falls back for Name '' in the tree row, schedule heading, detail header and quantity", () => {
    const container = renderPanel("''");
    assert.equal(itemRow(container).textContent?.trim(), 'Cost item #40');
    assert.match(container.textContent ?? '', /Schedule #50/);

    act(() => itemRow(container).click());
    const text = container.textContent ?? '';
    assert.equal((text.match(/Cost item #40/g) ?? []).length, 2, 'tree row and detail header both fall back');
    assert.equal((text.match(/Schedule #50/g) ?? []).length, 2, 'tree heading and owning schedule both fall back');
    assert.match(text, /IfcQuantityArea/, 'an empty quantity Name falls back to its type');
  });

  it('control: a real Name is shown and no fallback is rendered', () => {
    const container = renderPanel("'Groundworks'");
    assert.equal(itemRow(container).textContent?.trim(), 'Groundworks');
    act(() => itemRow(container).click());
    assert.doesNotMatch(container.textContent ?? '', /Cost item #40|Schedule #50|IfcQuantityArea/);
  });
});
