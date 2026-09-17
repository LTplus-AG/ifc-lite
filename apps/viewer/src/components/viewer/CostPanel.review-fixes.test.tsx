/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for PR #4875 review findings on the Cost panel,
 * rendered through the REAL `CostPanel`, store and `@ifc-lite/sdk` cost
 * backend: multi-target selection, the expand toggle's keyboard handling,
 * the legacy single-model path, and re-evaluation after a store refresh.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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

function step(price: number): string[] {
  return [
    "#1=IFCPROJECT('proj',$,'P',$,$,$,$,$,#2);",
    '#2=IFCUNITASSIGNMENT((#5));',
    "#5=IFCMONETARYUNIT('GBP');",
    "#10=IFCWALL('w1',$,'Wall one',$,$,$,$,$,$);",
    "#11=IFCWALL('w2',$,'Wall two',$,$,$,$,$,$);",
    `#30=IFCCOSTVALUE('Priced',$,IFCMONETARYMEASURE(${price}.),$,$,$,$,$,$,$);`,
    "#40=IFCCOSTITEM('ci',$,'Parent item',$,$,$,.USERDEFINED.,(#30),$);",
    "#41=IFCCOSTITEM('ci2',$,'Child item',$,$,$,.USERDEFINED.,$,$);",
    "#50=IFCCOSTSCHEDULE('cs',$,'Budget',$,$,$,.BUDGET.,$,$,$);",
    "#60=IFCRELASSIGNSTOCONTROL('r1',$,$,$,(#40),$,#50);",
    "#61=IFCRELASSIGNSTOPRODUCT('r2',$,$,$,(#40),$,#10);",
    "#62=IFCRELASSIGNSTOPRODUCT('r3',$,$,$,(#40),$,#11);",
    "#63=IFCRELNESTS('n1',$,$,$,#40,(#41));",
  ];
}

function model(id: string, store: IfcDataStore): FederatedModel {
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
    idOffset: 0,
    maxExpressId: 1000,
  } as unknown as FederatedModel;
}

const originalState = useViewerStore.getState();
const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => {
  useViewerStore.setState({
    models: new Map([['modelA', model('modelA', buildStoreFromStep(step(10)))]]),
    activeModelId: 'modelA',
  });
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

function row(container: HTMLElement, text: string): HTMLElement {
  const el = Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
    (n) => n.textContent?.includes(text),
  );
  assert.ok(el, `a tree row containing "${text}" rendered`);
  return el!;
}

function button(container: HTMLElement, text: string): HTMLElement {
  const el = Array.from(container.querySelectorAll<HTMLElement>('button')).find((n) => n.textContent?.includes(text));
  assert.ok(el, `a button containing "${text}" rendered`);
  return el!;
}

describe('CostPanel review fixes (PR #4875)', () => {
  it('"Select in 3D" keeps every assigned target in all multi-select channels', () => {
    const container = renderPanel();
    act(() => row(container, 'Parent item').click());
    act(() => button(container, 'Select in 3D').click());

    const state = useViewerStore.getState();
    const expected = [
      { modelId: 'modelA', expressId: 10 },
      { modelId: 'modelA', expressId: 11 },
    ];
    assert.deepEqual(state.selectedEntities, expected, 'selectedEntities is not collapsed to the first target');
    assert.deepEqual([...state.selectedEntitiesSet].sort(), ['modelA:10', 'modelA:11']);
    assert.deepEqual([...state.selectedEntityIds].sort(), [10, 11]);
    assert.deepEqual(state.selectedEntity, expected[0]);
  });

  it('Enter on the expand/collapse toggle does not also select the item', () => {
    const container = renderPanel();
    const parentRow = row(container, 'Parent item');
    const toggle = parentRow.querySelector<HTMLButtonElement>('button[aria-label]');
    assert.ok(toggle, 'the parent row has an expand/collapse toggle (fixture can fail)');
    act(() => {
      toggle!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert.equal(parentRow.getAttribute('aria-selected'), 'false', 'toggle keydown must not select the row');

    // Control: Enter on the row itself does select it.
    act(() => {
      parentRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert.equal(row(container, 'Parent item').getAttribute('aria-selected'), 'true');
  });

  it('lists the legacy single-model store (ifcDataStore with an empty models Map)', () => {
    useViewerStore.setState({
      models: new Map(),
      activeModelId: null,
      ifcDataStore: buildStoreFromStep(step(10)),
    });
    const container = renderPanel();
    assert.doesNotMatch(container.textContent ?? '', /No models loaded\./);
    act(() => row(container, 'Parent item').click());
    assert.match(container.textContent ?? '', /10 GBP/);
  });

  it('re-evaluates the selected item when its model data is refreshed', () => {
    const container = renderPanel();
    act(() => row(container, 'Parent item').click());
    assert.match(container.textContent ?? '', /10 GBP/);

    act(() => {
      useViewerStore.setState({
        models: new Map([['modelA', model('modelA', buildStoreFromStep(step(25)))]]),
      });
    });
    assert.match(container.textContent ?? '', /25 GBP/, 'resolved value follows the refreshed graph');
    assert.doesNotMatch(container.textContent ?? '', /10 GBP/);
  });
  it('shows the mixed-currency badge when only item evaluation reports MIXED_CURRENCY', () => {
    const mixed = (second: string) => buildStoreFromStep([
      "#1=IFCPROJECT('proj',$,'P',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#5));',
      "#5=IFCMONETARYUNIT('GBP');",
      `#6=IFCMONETARYUNIT('${second}');`,
      '#20=IFCMEASUREWITHUNIT(IFCMONETARYMEASURE(5.),#5);',
      '#21=IFCMEASUREWITHUNIT(IFCMONETARYMEASURE(1.),#6);',
      "#30=IFCCOSTVALUE('Pounds',$,#20,$,$,$,$,$,$,$);",
      "#31=IFCCOSTVALUE('Other',$,#21,$,$,$,$,$,$,$);",
      "#32=IFCCOSTVALUE('Sum',$,$,$,$,$,$,$,.ADD.,(#30,#31));",
      "#40=IFCCOSTITEM('ci',$,'Mixed item',$,$,$,.USERDEFINED.,(#32),$);",
    ]);
    useViewerStore.setState({ models: new Map([['modelA', model('modelA', mixed('USD'))]]) });
    const container = renderPanel();
    assert.match(container.textContent ?? '', /Mixed currency/, 'badge shown without opening the item');

    // Control: a single currency shows no badge (fixture can fail).
    act(() => {
      useViewerStore.setState({ models: new Map([['modelA', model('modelA', mixed('GBP'))]]) });
    });
    assert.doesNotMatch(container.textContent ?? '', /Mixed currency/);
  });
  it('Space on a tree row selects it and prevents the default page scroll', () => {
    const container = renderPanel();
    const parentRow = row(container, 'Parent item');
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    act(() => {
      parentRow.dispatchEvent(event);
    });
    assert.equal(event.defaultPrevented, true, 'Space must not also scroll the panel');
    assert.equal(row(container, 'Parent item').getAttribute('aria-selected'), 'true');
  });
});
