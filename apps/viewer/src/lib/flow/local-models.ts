/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isModelSelector, matchesFilename, parseTagRules, type SessionModels, type SessionModel } from '@ifc-lite/flow-nodes';
import { useViewerStore, type FederatedModel } from '@/store';
import { computeFullSourceHash, computeFullSourceHashFromBlob } from '@/utils/sourceContentHash';
import { enqueueSourceLoad } from '@/lib/sources/loadQueue';
import { resolveModels } from './model-targets';
import type { WorkflowRun } from './run-session';

export type AddLocalModel = (file: File, options?: { name?: string; modelId?: string; workflowOwner?: string }) => Promise<string | null>;
interface BoundModel {
  session: SessionModel;
  store: WeakRef<NonNullable<FederatedModel['ifcDataStore']>>;
  placementIdentity: FederatedModel['sourceContentHash'];
}
const bindings = new Map<string, readonly BoundModel[]>();
function bindModel(session: SessionModel): BoundModel {
  const model = useViewerStore.getState().models.get(session.modelId);
  if (!completeModel(model)) throw new Error(`Model did not finish loading: ${session.modelId}`);
  return { session, store: new WeakRef(model.ifcDataStore), placementIdentity: model.sourceContentHash };
}
async function fullModelIdentity(model: FederatedModel): Promise<string> {
  const hash = model.sourceFile ? await computeFullSourceHashFromBlob(model.sourceFile)
    : model.ifcDataStore ? await model.ifcDataStore.source.withMaterializedAsync(computeFullSourceHash) : null;
  if (!hash) throw new Error('Full source hashing is unavailable for this workflow model');
  return hash;
}

interface ModelPins {
  mutationRevision: number;
  geometryRevision: number;
  models: Map<string, { store: FederatedModel['ifcDataStore']; sourceIdentity?: string; mutationView: unknown }>;
}
const pins = new WeakMap<WorkflowRun, ModelPins>();
function completeModel(model: FederatedModel | undefined): model is FederatedModel & { ifcDataStore: NonNullable<FederatedModel['ifcDataStore']> } {
  return !!model?.ifcDataStore && (model.loadState === undefined || model.loadState === 'complete');
}
function pinModels(run: WorkflowRun, models: readonly SessionModel[]): void {
  const state = useViewerStore.getState();
  pins.set(run, { mutationRevision: state.mutationVersion, geometryRevision: state.geometryContentVersion,
    models: new Map([...(pins.get(run)?.models ?? []), ...models.map(({ modelId }) => {
      const model = state.models.get(modelId);
      if (!completeModel(model)) throw new Error(`Model did not finish loading: ${modelId}`);
      return [modelId, { store: model.ifcDataStore, sourceIdentity: model.sourceContentHash, mutationView: state.getMutationView(modelId) }] as const;
    })]),
  });
}
/** Publication and export boundaries reject external edits and same-ID replacements. */
export function checkWorkflowModelPins(run: WorkflowRun): void {
  run.check();
  const pinned = pins.get(run);
  if (!pinned) return;
  const state = useViewerStore.getState();
  if (state.mutationVersion !== pinned.mutationRevision || state.geometryContentVersion !== pinned.geometryRevision) {
    run.cancel(); throw new DOMException('Workflow models changed during execution', 'AbortError');
  }
  for (const [id, pin] of pinned.models) {
    const model = state.models.get(id);
    if (!completeModel(model) || model.ifcDataStore !== pin.store || model.sourceContentHash !== pin.sourceIdentity || state.getMutationView(id) !== pin.mutationView) {
      run.cancel(); throw new DOMException('A workflow model was removed or replaced', 'AbortError');
    }
  }
}

export async function loadSessionModels(run: WorkflowRun, graphId: string, addModel: AddLocalModel, filesValue: unknown, selectors: unknown): Promise<SessionModels> {
  run.progress('Loading models');
  const files = run.get<Readonly<Record<string, readonly File[]>>>(filesValue, 'files');
  const models: SessionModel[] = [];
  const old = bindings.get(graphId) ?? [];
  if (!Array.isArray(selectors) || !selectors.every(isModelSelector)) throw new Error('Invalid loaded-model selectors');
  for (const selector of selectors) {
    for (const id of resolveModels(selector, useViewerStore.getState())) {
      const m = useViewerStore.getState().models.get(id);
      if (!completeModel(m)) throw new Error(`Model did not finish loading: ${id}`);
      models.push({ modelId: id, slotId: selector.kind === 'slot' ? selector.slotId : 'loaded', filename: m.sourceFile?.name ?? m.name, sourceIdentity: await fullModelIdentity(m) });
      run.check();
    }
  }
  for (const [slotId, selected] of Object.entries(files)) for (const file of selected) {
    run.check();
    if (!file.name.toLowerCase().endsWith('.ifc')) throw new Error(`Local model input requires IFC: ${file.name}`);
    const identity = await computeFullSourceHashFromBlob(file);
    run.check();
    if (!identity) throw new Error('Full source hashing is unavailable for this workflow file');
    const candidate = old.find(({ session, store, placementIdentity }) => {
      const model = useViewerStore.getState().models.get(session.modelId);
      return session.slotId === slotId && session.filename === file.name && session.sourceIdentity === identity
        && completeModel(model) && model.ifcDataStore === store.deref() && model.sourceContentHash === placementIdentity;
    });
    if (candidate) { models.push(candidate.session); continue; }
    const id = crypto.randomUUID();
    await enqueueSourceLoad(async () => {
      run.check();
      // Capture THIS loader's published canceller, never an arbitrary later one.
      const previous = useViewerStore.getState().activeLoadCanceller;
      const pending = addModel(file, { modelId: id, workflowOwner: run.id });
      let owned = useViewerStore.getState().activeLoadCanceller;
      const unsubscribe = useViewerStore.subscribe((state) => {
        if (state.activeLoadCanceller !== previous && state.activeLoadCanceller) owned = state.activeLoadCanceller;
      });
      const cancel = () => { if (owned && owned !== previous && useViewerStore.getState().activeLoadCanceller === owned) owned(); };
      run.controller.signal.addEventListener('abort', cancel, { once: true });
      try { await pending; } finally { unsubscribe(); run.controller.signal.removeEventListener('abort', cancel); }
      run.check();
    });
    const loaded = useViewerStore.getState().models.get(id);
    if (!completeModel(loaded)) throw new Error(`Model did not finish loading: ${file.name}`);
    models.push({ modelId: id, slotId, filename: file.name, sourceIdentity: identity });
    bindings.set(graphId, models.map(bindModel));
  }
  if (models.length === 0) throw new Error('Select local IFC files or explicitly choose loaded models');
  if (models.length > 100) throw new Error('At most 100 models can participate in one workflow');
  bindings.set(graphId, models.map(bindModel));
  pinModels(run, models);
  return { runId: run.id, models };
}

export function checkedModelSet(run: WorkflowRun, value: unknown): SessionModels {
  if (typeof value !== 'object' || value === null || !('runId' in value) || value.runId !== run.id || !('models' in value) || !Array.isArray(value.models)) throw new Error('Model set does not belong to this workflow run');
  const result = value as SessionModels;
  if (result.models.length === 0 || result.models.length > 100 || !result.models.every((model) => typeof model === 'object' && model !== null
    && typeof model.modelId === 'string' && typeof model.slotId === 'string' && typeof model.filename === 'string')) throw new Error('Invalid workflow model set');
  checkWorkflowModelPins(run);
  for (const model of result.models) if (!completeModel(useViewerStore.getState().models.get(model.modelId))) throw new Error('A workflow model was removed or replaced');
  if (!pins.has(run)) pinModels(run, result.models);
  const pinned = pins.get(run);
  if (result.models.some((model) => !pinned?.models.has(model.modelId))) throw new Error('Model set contains an unowned workflow model');
  checkWorkflowModelPins(run);
  return result;
}

export function assignSessionTags(run: WorkflowRun, value: unknown, rulesValue: unknown): SessionModels {
  run.progress('Assigning model tags');
  const models = checkedModelSet(run, value);
  const rules = parseTagRules(rulesValue);
  for (const m of models.models) {
    const tags = new Set(rules.filter((r) => matchesFilename(m.filename, r)).flatMap((r) => [...r.tags]));
    if (rules.length && !tags.size) run.warn(`No filename tag rule matched ${m.filename}`);
    const ids = [...tags].map((name) => useViewerStore.getState().createModelTag(name)).filter((id): id is string => id !== null);
    if (ids.length !== tags.size) run.warn(`Some model tags could not be created for ${m.filename}`);
    const state = useViewerStore.getState();
    if (tags.size && state.modelTagsSaveFailed && !state.retryModelTagsSave()) {
      run.warn('Model tag definitions remain in memory because browser storage refused the write; save a federation setup before closing this session');
    }
    state.assignModelTags([m.modelId], ids);
  }
  return models;
}
