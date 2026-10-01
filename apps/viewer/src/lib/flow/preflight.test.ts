/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import type { FlowDocument } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { preflightWorkflow } from './preflight';
import { flowRegistry, viewerFlowFeatures } from './runner';
import { loadSessionModels } from './local-models';
import { startWorkflowRun, type WorkflowRun } from './run-session';

const IFC = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#100=IFCWALL('0wall00000000000000000',$,'Existing wall',$,$,$,$,$,.STANDARD.);
ENDSEC;
END-ISO-10303-21;`;
const initial = useViewerStore.getState();
let run: WorkflowRun;
function graph(): FlowDocument {
  return { flowVersion: 2, id: 'preflight-6612', name: 'Load models', capabilities: ['model.create'],
    nodes: [{ id: 'load', type: 'session.loadModels' }], edges: [], outputs: [],
    inputs: [{ nodeId: 'load', param: 'files', kind: 'files', label: 'Local models', fileSlots: [
      { id: 'models', label: 'Models', accept: '.ifc,.json', required: true, multiple: true },
    ] }],
  };
}
const selections = () => ({ 'load.files': { models: [new File([IFC], 'new.ifc')] } });
function assertSceneUnchanged(before: ReturnType<typeof useViewerStore.getState>): void {
  const current = useViewerStore.getState();
  assert.equal(current.models, before.models, 'invalid workflow must not add or replace a model');
  assert.equal(current.mutationVersion, before.mutationVersion);
  assert.equal(current.modelTagAssignments, before.modelTagAssignments);
  assert.equal(current.models.get('existing')?.ifcDataStore?.entities.getName(100), 'Existing wall');
}
beforeEach(async () => {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer, { disableWorkerScan: true });
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('existing'), name: 'existing.ifc', ifcDataStore: store }),
    mutationVersion: 0, modelTagAssignments: new Map(), mutationViews: new Map(),
  });
  run = startWorkflowRun();
});
afterEach(() => { run.release(); useViewerStore.setState(initial); });

describe('static automation preflight prevents partial model writes (#6612)', () => {
  it('rejects a non-IFC second file even when an editable slot accepts its extension', async () => {
    const before = useViewerStore.getState();
    await assert.rejects(preflightWorkflow(run, graph(), {
      'load.files': { models: [new File([IFC], 'first.ifc'), new File(['{}'], 'second.json')] },
    }, viewerFlowFeatures(true)), /Local model input requires IFC/);
    assertSceneUnchanged(before);
  });

  it('validates selectors on every load node before the first model can load', async () => {
    const before = useViewerStore.getState();
    const base = graph();
    const doc: FlowDocument = { ...base, nodes: [...base.nodes,
      { id: 'later', type: 'session.loadModels', params: { selectors: [{ kind: 'filename', filename: '' }] } },
    ] };
    await assert.rejects(preflightWorkflow(run, doc, selections(), viewerFlowFeatures(true)), /Invalid loaded-model selectors for later/);
    assertSceneUnchanged(before);
  });

  it('rejects a later empty loader before the earlier selected IFC can load', async () => {
    const before = useViewerStore.getState();
    const base = graph();
    const doc: FlowDocument = { ...base, nodes: [...base.nodes, { id: 'later', type: 'session.loadModels' }] };
    await assert.rejects(preflightWorkflow(run, doc, selections(), viewerFlowFeatures(true)), /Choose local IFC files or loaded-model selectors for later/);
    assertSceneUnchanged(before);
  });

  it('validates Player selector overrides rather than only the saved configuration', async () => {
    const before = useViewerStore.getState();
    const base = graph();
    const doc: FlowDocument = { ...base,
      nodes: [{ ...base.nodes[0], params: { selectors: [{ kind: 'filename', filename: 'existing.ifc' }] } }],
      inputs: [...base.inputs, { nodeId: 'load', param: 'selectors', kind: 'scalar', label: 'Loaded models' }],
    };
    await assert.rejects(preflightWorkflow(run, doc, { ...selections(), 'load.selectors': [{ kind: 'unknown' }] }, viewerFlowFeatures(true)), /Invalid loaded-model selectors/);
    assertSceneUnchanged(before);
  });

  it('accepts canonical IFC files and declared loaded-model selectors', async () => {
    const base = graph();
    const doc: FlowDocument = { ...base, nodes: [{ ...base.nodes[0], params: { selectors: [{ kind: 'filename', filename: 'existing.ifc' }] } }] };
    const inputs = await preflightWorkflow(run, doc, {
      'load.files': { models: [new File([IFC], 'NEW.IFC')] },
    }, viewerFlowFeatures(true));
    const files = run.get<Record<string, readonly File[]>>(inputs['load.files'], 'files');
    assert.equal(files['load.files/models'][0].name, 'NEW.IFC');
  });

  it('binds a real already-loaded model without any file-selection input', async () => {
    const selectors = [{ kind: 'filename', filename: 'existing.ifc' }];
    const doc: FlowDocument = { ...graph(), inputs: [], nodes: [
      { id: 'load', type: 'session.loadModels', params: { selectors } },
    ] };
    const before = useViewerStore.getState();
    const prepared = await preflightWorkflow(run, doc, {}, viewerFlowFeatures(true));
    const result = await loadSessionModels(run, doc.id, async () => assert.fail('loaded selectors must never invoke the loader'),
      prepared['load.files'], selectors);
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].modelId, 'existing');
    assert.match(result.models[0].sourceIdentity ?? '', /^[a-f0-9]{64}$/);
    assertSceneUnchanged(before);
  });

  it('rejects embedded file maps and forged files tokens rather than treating them as an empty selection', async () => {
    const before = useViewerStore.getState();
    for (const files of [{ models: ['not-a-local-file'] }, 'flow-resource:foreign', null]) {
      const doc: FlowDocument = { ...graph(), inputs: [], nodes: [{ id: 'load', type: 'session.loadModels', params: { files,
        selectors: [{ kind: 'filename', filename: 'existing.ifc' }],
      } }] };
      await assert.rejects(preflightWorkflow(run, doc, {}, viewerFlowFeatures(true)), /external file slots|Invalid or expired/);
    }
    assertSceneUnchanged(before);
  });

  for (const type of ['model.setProperty', 'model.setAttribute', 'model.addElement', 'model.delete', 'model.applyTable', 'model.openFromSource', 'speckle.receive']) {
    it(`rejects ${type} in an automation graph before files or model writes begin`, async () => {
      assert.ok(flowRegistry().get(type), 'test names a real native node');
      const before = useViewerStore.getState();
      const base = graph();
      const doc: FlowDocument = { ...base, nodes: [{ id: 'edit', type }, ...base.nodes] };
      await assert.rejects(preflightWorkflow(run, doc, selections(), viewerFlowFeatures(true)), /Session automation cannot include model-writing nodes: edit/);
      assert.equal(run.files.size, 0, 'mixed graph fails before capturing selected resources');
      assertSceneUnchanged(before);
    });
  }

  for (const type of ['script.run', 'script.list']) {
    it(`rejects ${type} when loader grants would enable sandbox model creation`, async () => {
      const before = useViewerStore.getState();
      const base = graph();
      const doc: FlowDocument = { ...base, nodes: [{ id: 'script', type, params: { code: 'bim.store.addWall(inputs.a)' } }, ...base.nodes] };
      await assert.rejects(preflightWorkflow(run, doc, selections(), viewerFlowFeatures(true)), /Session automation cannot include model-writing nodes: script/);
      assertSceneUnchanged(before);
    });
  }

  it('preserves ordinary model-editing graphs without session automation', async () => {
    const doc: FlowDocument = { flowVersion: 2, id: 'ordinary-edit', name: 'Edit model', capabilities: ['model.create'],
      nodes: [{ id: 'data', type: 'core.string', params: { value: 'IFC source' } }, { id: 'open', type: 'model.openFromSource' }],
      edges: [{ from: ['data', 'value'], to: ['open', 'data'] }], inputs: [], outputs: [],
    };
    const result = await preflightWorkflow(run, doc, {}, viewerFlowFeatures(true));
    assert.deepEqual(result, {});
  });
});
