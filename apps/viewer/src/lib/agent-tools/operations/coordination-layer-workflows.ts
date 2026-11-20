/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { getBrowserLayerStore } from '@/lib/layers/browser-store';
import { coordinationComposition } from '@/services/coordination-loader';
import { coordination, idSchema } from './coordination-common';
import { emptySchema } from './contract';
import type { ResolutionInput } from '@ifc-lite/merge';
/** Existence check without loadLayer's structuredClone of the whole layer. */
const requireLayer = (store: { hasLayer(id: string): boolean }, id: string) => { if (!store.hasLayer(id)) throw new Error(`No layer ${id} in the local store`); };
const short = { type: 'string' as const, minLength: 1, maxLength: 1000 };
const refSchema = { type: 'object' as const, properties: { candidate_id: short, ref_name: short, expected_ref_json: { type: 'string' as const, maxLength: 1000000 } }, required: ['candidate_id', 'ref_name', 'expected_ref_json'] as const, additionalProperties: false as const };
function checkComposition(expected: number, stackIds: string[]) {
  const state = useViewerStore.getState();
  if (state.mutationVersion !== expected || JSON.stringify(state.layerStack.map(entry => entry.id)) !== JSON.stringify(stackIds)) throw new Error('The native IFCX composition or mutation revision changed.');
}
export const coordinationLayerWorkflowOperations = [
  coordination('layers.library', 'Inspect native local content-addressed layers and refs. IndexedDB mirroring is native best effort, not a confirmed durable transaction.', ['read'], emptySchema, async () => {
    const store = await getBrowserLayerStore(); return { layer_ids: store.listLayers(), refs: store.listRefs(), durability: 'native-best-effort' };
  }),
  coordination('layers.export', 'Export one exact immutable local IFCX layer using the native content-addressed store.', ['read', 'artifact'], idSchema, async (i, c) => {
    const store = await getBrowserLayerStore(); return c.artifacts.create({ filename: `layer-${i.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.ifcx`, mimeType: 'application/json', data: JSON.stringify(store.loadLayer(i.id), null, 2) });
  }),
  coordination<{ mode: 'viewer' | 'session'; intent: string; author: string; expected_mutation_version: number; expected_layer_ids: string[] }>('layers.publishLocalDraft', 'Publish the existing viewer or collaboration draft into the native local layer store, then recompose through the canonical native overlay loader. Partial unresolved edits are reported and retained. This does not publish to a remote registry.', ['configuration', 'view'], {
    type: 'object', properties: { mode: { type: 'string', enum: ['viewer', 'session'] }, intent: short, author: short, expected_mutation_version: { type: 'integer', minimum: 0 }, expected_layer_ids: { type: 'array', items: short, minItems: 1, maxItems: 10000 } }, required: ['mode', 'intent', 'author', 'expected_mutation_version', 'expected_layer_ids'], additionalProperties: false,
  }, async (i, c) => {
    const { publishLocalLayerDraft } = await import('@/lib/layers/draft-workflow'); const host = coordinationComposition();
    return c.commitAsync(() => { checkComposition(i.expected_mutation_version, i.expected_layer_ids); return publishLocalLayerDraft(i.mode, i.intent, i.author, host); });
  }),
  coordination<{ candidate_id: string; ref_name: string; expected_ref_json: string }>('layers.previewLocalMerge', 'Preview the native three-way local-ref merge with an exact ref guard. The candidate remains immutable and no registry request occurs.', ['read'], refSchema, async (i, c) => {
    const [{ previewMergeInto, requiredCheckStatus }, store] = await Promise.all([import('@/lib/layers/merge'), getBrowserLayerStore()]);
    if (JSON.stringify(store.getRef(i.ref_name) ?? null) !== i.expected_ref_json) throw new Error('Native local ref changed.'); requireLayer(store, i.candidate_id);
    const outcome = await previewMergeInto({ kind: 'local', refName: i.ref_name }, store, i.candidate_id); c.checkpoint?.();
    if (JSON.stringify(store.getRef(i.ref_name) ?? null) !== i.expected_ref_json) throw new Error('Native local ref changed during preview.');
    return { outcome, checks: await requiredCheckStatus({ kind: 'local', refName: i.ref_name }, store, i.candidate_id), candidate_id: i.candidate_id, ref_json: i.expected_ref_json };
  }),
  coordination<{ candidate_id: string; ref_name: string; expected_ref_json: string; resolver: string; resolutions: Array<{ path: string; component_key: string; choice: 'ours' | 'theirs' | 'edited'; attributes_json: string }>; waivers: Array<{ spec: string; reason: string }> }>('layers.mergeLocal', 'Execute the native local three-way merge with exact ref guard, native conflict edits/removal semantics and explicit check waivers. Reports policy failure and unresolved conflicts without claiming a committed merge.', ['configuration'], {
    type: 'object', properties: { candidate_id: short, ref_name: short, expected_ref_json: { type: 'string', maxLength: 1000000 }, resolver: short,
      resolutions: { type: 'array', maxItems: 10000, items: { type: 'object', properties: { path: short, component_key: { type: 'string', maxLength: 1000 }, choice: { type: 'string', enum: ['ours', 'theirs', 'edited'] }, attributes_json: { type: 'string', maxLength: 1000000 } }, required: ['path', 'component_key', 'choice', 'attributes_json'], additionalProperties: false } },
      waivers: { type: 'array', maxItems: 1000, items: { type: 'object', properties: { spec: short, reason: short }, required: ['spec', 'reason'], additionalProperties: false } } }, required: ['candidate_id', 'ref_name', 'expected_ref_json', 'resolver', 'resolutions', 'waivers'], additionalProperties: false,
  }, async (i, c) => {
    const [{ previewMergeInto, executeMergeInto, editedWithRemovals }, store] = await Promise.all([import('@/lib/layers/merge'), getBrowserLayerStore()]);
    const guard = () => { if (JSON.stringify(store.getRef(i.ref_name) ?? null) !== i.expected_ref_json) throw new Error('Native local ref changed; preview again.'); }; guard();
    const target = { kind: 'local' as const, refName: i.ref_name }, preview = await previewMergeInto(target, store, i.candidate_id); c.checkpoint?.(); guard();
    const conflictByKey = new Map(preview.conflicts.map(conflict => [`${conflict.path}\0${conflict.componentKey ?? ''}`, conflict]));
    const resolutions: ResolutionInput[] = i.resolutions.map(item => {
      const componentKey = item.component_key || undefined, conflict = conflictByKey.get(`${item.path}\0${componentKey ?? ''}`);
      if (!conflict) throw new Error('Resolution does not belong to the current native conflict queue.');
      if (item.choice !== 'edited') return { path: item.path, ...(componentKey ? { componentKey } : {}), choice: item.choice };
      const attrs: unknown = JSON.parse(item.attributes_json); if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs) || !componentKey || componentKey.startsWith('child:') || componentKey.startsWith('inherit:')) throw new Error('Only native editable component conflicts accept plain-object attributes.');
      return { path: item.path, componentKey, choice: item.choice, attributes: editedWithRemovals(conflict, attrs as Record<string, unknown>) };
    });
    return c.commitAsync(async () => { guard(); return { outcome: await executeMergeInto(target, store, i.candidate_id, resolutions, i.resolver, i.waivers), durability: 'native-best-effort' }; }, result => result.outcome.status === 'merged' || result.outcome.status === 'fast-forward');
  }),
  coordination<{ ref_name: string; expected_ref_json: string }>('layers.loadLocalRef', 'Load one exact native local ref through the canonical federated IFCX loader, retaining native composition diagnostics.', ['configuration', 'view'], {
    type: 'object', properties: { ref_name: short, expected_ref_json: { type: 'string', maxLength: 1000000 } }, required: ['ref_name', 'expected_ref_json'], additionalProperties: false,
  }, async (i, c) => {
    const [{ refStackFiles }, store] = await Promise.all([import('@/lib/layers/merge'), getBrowserLayerStore()]); const host = coordinationComposition();
    return c.commitAsync(async () => { if (JSON.stringify(store.getRef(i.ref_name) ?? null) !== i.expected_ref_json) throw new Error('Native local ref changed.'); const files = refStackFiles(store, i.ref_name); await host.loadFederatedIfcx(files.map((file, index) => new File([JSON.stringify(file)], `layer-${index}.ifcx`, { type: 'application/json' }))); const loaded = useViewerStore.getState().layerStack;
      if (files.some(file => !loaded.some(entry => entry.file.header.id === file.header.id))) throw new Error('Native ref reconstruction did not load every requested layer.'); return { loaded: files.length, ref_name: i.ref_name }; });
  }),
  coordination('layers.registry', 'Inspect the configured native IFCX registry refs, layers and review list using its existing account token, without disclosing credentials or publishing a candidate.', ['read', 'network'], emptySchema, async (_, c) => {
    const { LayerRegistryClient } = await import('@/lib/layers/registry-client'); const client = LayerRegistryClient.fromCollabConfig(useViewerStore.getState().collabSelfToken ?? undefined); if (!client) throw new Error('Native layer registry is not configured.');
    const [layers, refs, reviews] = await Promise.all([client.listLayers(), client.listRefs(), client.listReviews()]); c.checkpoint?.(); return { ...layers, ...refs, ...reviews };
  }),
  coordination<{ candidate_id: string; ref_name: string; action: 'merge' | 'review' | 'comment'; entity: string; title: string; description: string; with_viewpoint: boolean }>('layers.prepareRegistryAction', 'Stage an exact immutable layer/ref and optional entity-bound review comment in the real native Layers approval controls. Preview/open-review may upload the candidate, so no remote mutation is dispatched here.', ['configuration', 'view', 'selection'], {
    type: 'object', properties: { candidate_id: short, ref_name: short, action: { type: 'string', enum: ['merge', 'review', 'comment'] }, entity: { type: 'string', maxLength: 1000 }, title: { type: 'string', maxLength: 1000 }, description: { type: 'string', maxLength: 100000 }, with_viewpoint: { type: 'boolean' } }, required: ['candidate_id', 'ref_name', 'action', 'entity', 'title', 'description', 'with_viewpoint'], additionalProperties: false,
  }, async (i, c) => {
    const [{ useLayerAutomationReview }, { LayerRegistryClient }, store] = await Promise.all([import('@/lib/layers/automation-review'), import('@/lib/layers/registry-client'), getBrowserLayerStore()]); requireLayer(store, i.candidate_id);
    if (!LayerRegistryClient.fromCollabConfig(useViewerStore.getState().collabSelfToken ?? undefined)) throw new Error('Native layer registry is not configured.');
    return c.commit(() => {
      if (i.action === 'comment') { const entity = useViewerStore.getState().layerStackPathToId?.get(i.entity); if (entity === undefined || !i.title.trim()) throw new Error('A loaded native composition path and nonempty comment title are required.'); // Both selection channels, as focusLoadReportEntity sets them, so Properties and the highlight agree.
        const state = useViewerStore.getState(); state.setSelectedEntityIds([]); state.setSelectedEntityId(entity); state.setSelectedEntity(resolveEntityRef(entity)); }
      const candidate = { id: crypto.randomUUID(), candidateId: i.candidate_id, refName: i.ref_name, action: i.action, entity: i.entity, title: i.title, description: i.description, withViewpoint: i.with_viewpoint }; useLayerAutomationReview.setState({ candidate }); useViewerStore.getState().openWorkspacePanel('layers'); return { state: 'waiting-for-approval', candidate };
    });
  }),
];
