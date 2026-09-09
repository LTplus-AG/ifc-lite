/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { captureAppearanceDependencies, planAuthoredResourceCleanup } from '@ifc-lite/export';
import { StoreEditor } from '@ifc-lite/mutations';
import { equivalentAppearanceGeometry, type Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { entityRefToString } from '@/store/types';
import type { MeshData } from '@ifc-lite/geometry';
import { setAnnotationMembership } from './annotation-hierarchy';
import { appearanceRevision, captureAppearanceSource, type AppearanceCommitOptions } from './command';
import { prepareAppearanceEntities } from './prepare-plan';
import { replayAppearanceEntitiesInDraft } from './apply-plan';
import { prepareAppearanceHistory, type AppearanceHistoryPublication } from './history';
import { appearanceAssets, modelAppearanceAssets } from './model-assets';
import { annotationMesh } from './annotation-mesh';
import type { AnnotationPlanePlan } from './planner-types';

/** Native planned IFC rows, canonical geometry and its original image become one undo step. */
export async function commitAnnotationPlane(modelId: string, assetId: string, native: AnnotationPlanePlan,
  containerId: number, renderer: Renderer, source: ReturnType<typeof captureAppearanceSource>,
  options: AppearanceCommitOptions = {}): Promise<{ expressId: number; globalId: number }> {
  const state = useViewerStore.getState(), model = state.models.get(modelId), view = state.mutationViews.get(modelId);
  if (!model?.ifcDataStore || !model.geometryResult || !view) throw new Error('The target IFC model is not ready.');
  if (state.collabRoomId) throw new Error('Leave the shared room before creating annotations, then share the finished model.');
  if (native.mesh.texture.url !== modelAppearanceAssets.getAuthoredUri(modelId, assetId)) {
    throw new Error('The planned annotation image does not match its retained source.');
  }
  const data = model.ifcDataStore, plan = native.plan;
  const owner = { kind: 'history' as const, id: crypto.randomUUID() };
  const validate = () => {
    if (options.signal?.aborted) throw new DOMException('Annotation creation cancelled.', 'AbortError');
    const now = useViewerStore.getState();
    if (now.modelPlacement !== state.modelPlacement || now.models.get(modelId) !== model || now.collabRoomId || appearanceRevision(modelId) !== plan.sourceRevision) {
      throw new Error('The model changed while preparing the annotation. Try again.');
    }
    source.validate(now.mutationViews.get(modelId));
  };
  validate();
  appearanceAssets.retain(assetId, owner);
  let preparation: Awaited<ReturnType<typeof prepareAppearanceEntities>> | undefined;
  let gpu: ReturnType<Renderer['prepareTexturedOwner']> | undefined;
  let expectedGeometry: MeshData | undefined;
  const captureRendered = () => {
    const part = renderer.getScene().getMeshDataPieces(globalId)?.[0];
    expectedGeometry = part && { ...part, origin: part.origin && [...part.origin] };
  };
  let installed = false, hierarchyInstalled = false, published = false;
  const globalId = state.toGlobalId(modelId, native.annotationId);
  const hierarchy = data.spatialHierarchy;
  const membership = (present: boolean) => {
    if (hierarchy) setAnnotationMembership(hierarchy, containerId, native.annotationId, present);
  };
  try {
    const bitmap = await appearanceAssets.decode(assetId, owner, options.signal);
    validate();
    const mesh = annotationMesh(state, modelId, native, bitmap);
    const publication = (present: boolean): AppearanceHistoryPublication => {
      const now = useViewerStore.getState(), current = now.models.get(modelId);
      if (!current?.geometryResult) throw new Error('The annotation model was removed.');
      const old = current.geometryResult;
      const removed = old.meshes.filter(part => part.expressId === globalId);
      const meshes = old.meshes.filter(part => part.expressId !== globalId);
      if (present) meshes.push({ ...mesh });
      const geometryResult = { ...old, meshes,
        totalTriangles: old.totalTriangles - removed.reduce((n, part) => n + part.indices.length / 3, 0) + (present ? mesh.indices.length / 3 : 0),
        totalVertices: old.totalVertices - removed.reduce((n, part) => n + part.positions.length / 3, 0) + (present ? mesh.positions.length / 3 : 0) };
      const removedRef = { modelId, expressId: native.annotationId };
      const selectedEntityIds = new Set(now.selectedEntityIds);
      selectedEntityIds.delete(globalId);
      const selectedEntitiesSet = new Set(now.selectedEntitiesSet);
      selectedEntitiesSet.delete(entityRefToString(removedRef));
      const selectedEntityId = now.selectedEntityId === globalId ? [...selectedEntityIds].at(-1) ?? null : now.selectedEntityId;
      return { models: new Map(now.models).set(modelId, { ...current, geometryResult }),
        ...(!present ? { selectedEntityIds, selectedEntitiesSet, selectedEntityId,
          selectedEntity: selectedEntityId === null ? null : now.resolveGlobalIdFromModels(selectedEntityId) ?? null,
          selectedEntities: now.selectedEntities.filter(ref => ref.modelId !== modelId || ref.expressId !== native.annotationId) } : {}),
        ...(now.activeModelId === modelId ? { geometryResult } : {}) };
    };
    options.onProgress?.('preparing');
    preparation = await prepareAppearanceEntities(state.storeEditors.get(modelId) ?? new StoreEditor(data, view), view, plan, appearanceRevision(modelId), options);
    validate();
    const { prepared, applied } = preparation;
    const roots = new Set([containerId, ...plan.created.map(row => row.expressId)]);
    const before = captureAppearanceDependencies(data, view, roots);
    gpu = renderer.prepareTexturedOwner(mesh);
    options.onProgress?.('publishing');
    validate();
    const next = publication(true);
    prepared.commit();
    const after = captureAppearanceDependencies(data, view, roots);
    modelAppearanceAssets.registerAuthored(modelId, owner.id, [assetId]);
    modelAppearanceAssets.authoredLifecycle.track(modelId, owner.id, {
      dataStore: data, view,
      isCurrent: () => useViewerStore.getState().mutationViews.get(modelId) === view
        && useViewerStore.getState().models.get(modelId)?.ifcDataStore === data,
      changed: () => useViewerStore.getState().bumpMutationVersion(),
      subscribe: changed => useViewerStore.subscribe((current, previous) => {
        if (current.mutationVersion !== previous.mutationVersion || current.mutationViews !== previous.mutationViews
          || current.models.has(modelId) !== previous.models.has(modelId)) changed();
      }),
    }, applied.created, applied.created.flatMap(row => row.attributes));
    const record = prepareAppearanceHistory(useViewerStore, modelId, {
      mutations: applied.mutations,
      replay(direction) {
        if (useViewerStore.getState().collabRoomId) throw new Error('Leave the shared room before editing annotations.');
        (direction === 'undo' ? after : before).validate(view);
        const adding = direction === 'redo';
        const current = renderer.getScene().getMeshDataPieces(globalId);
        if (!adding && (current?.length !== 1 || !expectedGeometry || !equivalentAppearanceGeometry(current[0], expectedGeometry))) {
          throw new Error('The annotation geometry changed. Undo its later edits first.');
        }
        const next = publication(adding);
        const transaction = view.prepareAtomic(draft => { replayAppearanceEntitiesInDraft(draft, applied, direction); return draft; });
        const staged = adding ? renderer.prepareTexturedOwner(mesh) : undefined;
        const wasRegistered = modelAppearanceAssets.hasAuthoredRegistration(modelId, owner.id);
        try {
          if (adding) modelAppearanceAssets.registerAuthored(modelId, owner.id, [assetId]);
          transaction.commit();
          if (adding) { staged!.commit(); captureRendered(); } else renderer.getScene().removeMeshesForEntities([globalId]);
          membership(adding);
          if (!adding) modelAppearanceAssets.releaseAuthoredIfUnreferenced(modelId, owner.id,
            planAuthoredResourceCleanup(data, view, new Set()).retainedImageUris);
          renderer.invalidateBVHCache();
          renderer.requestRender();
          return next;
        } catch (error) {
          transaction.rollback();
          if (adding && !wasRegistered) modelAppearanceAssets.unregisterAuthored(modelId, owner.id);
          throw error;
        } finally { staged?.dispose(); }
      },
      dispose() { appearanceAssets.releaseOwner(owner); modelAppearanceAssets.authoredLifecycle.retire(modelId, owner.id); },
    });
    gpu.commit(); installed = true; captureRendered();
    membership(true); hierarchyInstalled = true;
    published = true;
    record(next);
    return { expressId: native.annotationId, globalId };
  } catch (error) {
    if (!published) {
      preparation?.prepared.rollback();
      if (installed) renderer.getScene().removeMeshesForEntities([globalId]);
      if (hierarchyInstalled) membership(false);
      modelAppearanceAssets.unregisterAuthored(modelId, owner.id);
      modelAppearanceAssets.authoredLifecycle.forget(modelId, owner.id);
      appearanceAssets.releaseOwner(owner);
    }
    throw error;
  } finally { gpu?.dispose(); preparation?.prepared.dispose(); }
}
