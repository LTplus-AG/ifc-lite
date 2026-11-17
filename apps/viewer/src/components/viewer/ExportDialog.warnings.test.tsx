/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { render, cleanup, click, press, advance } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { ExportDialog } from './ExportDialog';
import { ExportWarningDetails } from './ExportWarningDetails';

const initialState = useViewerStore.getState();
afterEach(() => {
  cleanup();
  mock.restoreAll();
  useViewerStore.setState(initialState);
});

// Same lost ConditionCoordinateSystem case as schema-converter-structural-r2.test.ts.
// Inline STEP keeps the real parser/exporter regression runnable without external fixtures.
const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [StructuralAnalysisView]'),'2;1');
FILE_NAME('structural.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#50=IFCSTRUCTURALPOINTCONNECTION('0XciGbSFPUkgAKmWK4M6tc',$,$,$,$,$,$,$,#4);
ENDSEC;
END-ISO-10303-21;`;

for (const convert of [true, false]) {
  it(`STEP export ${convert ? 'shows structural warnings without a success toast' : 'keeps a success toast for a warning-free export'} (#10606)`, async () => {
    const model = fixtureModel('structural.ifc');
    model.schemaVersion = 'IFC4';
    model.ifcDataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
    useViewerStore.setState({ ...fixtureModels(model), dirtyModels: new Set() });
    const success = mock.method(toast, 'success', () => {});
    const info = mock.method(toast, 'info', () => {});
    const error = mock.method(toast, 'error', () => {});
    mock.method(URL, 'createObjectURL', () => 'blob:export-test');
    mock.method(URL, 'revokeObjectURL', () => {});
    mock.method(HTMLAnchorElement.prototype, 'click', () => {});
    render(<ExportDialog surface="ribbon" />);
    const trigger = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Export IFC'));
    assert.ok(trigger);
    click(trigger);
    if (convert) {
      const schema = [...document.querySelectorAll('[role="combobox"]')].find(b => b.textContent?.includes('IFC4'));
      assert.ok(schema);
      press(schema, 'ArrowDown');
      await advance(0);
      const option = [...document.querySelectorAll('[role="option"]')].find(b => b.textContent?.trim() === 'IFC2X3');
      assert.ok(option, `schema options: ${[...document.querySelectorAll('[role="option"]')].map(b => b.textContent).join(', ')}`);
      click(option);
    }
    const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Export');
    assert.ok(button);
    await act(async () => {
      click(button);
      for (let tick = 0; tick < 100 && !success.mock.callCount() && !info.mock.callCount() && !error.mock.callCount(); tick++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    });
    assert.equal(error.mock.callCount(), 0);
    assert.equal(success.mock.callCount(), convert ? 0 : 1);
    assert.equal(info.mock.callCount(), convert ? 1 : 0);
    if (convert) {
      assert.match(info.mock.calls[0].arguments[0] ?? '', /Exported .* — \d+ warnings?/);
      assert.match(document.body.querySelector('details')?.textContent ?? '', /ConditionCoordinateSystem has no slot in IFC2X3/);
      assert.match(document.body.querySelector('details')?.textContent ?? '', /restraint directions in that coordinate system are not preserved/);
      const cancel = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Cancel');
      assert.ok(cancel);
      click(cancel);
      click(trigger);
      assert.equal(document.querySelector('details'), null, 'reopening clears diagnostics from the previous export');
    }
  });
}

it('caps displayed diagnostics while retaining their total count (#10606)', () => {
  render(<ExportWarningDetails warnings={Array.from({ length: 8 }, (_, i) => `Diagnostic ${i + 1}`)} limit={5} />);
  assert.equal(document.querySelectorAll('details li').length, 5);
  assert.equal(document.querySelector('summary')?.textContent, '8 warnings');
  assert.match(document.querySelector('details')?.textContent ?? '', /and 3 more/);
  assert.doesNotMatch(document.querySelector('details')?.textContent ?? '', /Diagnostic 6/);
});
