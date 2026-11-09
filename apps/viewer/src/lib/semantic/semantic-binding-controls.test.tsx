/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { SemanticPanel } from '@/components/viewer/SemanticPanel';
import { render, click, cleanup, type as input, advance } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { createSelectionAdapter } from '@/sdk/adapters/selection-adapter';
import { useSemanticSession } from './session';
import { pilotModel } from './demo';
const original = useViewerStore.getState(); const session = useSemanticSession.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original, true); useSemanticSession.setState(session, true); });
function field(ui: HTMLElement, label: string) {
  const element = [...ui.querySelectorAll('label')].find(item => item.textContent?.startsWith(label))?.querySelector('input');
  assert.ok(element, label); return element;
}
function change(select: HTMLSelectElement, value: string) {
  act(() => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
}
for (const binding of ['id', 'resource']) test(`#8555 basic ${binding}-only results select an IFC entity without advanced fields`, async () => {
  const model = pilotModel(0);
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(model.content).buffer, { disableWorkerScan: true });
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: data, maxExpressId: Math.max(...data.entities.expressId) }), ifcDataStore: data, mutationViews: new Map(), selectedEntityId: null, selectedEntityIds: new Set() });
  useSemanticSession.setState({ strategy: 'resource-uri', uriConfig: { mode: 'template', template: 'https://lbd.org/{GlobalId}' }, results: undefined, document: undefined, graph: '' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ head: { vars: [binding] }, results: { bindings: [{ [binding]: { type: 'uri', value: `https://lbd.org/${model.GlobalIds[0]}` } }] } });
  try {
    const ui = render(<SemanticPanel />);
    change(ui.querySelector('select')!, 'sparql');
    const resource = field(ui, 'Resource binding (without ?)');
    assert.equal(resource.closest('details'), null, 'basic binding is immediately available');
    if (binding !== 'id') input(resource, binding);
    const advanced = [...ui.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent === 'Advanced result bindings');
    assert.ok(advanced); assert.equal(advanced.open, false);
    assert.equal(advanced.querySelectorAll('input').length, 4);
    const revisions = [...ui.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent === 'Advanced: associate revision with model');
    assert.ok(revisions); assert.equal(revisions.open, false);
    input(field(ui, 'Endpoint URL'), 'https://example.org/sparql');
    input(field(ui, 'Allow requests to hostname'), 'example.org');
    click([...ui.querySelectorAll('button')].find(button => button.textContent === 'Load records')!);
    for (let i = 0; i < 100 && !useSemanticSession.getState().results; i++) await advance(10);
    assert.ok(useSemanticSession.getState().results, ui.textContent ?? 'query did not finish');
    const row = ui.querySelector<HTMLButtonElement>('button[aria-label="Select mapped row"]'); assert.ok(row); assert.equal(row.disabled, false);
    click(row);
    const selected = createSelectionAdapter(useViewerStore).get();
    assert.equal(selected.length, 1); assert.equal(selected[0].modelId, 'm');
    assert.equal(data.entities.getGlobalId(selected[0].expressId), model.GlobalIds[0]);
    assert.equal(useSemanticSession.getState().revisions.size, 0);
  } finally { globalThis.fetch = originalFetch; }
});
