/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The committed `building-architecture.ifc` sample opened as the viewer's
 * active model for Flow acceptance tests (#6919). The headless MCP loader
 * stands in for the viewer SDK adapter; the graph, registry, runner, tracking
 * sidecar and store slices are the viewer's own. Edit mode is on, as a
 * coordinator running a model-writing graph would have it.
 */

import { fileURLToPath } from 'node:url';
import type { FlowEdge, FlowNode, FlowOutput, MemoCache, RunResult } from '@ifc-lite/flow';
import { loadIfcModel, type LoadedModel } from '@ifc-lite/mcp';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from './store-fixture';
import { newFlowDocument } from '@/lib/flow/persistence';
import { runFlowInViewer } from '@/lib/flow/runner';
import { activeTrackingPin } from '@/lib/assistant/flow-tracking';

const SAMPLE = fileURLToPath(new URL('../../public/samples/building-architecture.ifc', import.meta.url));

/** One tracked column per X position on the first storey; text positions make every `pt` lane fail. */
export function columnGraph(xs: unknown[]): { name: string; description: string; nodes: FlowNode[]; edges: FlowEdge[]; outputs: FlowOutput[] } {
  return {
    name: 'Columns along X', description: 'One column per X position on the first storey',
    nodes: [
      { id: 'storeys', type: 'model.byType', params: { type: 'IfcBuildingStorey' } },
      { id: 'first', type: 'core.first' },
      { id: 'xs', type: 'core.list', params: { items: xs } },
      { id: 'y', type: 'core.number', params: { value: 0 } },
      { id: 'pt', type: 'geometry.point' },
      { id: 'column', type: 'element.column', params: { width: 0.3, depth: 0.3, height: 3 } },
      { id: 'add', type: 'model.addElement' },
    ],
    edges: [
      { from: ['storeys', 'entities'], to: ['first', 'items'] }, { from: ['xs', 'items'], to: ['pt', 'x'] },
      { from: ['y', 'value'], to: ['pt', 'y'] }, { from: ['first', 'item'], to: ['column', 'storey'] },
      { from: ['pt', 'point'], to: ['column', 'position'] }, { from: ['column', 'spec'], to: ['add', 'spec'] },
    ],
    outputs: [{ nodeId: 'add', port: 'entity', label: 'Columns' }],
  };
}

/** Loads the sample as the active model beside an existing, saved, unrelated graph. */
export async function openFlowSample(): Promise<LoadedModel> {
  const model = await loadIfcModel(SAMPLE, { modelId: 'arch' });
  const existing = newFlowDocument('Existing coordination graph');
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('arch'), ifcDataStore: model.store, sourceContentHash: 'sample-hash',
      sourceFingerprint: model.sourceFingerprint } as unknown as FederatedModel),
    savedFlows: [{ doc: existing, updatedAt: 1 }], activeFlowId: existing.id, flowDoc: existing, flowDirty: false, flowRunning: false,
    editEnabled: true,
  });
  return model;
}

/** The Flow panel's Run, minus React: native runner, then the slice's run record. */
export async function runOpenFlow(model: LoadedModel, cache: MemoCache): Promise<RunResult> {
  const doc = structuredClone(useViewerStore.getState().flowDoc!);
  useViewerStore.getState().setFlowRunning(true);
  const start = Date.now();
  const result = await runFlowInViewer({ doc, bim: model.bim, pin: activeTrackingPin()!, cache });
  useViewerStore.getState().setFlowLastRun(result, null, { start, end: Date.now(), doc, mutationIds: new Set() });
  return result;
}

export const sampleColumns = (model: LoadedModel): string[] =>
  model.bim.query().byType('IfcColumn').toArray().map(column => column.globalId);
