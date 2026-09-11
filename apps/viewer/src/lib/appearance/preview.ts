/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { equivalentAppearanceGeometry, sameCompanionParts } from '@ifc-lite/renderer';
import type { AppearanceChange, AppearancePreview, AppearanceToken, Renderer } from '@ifc-lite/renderer';
import type { ViewerState } from '@/store';
import { occurrenceSourceMesh, validateOccurrenceSourceBudget } from './occurrence-source-mesh';
import { placementFrameKey, placementFrameCoordinateInfo } from '@/lib/model-placement/persistence';
import { totalYupOffset } from '@/hooks/ingest/federationAlign';
import { useViewerStore } from '@/store';
import type { AppearancePlan } from './planner-types.js';
import { bindCompanionPreview, companionHiddenNow } from './companion-preview';

// Renderer cache keys only. These never enter IFC entities or selection lanes.
let nextTextureIdentity = -1;
const bitmapIdentities = new WeakMap<ImageBitmap, number>();
function textureIdentity(bitmap: ImageBitmap): number {
  let id = bitmapIdentities.get(bitmap);
  if (id === undefined) { id = nextTextureIdentity--; bitmapIdentities.set(bitmap, id); }
  return id;
}

export interface AppearancePreviewImage {
  bitmap: ImageBitmap;
  imageUri: string;
  repeatS: boolean;
  repeatT: boolean;
}
export interface AppearancePreviewParts {
  globalId: number;
  modelIndex: number;
  parts: readonly MeshData[];
  geometryItemRemaps?: AppearanceChange['geometryItemRemaps'];
  materializedOriginals?: readonly MeshData[];
  companionOriginals?: readonly MeshData[];
  companionHidden?: true;
  instanced?: boolean;
  validate?(): void;
}

/** Resolve source IFC item identity independently of model/federation offsets. */
export function bindAppearancePreview(
  state: ViewerState, renderer: Renderer, modelId: string, plan: AppearancePlan,
  bitmap: ImageBitmap, imageUri: string, repeatS: boolean, repeatT: boolean,
  expandCorners: (mesh: MeshData, sourceIndices: readonly number[], cornerUvs: readonly number[], targetIndices: Uint32Array,
    targetCornerNormals: readonly number[], targetVertexCount: number) => MeshData,
  itemImages?: ReadonlyMap<number, AppearancePreviewImage>,
): AppearancePreviewParts[] {
  validateOccurrenceSourceBudget(plan.conversions ?? []);
  const plannedItems = new Map(plan.items.map(item => [item.geometryItemId, item]));
  const conversions = new Map<number, NonNullable<AppearancePlan['conversions']>[number]>();
  for (const conversion of plan.conversions ?? []) {
    // A masked conversion splits one source part into a textured and a retained
    // face set. The renderer preview replaces parts one-to-one, so refuse here
    // rather than render the retained triangles as missing geometry.
    if (conversion.maskedTriangles || conversion.retainedGeometryItemId !== undefined) {
      throw new Error(`This viewer cannot preview the face selection on IFC object #${conversion.productId} yet. Clear the face selection to convert the whole surface.`);
    }
    const item = plannedItems.get(conversion.geometryItemId);
    if (!item || item.productId !== conversion.productId || conversions.has(conversion.geometryItemId)
      || conversion.sourceGeometryItemId === conversion.geometryItemId
      || conversion.sourceIndices.length !== item.sourceIndices.length) {
      throw new Error('Invalid native occurrence conversion provenance.');
    }
    conversions.set(conversion.geometryItemId, conversion);
  }
  const targetTopologies = new Map(plan.items.map(item => [item.geometryItemId, new Uint32Array(item.targetIndices)]));
  const byProduct = new Map<number, Map<number, AppearancePlan['items'][number]>>();
  for (const item of plan.items) {
    let items = byProduct.get(item.productId);
    if (!items) { items = new Map(); byProduct.set(item.productId, items); }
    const sourceItem = conversions.get(item.geometryItemId)?.sourceGeometryItemId ?? item.geometryItemId;
    if (items.has(sourceItem)) throw new Error('Ambiguous occurrence conversion provenance.');
    items.set(sourceItem, item);
  }
  const groups: AppearancePreviewParts[] = [...byProduct].map(([productId, items]) => {
    const globalId = state.toGlobalId(modelId, productId);
    const scene = renderer.getScene();
    let originals = scene.getMeshDataPieces(globalId);
    let materializedOriginals: readonly MeshData[] | undefined;
    let validate: (() => void) | undefined;
    if (!originals?.length && scene.isInstancedEntity(globalId)) {
      const model = state.models.get(modelId);
      if (state.levelDisplayMode === 'exploded' || state.modelPlacement.preview) throw new Error('Finish repositioning and return to stacked levels before converting an occurrence.');
      if (model?.federationAlignmentStatus === 'same-crs' || model?.federationAlignmentStatus === 'reprojected') throw new Error('Occurrence conversion in a realigned model requires its source transform. Choose the workspace anchor model.');
      const frame = placementFrameKey(state);
      const offset = totalYupOffset(placementFrameCoordinateInfo(state));
      validate = () => {
        const current = useViewerStore.getState();
        const currentOffset = totalYupOffset(placementFrameCoordinateInfo(current));
        if (current.models.get(modelId) !== model || current.modelPlacement !== state.modelPlacement
          || currentOffset.x !== offset.x || currentOffset.y !== offset.y || currentOffset.z !== offset.z
          || current.levelDisplayMode === 'exploded' || placementFrameKey(current) !== frame) {
          throw new Error('The occurrence placement changed. Refresh the appearance preview.');
        }
      };
      const index = [...items.values()].map(item => conversions.get(item.geometryItemId));
      if (index.some(conversion => !conversion)) throw new Error('Native occurrence conversion provenance is missing.');
      const place = scene.placeAppearanceSource?.bind(scene);
      if (!place) throw new Error('This renderer does not support occurrence appearance conversion.');
      originals = index.map(conversion => place(occurrenceSourceMesh(state, modelId, conversion!)));
      const retained = renderer.getAppearancePreview().getParts?.({ expressId: globalId, modelIndex: originals[0].modelIndex! });
      if (retained) {
        if (retained.length !== originals.length || retained.some((part, i) => part.geometryItemId !== originals![i].geometryItemId
          || !equivalentAppearanceGeometry(part, originals![i]))) throw new Error('The retained occurrence source frame changed.');
        originals = [...retained];
      }
      materializedOriginals = originals;
    }
    if (!originals?.length) throw new Error(`Geometry for IFC object #${productId} is not available. Reload the model and try again.`);
    const represented = new Set<number>();
    const modelIndex = originals[0].modelIndex ?? 0;
    const geometryItemRemaps: NonNullable<AppearanceChange['geometryItemRemaps']>[number][] = [];
    const parts = originals.map(mesh => {
      const ref = mesh.geometryItemId === undefined ? null : state.resolveGlobalIdFromModels(mesh.geometryItemId);
      const item = ref?.modelId === modelId ? items.get(ref.expressId) : undefined;
      if (!item || (mesh.modelIndex ?? 0) !== modelIndex) {
        throw new Error(`The geometry of IFC object #${productId} changed. Reload it before applying appearance.`);
      }
      represented.add(item.geometryItemId);
      const image = itemImages ? itemImages.get(item.geometryItemId) : { bitmap, imageUri, repeatS, repeatT };
      if (!image) throw new Error(`The baked image for IFC geometry #${item.geometryItemId} is missing.`);
      const conversion = conversions.get(item.geometryItemId);
      if (conversion && !geometryItemRemaps.some(pair => pair.from === mesh.geometryItemId)) {
        geometryItemRemaps.push({ from: mesh.geometryItemId!, to: state.toGlobalId(modelId, item.geometryItemId) });
      }
      return { ...expandCorners(mesh, conversion?.sourceIndices ?? item.sourceIndices, item.previewCornerUvs, targetTopologies.get(item.geometryItemId)!, item.targetCornerNormals, item.targetVertexCount), geometryItemId: state.toGlobalId(modelId, item.geometryItemId), color: [1, 1, 1, 1] as [number, number, number, number],
        shadingColor: undefined, texture: undefined,
        textureBitmap: image.bitmap,
        textureRef: { textureId: textureIdentity(image.bitmap), url: image.imageUri, repeatS: image.repeatS, repeatT: image.repeatT } };
    });
    if (represented.size !== items.size) throw new Error(`Some geometry for IFC object #${productId} is still loading.`);
    return { globalId, modelIndex, parts, ...(materializedOriginals ? { materializedOriginals, validate } : {}), ...(geometryItemRemaps.length ? { geometryItemRemaps } : {}) };
  });
  return [...groups, ...bindCompanionPreview(state, renderer, modelId, plan)];
}

/** Keep every owner's original resources until the complete draft is accepted. */
export class AppearancePreviewSession {
  private tokens: AppearanceToken[] = [];
  private stagedGroups: readonly AppearancePreviewParts[] = [];
  private readonly preview: AppearancePreview;
  constructor(private readonly renderer: Renderer) { this.preview = renderer.getAppearancePreview(); }

  stage(groups: readonly AppearancePreviewParts[]): void {
    if (this.tokens.length) throw new Error('Discard the previous appearance preview before staging another.');
    try {
      for (const group of groups) {
        group.validate?.();
        const token = this.preview.begin({ expressId: group.globalId, modelIndex: group.modelIndex }, { geometryItemRemaps: group.geometryItemRemaps, materializedOriginals: group.materializedOriginals, companionOriginals: group.companionOriginals, companionHidden: group.companionHidden });
        this.tokens.push(token);
        this.preview.update(token, group.parts);
      }
      this.stagedGroups = groups.map(group => ({ ...group, parts: [...group.parts] }));
      this.renderer.requestRender();
    } catch (error) { this.cancel(); throw error; }
  }

  cancel(): void {
    const tokens = this.tokens.splice(0);
    this.stagedGroups = [];
    let failure: unknown;
    for (const token of tokens.reverse()) {
      try { this.preview.cancel(token); }
      catch (error) { failure ??= error; console.error('Could not cancel an appearance preview owner', error); }
    }
    this.renderer.requestRender();
    if (failure) throw failure;
  }

  retainSources(): () => void {
    const releases: (() => void)[] = [];
    try {
      for (const group of this.stagedGroups) {
        const release = this.preview.retainSource?.({ expressId: group.globalId, modelIndex: group.modelIndex });
        if (release) releases.push(release);
      }
    } catch (error) {
      const errors = [error];
      for (const release of releases.reverse()) { try { release(); } catch (failure) { errors.push(failure); } }
      if (errors.length > 1) throw new AggregateError(errors, 'Could not retain or release appearance sources.');
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const errors: unknown[] = [];
      for (const release of releases) { try { release(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, 'Could not release all appearance sources.');
    };
  }

  commit(): AppearanceChange[] {
    const changes = this.prepareCommit()();
    this.renderer.requestRender();
    return changes;
  }

  /** Validate the entire preview before publishing any IFC/history changes. */
  prepareCommit(expected?: readonly AppearancePreviewParts[]): () => AppearanceChange[] {
    if (!this.tokens.length) throw new Error('The appearance preview is no longer active. Refresh it before applying.');
    for (const group of this.stagedGroups) group.validate?.();
    if (expected && (expected.length !== this.stagedGroups.length || expected.some((group, i) => {
      const staged = this.stagedGroups[i];
      return group.globalId !== staged.globalId || group.modelIndex !== staged.modelIndex
        || group.parts.length !== staged.parts.length || group.parts.some((part, j) => part !== staged.parts[j]);
    }))) throw new Error('The appearance preview changed. Refresh it before applying.');
    const commit = this.preview.prepareCommit(this.tokens);
    let committed: AppearanceChange[] | undefined;
    return () => {
      if (committed) return committed;
      const changes = commit();
      this.tokens = [];
      this.stagedGroups = [];
      committed = changes;
      return changes;
    };
  }
}

/** History reuses current geometry buffers; reject mismatched topology explicitly. */
export function appearanceHistoryParts(renderer: Renderer, changes: readonly AppearanceChange[], direction: 'undo' | 'redo'): AppearancePreviewParts[] {
  return changes.map(change => {
    const target = direction === 'undo' ? change.before : change.after;
    const expectedCurrent = direction === 'undo' ? change.after : change.before;
    // Primary-model meshes can omit modelIndex. Preview capture treats that as
    // model 0; history must use the same ownership rule when resolving them.
    const current = (renderer.getAppearancePreview().getParts?.(change.owner) ?? renderer.getScene().getMeshDataPieces(change.owner.expressId))
      ?.filter(mesh => (mesh.modelIndex ?? 0) === change.owner.modelIndex);
    if (change.companionOriginals) {
      if (!current || !sameCompanionParts(current, expectedCurrent)) {
        throw new Error('Cannot restore the opening because companion geometry changed.');
      }
      return { globalId: change.owner.expressId, modelIndex: change.owner.modelIndex, parts: target, companionOriginals: change.companionOriginals, companionHidden: companionHiddenNow(change.owner.expressId) ? true : undefined };
    }
    if (!current || current.length !== target.length || current.length !== expectedCurrent.length) {
      throw new Error('Cannot restore appearance because the object geometry changed.');
    }
    const geometryItemRemaps = change.geometryItemRemaps?.map(pair => direction === 'undo'
      ? { from: pair.to, to: pair.from } : pair);
    const parts = current.map((mesh, index) => {
      const appearance = target[index];
      const expected = expectedCurrent[index];
      if (mesh.geometryItemId !== expected.geometryItemId || !equivalentAppearanceGeometry(mesh, expected)) {
        throw new Error('Cannot restore appearance because current geometry or shading changed.');
      }
      if ((geometryItemRemaps?.find(pair => pair.from === mesh.geometryItemId)?.to ?? mesh.geometryItemId) !== appearance.geometryItemId
        || !equivalentAppearanceGeometry(mesh, appearance, { allowNormalChanges: true })) {
        throw new Error('Cannot restore appearance because the object topology changed.');
      }
      return { ...mesh, geometryItemId: appearance.geometryItemId, positions: appearance.positions, normals: appearance.normals, indices: appearance.indices,
        appearanceSource: appearance.appearanceSource, color: appearance.color, shadingColor: appearance.shadingColor,
        uvs: appearance.uvs, texture: appearance.texture, textureRef: appearance.textureRef, textureBitmap: appearance.textureBitmap };
    });
    const instanced = direction === 'undo' ? change.beforeInstanced : change.afterInstanced;
    const materializedOriginals = change.beforeInstanced ? change.before : change.afterInstanced ? change.after : undefined;
    return { globalId: change.owner.expressId, modelIndex: change.owner.modelIndex, parts, instanced, materializedOriginals, ...(geometryItemRemaps?.length ? { geometryItemRemaps } : {}) };
  });
}
