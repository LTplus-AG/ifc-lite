/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { DEFAULT_MAPPING } from '@ifc-lite/semantic';
import { SemanticResults } from '@/components/viewer/SemanticResults';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, click, cleanup } from '@/test/render';
import { createSelectionAdapter } from '@/sdk/adapters/selection-adapter';
import { pilotModel } from './demo';
const original = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original, true); });
test('charter #6643 arbitrary analytical rows expose ambiguity and choose current model explicitly', async () => {
  const model = pilotModel(0);
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(model.content).buffer, { disableWorkerScan: true });
  const models = ['a', 'b'].map((id, index) => ({ ...fixtureModel(id, { idOffset: index * 1000000 }), ifcDataStore: data, maxExpressId: Math.max(...data.entities.expressId) }));
  useViewerStore.setState({ ...fixtureModels(...models), ifcDataStore: data, mutationViews: new Map(), selectedEntityId: null, selectedEntityIds: new Set() });
  const ui = render(<SemanticResults results={{ columns: ['GlobalId', 'count', 'missing'], rows: [{ GlobalId: { type: 'literal', value: model.GlobalIds[0] }, count: { type: 'literal', value: '01', datatype: 'http://www.w3.org/2001/XMLSchema#integer' } }] }} mapping={DEFAULT_MAPPING} revisions={new Map()} onError={error => { throw error; }} />);
  assert.ok(ui.textContent?.includes('01'));
  assert.ok(ui.textContent?.includes('Unbound'));
  click(ui.querySelector('button[aria-label="Select mapped row"]')!);
  assert.equal(createSelectionAdapter(useViewerStore).get().length, 0);
  const candidate = [...ui.querySelectorAll('fieldset button')][1];
  assert.ok(candidate); click(candidate);
  assert.equal(createSelectionAdapter(useViewerStore).get()[0].modelId, 'b');
});

test('charter #6643 replacing raw results resets pagination to the new first row', () => {
  function Harness() {
    const [results, setResults] = useState({ columns: ['value'], rows: Array.from({ length: 120 }, (_, index) => ({ value: { type: 'literal' as const, value: `old-row-${index}` } })) });
    return <><button onClick={() => { setResults({ columns: ['value'], rows: Array.from({ length: 20 }, (_, index) => ({ value: { type: 'literal', value: `new-row-${index}` } })) }); }}>Replace results</button>
      <SemanticResults results={results} mapping={DEFAULT_MAPPING} revisions={new Map()} onError={error => { throw error; }} /></>;
  }
  const ui = render(<Harness />);
  const next = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Next rows'); assert.ok(next);
  click(next); click(next); assert.ok(ui.textContent?.includes('old-row-100'));
  const replace = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Replace results'); assert.ok(replace); click(replace);
  assert.ok(ui.textContent?.includes('new-row-0'));
  const previous = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Previous rows'); assert.ok(previous?.disabled);
  assert.equal(ui.querySelectorAll('tbody tr').length, 20);
});
