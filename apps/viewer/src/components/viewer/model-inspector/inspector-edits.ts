/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every write the Model inspector makes (charter #6232, M2.5), one function
 * per edit, each ONE undo step.
 *
 * `runInspectorEdit` wraps an edit in an inline modeling command and runs it
 * through `runTransaction`: the shared mutation gate, one batch id over every
 * mutation it pushed, all-or-nothing rollback on a throw, and the wasm
 * re-mesh seam (#6391) for every element whose mesh the edit can change: a
 * new size, a type (its representation maps and styles) or a material
 * association (its colour). A rename re-meshes nothing. Types, materials and layer sets
 * are written by `bim.store`'s modelling methods through
 * `recordModellingEdit`, so there is no inspector-only mutation path.
 */

import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { runTransaction } from '@/lib/commands/modeling/transaction';
import { AUTHORED_KINDS, typeOf } from '@/lib/commands/modeling/authored-kinds';
import type { AuthoringTransaction, ModelingCommand } from '@/lib/commands/modeling/types';
import type { RemeshCause } from '@/lib/remesh/affected-set';
import type { AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';
import { detachFromType, modelEditTarget, recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { resizeWallMetres } from '@/store/slices/mutation-wall-resize';
import { commitElementSize } from '@/lib/element-size-commit';
import { fixWallTop } from '@/lib/commands/modeling/wall-top-fix';
import type { ElementSizePatch } from '@/store/slices/mutation-element-size';
import type { WallSection } from '@/store/slices/mutation-wall-section';
import { takeLayerFollow, writeMaterialLayersInDraft, type ApplyLayersSpec, type LayerFollow } from '@/lib/authoring/material-layers';
export type { LayerInput, ApplyLayersSpec, LayerFollow } from '@/lib/authoring/material-layers';
import { reportLayerFollow } from '@/lib/authoring/layer-follow-report';
import { editHostedFillIn, moveHostedFillIn, type HostedFillPosition } from '@/store/slices/mutation-hosted-fill';
import { setElementProfile } from '@/store/slices/mutation-element-profile';
import { editStairDimensionsInStore, typeLayerScopeInStore, type HostedElementSize, type ProfileSection, type StairDimensionEdit } from '@ifc-lite/create';

/** The shortest wall an endpoint drag accepts (`wall.moveEndpoint`), in metres. */
const MIN_WALL_LENGTH = 0.01;

/**
 * Run one inspector edit as one undo step. `edit` writes through
 * `tx.store` and returns the express ids whose mesh it changed. False (with
 * a toast) when the edit was refused or threw; nothing is left behind then.
 */
export function runInspectorEdit(modelId: string, edit: (tx: AuthoringTransaction) => readonly number[], onError?: (reason: string) => void, remeshCause?: RemeshCause): boolean {
  const command: ModelingCommand = {
    id: 'inspector.edit',
    labelKey: 'modelInspector.edit',
    hud: {},
    snap: 'modeling',
    init: () => null,
    pointerMove: (g) => g,
    pointerDown: (g) => g,
    commit: (_g, tx) => ({ created: [], deleted: [], remesh: [...edit(tx)], ...(remeshCause ? { remeshCause } : {}) }),
  };
  const get = useViewerStore.getState;
  const outcome = runTransaction(useViewerStore, command, null, { get, modelId, storeyId: get().session?.storeyId ?? null, workplane: null });
  if (!outcome.ok) { toast.error(outcome.reason); onError?.(outcome.reason); }
  return outcome.ok;
}

/** IfcRoot.Name. */
export function renameElement(modelId: string, expressId: number, name: string, previous: string): boolean {
  return runInspectorEdit(modelId, (tx) => {
    if (!tx.store.setAttribute(tx.modelId, expressId, 'Name', name, previous)) throw new Error(`Couldn't rename #${expressId}`);
    return [];
  });
}

/** Type the element with `typeId` (IfcRelDefinesByType), or take it out of its type (null). */
export function setElementType(modelId: string, elementId: number, typeId: number | null): boolean {
  let follow: LayerFollow | null = null;
  const ok = runInspectorEdit(modelId, (tx) => {
    const dataStore = tx.store.models.get(tx.modelId)?.ifcDataStore;
    if (!dataStore) throw new Error(`No model loaded for id "${tx.modelId}"`);
    return recordModellingEdit(useViewerStore, tx.modelId, (methods, draft) => {
      if (typeId === null) detachFromType(draft, dataStore, [elementId]);
      // A layered type sizes the element it types; what that re-shapes is re-meshed with it.
      else methods.assignType(tx.modelId, typeId, [elementId]);
      const sized = takeLayerFollow(draft, [elementId]);
      follow = sized.follow;
      return sized.remesh;
    });
  });
  if (ok && follow) reportLayerFollow(useViewerStore.getState(), modelId, follow);
  return ok;
}

/**
 * A new type object of the kind's class, typing `elementId` when given. The new type's id, or null when refused.
 *
 * Made from an element, the type starts with the layers the element inherits
 * from its current type (#9296), as duplicating a type does: the element then
 * follows the NEW type's layers, so "Apply to Type" on it reaches the element
 * instead of leaving it on the old type's build-up.
 */
export function createElementType(modelId: string, kind: AuthoredElementKind, name: string, elementId?: number): number | null {
  let typeId: number | null = null;
  const ok = runInspectorEdit(modelId, (tx) => {
    const dataStore = tx.store.models.get(tx.modelId)?.ifcDataStore;
    if (!dataStore) throw new Error(`No model loaded for id "${tx.modelId}"`);
    return recordModellingEdit(useViewerStore, tx.modelId, (methods, draft) => {
      const created = methods.addElementType(tx.modelId, { Type: AUTHORED_KINDS[kind].type, Name: name }).expressId;
      typeId = created;
      if (elementId === undefined) return [];
      const live = { dataStore, view: draft.getMutationView() };
      const from = typeOf(live, elementId);
      const scope = from === null ? null : typeLayerScopeInStore(live, from);
      if (scope && scope.layerSetId !== null && scope.inheriting.includes(elementId)) methods.assignMaterial(tx.modelId, scope.layerSetId, [created]);
      methods.assignType(tx.modelId, created, [elementId]);
      return [elementId];
    });
  });
  return ok ? typeId : null;
}

/**
 * A wall's, slab's, column's or beam's size, in metres: the one write the
 * push / pull handles make too (`setElementSize`), so the two cannot differ.
 * A wall's openings follow it in the same step, and a typed wall height
 * makes the wall fixed-height (#9013): a later storey re-level never
 * replaces the height that was typed.
 */
export function setElementDimensions(modelId: string, expressId: number, patch: ElementSizePatch): boolean {
  return runInspectorEdit(modelId, (tx) => {
    if (patch.kind === 'wall' && patch.height !== undefined) fixWallTop(tx, tx.modelId, expressId);
    const outcome = commitElementSize(useViewerStore, tx.modelId, expressId, patch);
    if (!outcome.ok) throw new Error(outcome.reason);
    return outcome.remesh;
  });
}

/**
 * A wall's length, in metres (#9296): its end point moves along its axis and
 * its start stays, the write an endpoint drag makes (`resizeWallMetres`). The
 * walls joined at the moved end come along, every join that touches a moved
 * wall is cut again, and the openings and fillings of each follow.
 */
export function setWallLength(modelId: string, expressId: number, length: number): boolean {
  return runInspectorEdit(modelId, (tx) => {
    const wall = tx.store.readWallEndpoints(tx.modelId, expressId);
    const model = modelEditTarget(tx.store, tx.modelId);
    if (!wall || !model) throw new Error(`Couldn't read wall #${expressId}`);
    const run = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
    if (!(run > 0) || !(length >= MIN_WALL_LENGTH)) throw new Error(`A wall is at least ${MIN_WALL_LENGTH} m long`);
    const k = length / run;
    const end: [number, number, number] = [wall.start[0] + (wall.end[0] - wall.start[0]) * k, wall.start[1] + (wall.end[1] - wall.start[1]) * k, wall.end[2]];
    const result = resizeWallMetres(tx.api, model, tx.modelId, expressId, [wall.start[0], wall.start[1], wall.start[2]], end, tx.batchId, { moveJoinedEnds: true });
    if (!result.ok) throw new Error(`Couldn't resize the wall: ${result.reason}`);
    return result.walls;
  }, undefined, 'hostsChanged');
}

/** A wall's thickness and/or height, in metres. */
export function setWallDimensions(modelId: string, expressId: number, section: WallSection): boolean {
  return setElementDimensions(modelId, expressId, { kind: 'wall', ...section });
}

/**
 * A beam's, column's or member's cross-section (`setElementProfile`): a new
 * kind (I, L, T, U, C, circle, hollow) or new dimensions of the kind, in
 * metres. One undo step; the element re-meshes with its new section.
 */
export function setElementProfileSection(modelId: string, expressId: number, section: ProfileSection): boolean {
  return runInspectorEdit(modelId, (tx) => {
    const outcome = setElementProfile(() => tx.store, tx.modelId, expressId, section);
    if (!outcome.ok) throw new Error(outcome.reason);
    return outcome.remesh;
  });
}

/**
 * A door's, window's or opening's offset along its host and its sill, in
 * metres: one write to the opening's placement, which the filling follows.
 * The host re-meshes with the moved void.
 */
export function moveHostedElement(modelId: string, expressId: number, position: HostedFillPosition): boolean {
  return runInspectorEdit(modelId, (tx) => {
    const moved = moveHostedFillIn(useViewerStore, tx.modelId, expressId, position);
    if (!moved.ok) throw new Error(moved.reason);
    return moved.remesh;
  });
}

/** Occurrence-only window/door size, using the same hosted fit and overlap
 * core as placement, Offset/Sill and the plan slide handle. */
export function setHostedElementDimensions(modelId: string, expressId: number, size: Partial<HostedElementSize>): boolean {
  return runInspectorEdit(modelId, tx => {
    const edited = editHostedFillIn(useViewerStore, tx.modelId, expressId, size);
    if (!edited.ok) throw new Error(edited.reason);
    return edited.remesh;
  });
}

/** Parent or selected flight, occurrence-only stepped dimensions. */
export function setStairDimensions(modelId: string, expressId: number, patch: StairDimensionEdit): boolean {
  return runInspectorEdit(modelId, tx => {
    const dataStore = tx.store.models.get(tx.modelId)?.ifcDataStore;
    if (!dataStore) throw new Error(`No model loaded for id "${tx.modelId}"`);
    const edited = recordModellingEdit(useViewerStore, tx.modelId, (_methods, draft) =>
      editStairDimensionsInStore(dataStore, draft, expressId, patch), tx.batchId);
    return [edited.stairId, edited.flightId];
  });
}

/**
 * Write any new IfcMaterial, the IfcMaterialLayerSet, and associate it (on
 * the element through a usage: across a wall centred on its axis, up through
 * a slab; or on the type). A wall layered this way takes the layers' total
 * thickness in the same step. The new set's id, or null when refused.
 */
export function applyMaterialLayers(modelId: string, spec: ApplyLayersSpec, onFollow?: (follow: LayerFollow) => void): number | null {
  let layerSetId: number | null = null;
  let follow: LayerFollow | null = null;
  const ok = runInspectorEdit(modelId, tx => {
    const dataStore = tx.store.models.get(tx.modelId)?.ifcDataStore;
    if (!dataStore) throw new Error(`No model loaded for id "${tx.modelId}"`);
    return recordModellingEdit(useViewerStore, tx.modelId, (methods, draft) => {
      const result = writeMaterialLayersInDraft({ modelId: tx.modelId, dataStore, view: draft.getMutationView(), editor: draft }, draft, methods, spec);
      layerSetId = result.layerSetId;
      follow = result.follow;
      return result.remesh;
    }, tx.batchId);
  });
  if (ok && follow) { reportLayerFollow(useViewerStore.getState(), modelId, follow); onFollow?.(follow); }
  return ok ? layerSetId : null;
}

/** Replace an occurrence's material using the shared create association path. */
export function setElementMaterial(modelId: string, elementId: number, material: number | { Name: string; Color?: string; Category?: string; Description?: string }): boolean {
  return runInspectorEdit(modelId, tx => {
    recordModellingEdit(useViewerStore, tx.modelId, methods => {
      const id = typeof material === 'number' ? material : methods.addMaterial(tx.modelId, material).expressId;
      methods.assignMaterial(tx.modelId, id, [elementId]);
    }, tx.batchId);
    return [elementId];
  });
}
