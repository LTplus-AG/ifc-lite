/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { NodeRegistry, type FlowDocument } from '@ifc-lite/flow';
import { resolve } from '@/i18n/registry';
import { newFlowDocument } from '@/lib/flow/persistence';
import { click, cleanup, render, type as typeInto } from '@/test/render';
import { FlowInspector } from './FlowInspector';

afterEach(cleanup);

it('#6329 names each visible Flow parameter and preserves edits and Player markers', () => {
  const registry = new NodeRegistry().register({
    type: 'test.accessibleParams', title: 'Accessible parameters', category: 'Test',
    inputs: [], outputs: [{ name: 'Result', type: { kind: 'scalar', access: 'item' } }],
    params: [
      { name: 'Enabled', kind: 'boolean', default: false },
      { name: 'Count', kind: 'number', default: 1 },
      { name: 'Mode', kind: 'enum', default: 'A', options: ['A', 'B'] },
      { name: 'Config', kind: 'json', default: {} },
      { name: 'Caption', kind: 'string', default: '' },
    ],
    capabilities: [], run: () => ({ Result: 1 }),
  });
  const initial: FlowDocument = {
    ...newFlowDocument('Accessible graph'),
    nodes: [{ id: 'node-1', type: 'test.accessibleParams' }],
  };
  let current = initial;
  function Harness() {
    const [doc, setDoc] = useState(initial);
    return <FlowInspector doc={doc} registry={registry} nodeId="node-1" lastRun={null}
      onDocChange={(next) => { current = next; setDoc(next); }} onSelect={() => {}} />;
  }
  const view = render(<Harness />);
  const named = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    tag: string, name: string,
  ): T => {
    const field = view.querySelector<T>(`${tag}[aria-label="${name}"]`);
    assert.ok(field, `${name} has a programmatic name matching its visible parameter`);
    assert.ok(view.textContent?.includes(name), `${name} remains visible`);
    return field;
  };
  const enabled = named<HTMLInputElement>('input[type="checkbox"]', 'Enabled');
  named<HTMLInputElement>('input[type="number"]', 'Count');
  named<HTMLSelectElement>('select', 'Mode');
  named<HTMLTextAreaElement>('textarea', 'Config');
  const caption = named<HTMLInputElement>('input', 'Caption');
  click(enabled);
  assert.equal(current.nodes[0]?.params?.Enabled, true);
  typeInto(caption, 'Reviewed');
  assert.equal(current.nodes[0]?.params?.Caption, 'Reviewed');

  const inputMarker = view.querySelector<HTMLInputElement>(`input[aria-label="${resolve('flowPanel.inspector.isInput')}: Enabled"]`);
  const outputMarker = view.querySelector<HTMLInputElement>(`input[aria-label="${resolve('flowPanel.inspector.isOutput')}: Result"]`);
  assert.ok(inputMarker, 'Player input marker includes its parameter name');
  assert.ok(outputMarker, 'graph output marker includes its port name');
  click(inputMarker);
  click(outputMarker);
  assert.deepEqual(current.inputs.map((item) => item.param), ['Enabled']);
  assert.deepEqual(current.outputs.map((item) => item.port), ['Result']);
});
