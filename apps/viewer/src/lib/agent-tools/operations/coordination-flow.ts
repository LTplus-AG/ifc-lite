/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { FlowData, RunResult } from '@ifc-lite/flow';
import { isContributedFlowId } from '@/services/extensions/host-flows';
import { useViewerStore } from '@/store';
import { emptySchema } from './contract';
import { modelCoordination, coordination, idSchema, textSchema } from './coordination-common';
import { internal, invalidInput, stale, unavailable } from './refusals';
function saved(id: string) { const flow = useViewerStore.getState().savedFlows.find(flow => flow.doc.id === id); if (!flow) throw invalidInput('unknown-target', 'Unknown saved flow.'); return flow; }
function encodeFlowData(data: FlowData | undefined) {
  return data?.kind === 'group' ? { ...data, branches: [...data.branches] } : data;
}
export function encodeFlowResult(result: RunResult | null) {
  if (!result) return null;
  return {
    ...result,
    outputs: Object.fromEntries([...result.outputs].map(([node, ports]) => [
      node, Object.fromEntries([...ports].map(([port, data]) => [port, encodeFlowData(data)])),
    ])),
    graphOutputs: result.graphOutputs.map(output => ({ ...output, data: encodeFlowData(output.data) })),
  };
}
export const coordinationFlowOperations = [
  coordination('flow.read', 'Inspect saved workflows, active graph, terminal result, errors and warnings.', ['read'], emptySchema, () => {
    const s = useViewerStore.getState(); return { active_model_id: s.activeModelId, mutation_version: s.mutationVersion, geometry_version: s.geometryContentVersion, saved: s.savedFlows, active_id: s.activeFlowId, document: s.flowDoc, running: s.flowRunning,
      result: encodeFlowResult(s.flowLastRun), error: s.flowLastError, warnings: s.flowRunWarnings, progress: s.flowProgress };
  }),
  coordination('flow.artifacts', 'Read metadata for native generated workflow PDFs without copying binary data.', ['read'], emptySchema, () => ({ artifacts: useViewerStore.getState().flowArtifacts.map(({ blob: _blob, ...artifact }) => artifact) })),
  coordination<{ artifact_id: string; expected_document_signature: string }>('flow.exportArtifact', 'Return a host-owned artifact for an exact native generated PDF and its source-document signature.', ['artifact'], {
    type: 'object', properties: { artifact_id: { type: 'string', minLength: 1, maxLength: 200 }, expected_document_signature: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['artifact_id', 'expected_document_signature'], additionalProperties: false,
  }, async (i, c) => {
    const artifact = useViewerStore.getState().flowArtifacts.find(artifact => artifact.id === i.artifact_id && artifact.documentSignature === i.expected_document_signature);
    if (!artifact) throw stale('Native workflow artifact changed or no longer exists.');
    c.checkpoint?.(); return c.artifacts.create({ filename: artifact.name.toLowerCase().endsWith('.pdf') ? artifact.name : artifact.name + '.pdf', mimeType: 'application/pdf', data: artifact.blob });
  }),
  coordination('flow.validate', 'Validate the active workflow wiring and inspect exact native node availability without running it.', ['read'], emptySchema, async () => {
    const doc = useViewerStore.getState().flowDoc; if (!doc) throw unavailable('Open a workflow first.');
    const [{ validateFlowWiring, checkAvailability }, { flowRegistry, ensureFlowAiNodes, viewerFlowFeatures }, { isFeatureEnabled }] = await Promise.all([import('@ifc-lite/flow'), import('@/lib/flow/runner'), import('@/lib/features')]);
    const ai = doc.nodes.some(node => node.type.startsWith('ai.')); if (ai) await ensureFlowAiNodes();
    // The same feature set the native run preflights with, so availability here matches flow.run.
    const features = viewerFlowFeatures(true, ai && isFeatureEnabled('ai.assistant'));
    const registry = flowRegistry(); return { wiring: validateFlowWiring(doc, registry), availability: checkAvailability(doc, registry, features) };
  }),
  modelCoordination('flow.analyze', 'Execute the active graph through the native Flow scheduler with an explicit read-only core/model/table node allowlist. Returns terminal node reports and outputs; does not run scripts, network, publication or model-writing nodes.', ['read'], emptySchema, async (_, c) => {
    const s = useViewerStore.getState(), doc = s.flowDoc; if (!doc) throw unavailable('Open a workflow first.');
    const [{ runFlow, MemoCache, validateFlowWiring }, { parseCapabilities }, { flowRegistry }, { viewerTableAccess }] = await Promise.all([
      import('@ifc-lite/flow'), import('@ifc-lite/extensions'), import('@/lib/flow/runner'), import('@/lib/flow/viewer-tables'),
    ]);
    const allowed = new Set(['core.number', 'core.string', 'core.boolean', 'core.list', 'core.math', 'core.compare', 'core.concat', 'core.count', 'core.sum', 'core.filter', 'core.first', 'core.item', 'core.wrap', 'core.flatten', 'core.groupBy', 'core.keys', 'core.lookup',
      'model.select', 'model.byType', 'model.attribute', 'model.property', 'model.quantity', 'model.related', 'model.storey', 'model.contains', 'model.groupByStorey', 'model.groupByType',
      'table.fromEntities', 'table.longFormat', 'table.column', 'table.groupRows', 'table.pivot', 'table.rowCount']);
    const unsupported = doc.nodes.filter(node => !allowed.has(node.type));
    if (unsupported.length || doc.capabilities.some(capability => capability !== 'model.read')) throw invalidInput('wrong-target', 'This analysis endpoint accepts only core/model/table reads with model.read grants. Run other graphs through the native Flow execution/review path.');
    const registry = flowRegistry(), wiring = validateFlowWiring(doc, registry);
    if (wiring.length) throw invalidInput('wrong-target', wiring.map(problem => problem.message).join('; '));
    const parsed = parseCapabilities(doc.capabilities); if (!parsed.ok) throw internal('Malformed Flow capabilities.');
    c.checkpoint?.();
    const result = await runFlow(doc, { host: { bim: c.model.bim, grants: parsed.value, defaultModelId: c.model.id, tables: viewerTableAccess(useViewerStore) }, registry, cache: new MemoCache(), signal: c.signal });
    c.checkpoint?.(); const latest = useViewerStore.getState();
    if (latest.models !== s.models || latest.mutationVersion !== s.mutationVersion || latest.geometryContentVersion !== s.geometryContentVersion || latest.flowDoc !== doc) throw stale('Workflow or model inputs changed; analysis result discarded.');
    return { result: encodeFlowResult(result) };
  }),
  coordination('flow.open', 'Open a known saved flow, cancelling any prior native workflow.', ['configuration'], idSchema, (i, c) => c.commit(() => { saved(i.id); useViewerStore.getState().openFlow(i.id); return { active_id: useViewerStore.getState().activeFlowId }; })),
  coordination('flow.create', 'Create an empty native workflow using the existing storage and size limits.', ['configuration'], textSchema, (i, c) => c.commit(() => {
    const id = useViewerStore.getState().createFlow(i.value); if (!id) throw unavailable('Workflow creation refused by storage or size limits.'); return { id };
  })),
  coordination('flow.save', 'Save the active workflow with native persistence refusal reporting.', ['configuration'], emptySchema, async (_, c) => { const { isFlowWithinSizeLimit } = await import('@/lib/flow/persistence'); return c.commit(() => {
    const s = useViewerStore.getState(); if (!s.flowDoc) throw unavailable('No active workflow.'); if (!isFlowWithinSizeLimit(s.flowDoc)) throw invalidInput('limit', 'Workflow exceeds the native save size limit.');
    // Only an error this save set is its refusal.
    useViewerStore.setState({ flowStorageError: null }); s.saveFlow(); const live = useViewerStore.getState();
    if (live.flowStorageError) throw internal(live.flowStorageError); return { active_id: live.activeFlowId, dirty: live.flowDirty };
  }); }),
  coordination('flow.export', 'Export a saved flow with the native CLI-compatible serializer.', ['artifact'], idSchema, async (i, c) => {
    const { flowToJson } = await import('@/lib/flow/persistence'); const doc = saved(i.id).doc; c.checkpoint?.();
    return c.artifacts.create({ filename: 'workflow.flow.json', mimeType: 'application/json', data: flowToJson(doc) });
  }),
  coordination<{ expected_json: string; document_json: string }>('flow.replaceDocument', 'Replace the editable graph using the native strict Flow parser and an exact current-document guard. Cancels an active graph run through the native setFlowDoc action.', ['configuration'], {
    type: 'object', properties: { expected_json: { type: 'string', maxLength: 1000000 }, document_json: { type: 'string', maxLength: 1000000 } }, required: ['expected_json', 'document_json'], additionalProperties: false,
  }, async (i, c) => {
    const { parseFlowDocument } = await import('@ifc-lite/flow'); const { flowToJson } = await import('@/lib/flow/persistence'); const document = parseFlowDocument(i.document_json);
    return c.commit(() => {
      const state = useViewerStore.getState(); if (!state.flowDoc || flowToJson(state.flowDoc) !== i.expected_json) throw stale('Flow document changed; refresh the native serialized document before replacing.');
      if (state.activeFlowId === null && isContributedFlowId(state.flowDoc.id)) throw unavailable('Extension-contributed workflows are read-only. Duplicate or import an editable copy.');
      if (state.flowDoc.id !== document.id) throw invalidInput('wrong-target', 'Editing a graph must preserve its id; import a separate graph to change identity.');
      state.setFlowDoc(document); return { id: document.id, dirty: true };
    });
  }),
  coordination('flow.serialize', 'Read the exact native serialization used for guarded graph editing and CLI export.', ['read'], emptySchema, async () => {
    const { flowToJson } = await import('@/lib/flow/persistence'); const doc = useViewerStore.getState().flowDoc; if (!doc) throw unavailable('Open a workflow first.'); return { document_json: flowToJson(doc) };
  }),
  coordination('flow.import', 'Import serialized workflow JSON through the native flow parser and bounded storage.', ['configuration'], textSchema, async (i, c) => {
    const [{ parseFlowDocument }, { isFlowWithinSizeLimit }] = await Promise.all([import('@ifc-lite/flow'), import('@/lib/flow/persistence')]);
    const doc = parseFlowDocument(i.value);
    return c.commit(() => { const id = useViewerStore.getState().importFlow(doc); if (!id) {
      const message = 'Native workflow import refused.';
      throw isFlowWithinSizeLimit(doc) ? unavailable(message) : invalidInput('limit', message);
    } return { id }; });
  }),
  coordination('flow.delete', 'Delete one known saved workflow through native persistence and cancellation handling.', ['configuration'], idSchema, (i, c) => c.commit(() => {
    saved(i.id); useViewerStore.getState().deleteFlow(i.id); const state = useViewerStore.getState();
    // deleteFlow clears flowStorageError on a persisted delete and sets it when storage refused, so the flow would return on reload.
    if (state.savedFlows.some(flow => flow.doc.id === i.id) || state.flowStorageError) throw internal(state.flowStorageError ?? 'Native workflow deletion refused.');
    return { deleted: i.id };
  })),
  coordination('flow.cancel', 'Request cancellation of the active native workflow. Returns a cancellation request, never a fabricated terminal result.', ['configuration'], emptySchema, async (_, c) => {
    const { cancelWorkflowRun, isNativeWorkflowBusy } = await import('@/lib/flow/run-session');
    return c.commit(() => { const running = isNativeWorkflowBusy(); cancelWorkflowRun(); return { cancellation_requested: running, terminal: false }; });
  }),
];
