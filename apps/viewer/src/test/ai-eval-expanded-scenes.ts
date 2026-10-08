/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6928: additional charter journeys use native pipelines on committed IFC.
 * Fixed classification replies establish orchestration only; timing/owned ids are frozen, never model identities. */
import { createRootBudget, runModelRequest } from '@ifc-lite/ai';
import { MemoCache, type FlowDocument } from '@ifc-lite/flow';
import { IfcTypeEnum } from '@ifc-lite/data';
import { createBimContext } from '@ifc-lite/sdk';
import type { ListDefinition } from '@ifc-lite/lists';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { captureEvidence, type EvidenceSnapshot } from '@/lib/assistant/evidence';
import { runFlowInViewer } from '@/lib/flow/runner';
import { prepareListProviders } from '@/lib/lists/prepare-providers';
import { runListFederated } from '@/lib/lists/run-list';
import { recordListRun } from '@/lib/lists/run-provenance';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { captureAnalysisStamp } from '@/hooks/useAnalysisStaleness';
import { captureReviewSnapshot } from '@/lib/review/collect';
import { pinReviewCard } from '@/lib/review/assistant';
import { useReviewAssistantCard } from '@/lib/review/assistant-state';
import { blankDocument } from '@/lib/document/presets';
import { parseDocumentFile } from '@/lib/document/persistence';
import { seedAuthoringSample, SAMPLE_MODEL } from './authoring-sample-fixture';

export const EXPANDED_SCENES = ['flow-ai-paused', 'review-rev-b', 'lists-sample', 'selection-sample', 'document-reimported'] as const;
export type ExpandedScene = typeof EXPANDED_SCENES[number];
const fixedTime = Date.UTC(2026, 9, 8);

/** Reproducible nonces and timing for offline scene construction; original IFC identities/values are unchanged. */
async function fixedScene<T>(build: () => Promise<T>): Promise<T> {
  const now = Date.now, uuid = crypto.randomUUID;
  let counter = 0;
  Date.now = () => fixedTime;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  try { return await build(); } finally { Date.now = now; crypto.randomUUID = uuid; }
}

async function seedPausedFlow(): Promise<EvidenceSnapshot> {
  await seedAuthoringSample();
  const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
  const budget = createRootBudget({ maxRequests: 1, maxOutputTokens: 2000 });
  const doc: FlowDocument = { flowVersion: 2, id: 'eval-reviewed-wall-roles', name: 'Recorded wall-role proposal',
    capabilities: ['model.read', 'network.ai', 'model.mutate:Pset_Coordination'], inputs: [],
    outputs: [{ nodeId: 'roles', port: 'table', label: 'Proposed roles' }, { nodeId: 'roles', port: 'coverage', label: 'Coverage' }],
    nodes: [{ id: 'walls', type: 'model.byType', params: { type: 'IfcWall' } },
      { id: 'table', type: 'table.fromEntities', params: { columns: ['Name'] } },
      { id: 'roles', type: 'ai.classify', params: { columns: ['Name'], maxRows: 3, categories: [{ label: 'Review', definition: 'Offline orchestration fixture; a person must judge wall roles' }] } },
      { id: 'apply', type: 'model.applyTable', params: { mapping: [{ column: 'label', pset: 'Pset_Coordination', prop: 'WallRole' }] } }],
    edges: [{ from: ['walls', 'entities'], to: ['table', 'entities'] }, { from: ['table', 'table'], to: ['roles', 'table'] },
      { from: ['roles', 'table'], to: ['apply', 'table'] }] };
  const result = await runFlowInViewer({ doc, bim, pin: SAMPLE_MODEL, cache: new MemoCache(), ai: {
    model: 'authored-offline', request: call => runModelRequest({ model: 'authored-offline', route: 'test', budget,
      routeCeiling: 2000, maxOutputTokens: call.maxOutputTokens, timeoutMs: 1000, messages: [call.prompt], system: call.system,
      signal: call.signal, transport: async transport => {
        const data = /<data>\n([\s\S]*)\n<\/data>/.exec(call.prompt)?.[1];
        if (!data) throw new Error('Native classification must send its bounded data block');
        const rows = data.split('\n').map(line => JSON.parse(line) as { key: string });
        const text = JSON.stringify({ items: rows.map(row => ({ key: row.key, label: 'Review', evidence: ['Name'] })) });
        transport.onTokenUsage({ inputTokens: 20, outputTokens: 10 });
        transport.onChunk(text); transport.onFinishReason('stop'); transport.onComplete(text);
      } }),
  } });
  if (!result.ok || result.review.length !== 1 || result.writes !== 0 || result.outputs.has('apply') || budget.requests !== 1) {
    throw new Error('The native wall-role graph must pause before downstream writes with one bounded fixture request');
  }
  useViewerStore.setState({ flowDoc: doc, activeFlowId: doc.id, flowLastRun: result, flowLastError: null,
    flowLastRunWindow: { doc, start: fixedTime, end: fixedTime, mutationIds: new Set() }, flowRunning: false, flowRunWarnings: [], flowArtifacts: [] });
  return captureEvidence('flowRun');
}

async function seedLists(): Promise<EvidenceSnapshot> {
  await seedAuthoringSample();
  const definition: ListDefinition = { id: 'eval-wall-list', name: 'Native wall quantities and gaps', createdAt: fixedTime, updatedAt: fixedTime,
    entityTypes: [IfcTypeEnum.IfcWall], groups: [], columns: [
      { id: 'Name', source: 'attribute', propertyName: 'Name' },
      { id: 'Length', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'Length' },
      { id: 'Height', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'Height' },
    ] };
  const state = useViewerStore.getState(), stamp = captureAnalysisStamp();
  const { pairs } = prepareListProviders(state, {});
  const result = await runListFederated(definition, pairs, state, { evaluatorModels: evaluatorModelsFromState(state) });
  // Elapsed time is diagnostic, not an IFC oracle; retain all native values/counts/units.
  state.setListResult(recordListRun({ ...result, executionTime: 0 }, definition, stamp));
  return captureEvidence('lists');
}

async function seedSelection(): Promise<EvidenceSnapshot> {
  const { dataStore, view } = await seedAuthoringSample();
  const GlobalId = '12UVOn4wvAJPMUExKdZLb8'; // Committed SketchUp roof slab #425, independently picked in the shared browser.
  const expressId = dataStore.entities.getExpressIdByGlobalId(GlobalId);
  if (expressId !== 425 || dataStore.entities.getTypeName(expressId) !== 'IfcSlab') throw new Error('The committed roof-slab oracle changed');
  // The source buffer supplies on-demand base properties, exactly as on load.
  const { configureMutationView } = await import('@/utils/configureMutationView');
  configureMutationView(view, dataStore);
  useViewerStore.getState().setSelectedEntity({ modelId: SAMPLE_MODEL, expressId });
  return captureEvidence('selection');
}

async function seedDocument(): Promise<EvidenceSnapshot> {
  await seedAuthoringSample();
  const source = blankDocument();
  source.name = 'Recovered coordination cover';
  const imported = parseDocumentFile(JSON.stringify(source));
  if (imported.id === source.id || imported.blocks.some((block, index) => block.id === source.blocks[index]?.id)) {
    throw new Error('Native document import must preserve content with independent owned identities');
  }
  useViewerStore.setState({ documents: [imported], activeDocumentId: imported.id });
  return captureEvidence('document');
}

export async function seedExpandedScene(scene: ExpandedScene, native: {
  clash: () => Promise<EvidenceSnapshot>;
  validate: (store: IfcDataStore, modelId: string) => Promise<EvidenceSnapshot>;
}): Promise<EvidenceSnapshot> {
  useReviewAssistantCard.setState({ card: null, project: null });
  return fixedScene(async () => {
    if (scene === 'flow-ai-paused') return seedPausedFlow();
    if (scene === 'lists-sample') return seedLists();
    if (scene === 'selection-sample') return seedSelection();
    if (scene === 'document-reimported') return seedDocument();
    await native.clash();
    const model = [...useViewerStore.getState().models.values()][0];
    if (!model?.ifcDataStore) throw new Error('Cross-analysis evaluation requires the committed native model');
    await native.validate(model.ifcDataStore, model.id);
    const snapshot = captureReviewSnapshot();
    if (snapshot.failed.length || !snapshot.runs.some(run => run.source === 'clash') || !snapshot.runs.some(run => run.source === 'validation')) {
      throw new Error('Both native analysis sources must reach the Review snapshot');
    }
    const card = snapshot.cards.find(candidate => candidate.sources.includes('validation') && candidate.elements.some(element => element.resolution === 'resolved'));
    if (!card) throw new Error('Native validation must provide a resolvable coordination card');
    pinReviewCard(card, null);
    return captureEvidence('review');
  });
}
