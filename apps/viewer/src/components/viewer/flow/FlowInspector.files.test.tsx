/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { render, cleanup, click } from '@/test/render.js';
import type { FlowDocument } from '@ifc-lite/flow';
import { newFlowDocument } from '@/lib/flow/persistence';
import { FlowInspector } from './FlowInspector';
import { FlowPlayerField } from './FlowPlayerField';
import { playerFields } from '@/lib/flow/player-fields';
import { flowRegistry, viewerFlowFeatures } from '@/lib/flow/runner';
import { preflightWorkflow } from '@/lib/flow/preflight';
import { startWorkflowRun } from '@/lib/flow/run-session';
import { selectedFiles, type SelectedFiles } from '@/lib/flow/file-values';

// Existing authoring and Player parents remain mountable after reverting new UI modules (#6612).
afterEach(cleanup);
describe('Inspector model file slots and Player inputs (#6612)', () => {
  it('authors IFC-only model slots that the real Player picker and native preflight accept (#6612)', async () => {
    let result: FlowDocument = { ...newFlowDocument('Load'), capabilities: ['model.create'],
      nodes: [{ id: 'load', type: 'session.loadModels' }] };
    let selected: SelectedFiles = {};
    function Harness() {
      const [doc, setDoc] = useState(result);
      const [files, setFiles] = useState<SelectedFiles>({});
      return <>
        <FlowInspector doc={doc} nodeId="load" registry={flowRegistry()} lastRun={null} onSelect={() => {}}
          onDocChange={(next) => { result = next; setDoc(next); }} />
        {playerFields(doc, flowRegistry()).map((field) => <FlowPlayerField key={field.key} field={field} value={files} error={undefined} storeys={[]}
          onChange={(next) => { const files = selectedFiles(next); selected = files; setFiles(files); }} />)}
      </>;
    }
    const ui = render(<Harness />);
    const expose = ui.querySelector('input[aria-label="Player input: files"]'); assert.ok(expose); click(expose);
    const add = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Add file slot'); assert.ok(add); click(add);
    assert.deepEqual(result.inputs[0].fileSlots?.map((slot) => slot.accept), ['.ifc', '.ifc']);
    const pickers = [...ui.querySelectorAll('input[type="file"]')] as HTMLInputElement[];
    assert.equal(pickers.length, 2);
    for (const [index, picker] of pickers.entries()) {
      assert.equal(picker.accept, '.ifc');
      Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['ISO-10303-21;'], `${index}.ifc`)] });
      act(() => picker.dispatchEvent(new Event('change', { bubbles: true })));
    }
    const run = startWorkflowRun();
    try {
      const prepared = await preflightWorkflow(run, result, { 'load.files': selected }, viewerFlowFeatures(true));
      const resources = run.get<Record<string, readonly File[]>>(prepared['load.files'], 'files');
      assert.deepEqual(Object.values(resources).flat().map((file) => file.name), ['0.ifc', '1.ifc']);
      await assert.rejects(preflightWorkflow(run, result, { 'load.files': { ...selected,
        models: [new File(['{}'], 'unsupported.ifcx')],
      } }, viewerFlowFeatures(true)), /Unsupported file/);
    } finally { run.release(); }
  });
});
