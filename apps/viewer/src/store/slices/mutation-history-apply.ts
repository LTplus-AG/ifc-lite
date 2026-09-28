/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-mutation half of undo / redo: apply one recorded mutation's
 * inverse (undo) or re-apply it (redo) to the model's `MutablePropertyView`,
 * with `skipHistory` so the view does not record it again. Stack bookkeeping
 * lives in `mutation-history-replay.ts`, which calls these once per mutation
 * and commits the stacks in one store update per batch (#5861).
 */

import type { MutablePropertyView, IfcAttributeValue, Mutation } from '@ifc-lite/mutations';
import type { ViewerState } from '../index.js';
import { syncAuthoredTreeEntry } from './authoredTreeEntry.js';
import { mirrorCreateEntityRedo, mirrorSourceEntityRestore } from './mutation-cost-undo.js';
import { stashAndPruneEntityMesh, restoreStashedEntityMesh } from './mutation-mesh-stash.js';
import { isTargetTombstoned } from './mutation-redo-remote-guard.js';
import { toast } from '@/components/ui/toast';

type Get = () => ViewerState;
type Set = (partial: Partial<ViewerState> | ((s: ViewerState) => Partial<ViewerState>)) => void;

/** Decode the `@N` form used to encode positional indices into Mutation.attributeName. */
function positionalIndex(attributeName: string | undefined): number | null {
  if (!attributeName || attributeName[0] !== '@') return null;
  const n = Number(attributeName.slice(1));
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : null;
}

/**
 * Push the overlay's effective class for an entity into the model's
 * EntityTable as an additive display override, so a UI retype reflects
 * immediately in the inspector, hover, and the (mutationVersion-rebuilt)
 * hierarchy tree. Reads the current overlay, so it also clears the override
 * on undo (removeTypeMutation → null) and re-applies it on redo.
 */
export function syncTypeOverride(get: Get, modelId: string, entityId: number): void {
  const view = get().mutationViews.get(modelId);
  const newType = view?.getEntityTypeMutation?.(entityId)?.newType ?? null;
  const dataStore = get().models.get(modelId)?.ifcDataStore ?? get().ifcDataStore;
  dataStore?.entities?.setTypeOverride?.(entityId, newType);
}

/**
 * Whole-set mutations are replayed from their `setOverlay` snapshots, the
 * first branch of both handlers; every other type has its own branch. Only a
 * whole-set record WITHOUT snapshots can fall through to here (one built by
 * hand rather than by `MutablePropertyView`), and the parameter type makes a
 * new `MutationType` with no undo / redo branch a compile error (#5965). The
 * user is told, so a step that changed nothing never reads as one that worked.
 */
function reportUnreplayable(
  direction: 'undo' | 'redo',
  type: 'CREATE_PROPERTY_SET' | 'DELETE_PROPERTY_SET' | 'DELETE_QUANTITY' | 'DELETE_QUANTITY_SET',
  entityId: number,
): void {
  console.warn(`${direction}: ${type} on #${entityId} carries no set snapshot; the view was left unchanged`);
  toast.error(`Could not ${direction} this change: it was recorded without the data needed to reverse it.`);
}

/** Apply the inverse of `mutation` to `view` (one undo step, stacks untouched). */
export function applyUndoToView(get: Get, set: Set, modelId: string, view: MutablePropertyView, mutation: Mutation): void {
  // Apply inverse mutation (skipHistory=true); skip onto a peer-deleted entity (#5223, see mutation-redo-remote-guard.ts)
  if (isTargetTombstoned(view, mutation)) {
    set({ collabGeometryNotice: 'An element was removed by a collaborator. Its local history was skipped.' });
  } else if (mutation.setOverlay) {
    // A whole-set edit carries its set's overlay rows from right before (#5965).
    view.restoreSetOverlay(mutation.setOverlay.before);
  } else if (mutation.type === 'UPDATE_PROPERTY' || mutation.type === 'CREATE_PROPERTY') {
    // Decide by mutation TYPE, not by `oldValue === null`: a property can have
    // a null (unset) value yet still have existed before the edit (an unset
    // Boolean). Undoing a CREATE removes the property; undoing an UPDATE
    // restores its prior value — which may legitimately be null/unset (#1107).
    if (mutation.type === 'CREATE_PROPERTY' && mutation.psetName && mutation.propName) {
      view.deleteProperty(mutation.entityId, mutation.psetName, mutation.propName, true);
    } else if (mutation.psetName && mutation.propName && mutation.oldValue !== undefined) {
      view.setProperty(
        mutation.entityId,
        mutation.psetName,
        mutation.propName,
        mutation.oldValue,
        mutation.valueType,
        undefined,
        true // skipHistory
      );
    }
  } else if (mutation.type === 'DELETE_PROPERTY') {
    if (mutation.psetName && mutation.propName && mutation.oldValue !== undefined) {
      view.setProperty(
        mutation.entityId,
        mutation.psetName,
        mutation.propName,
        mutation.oldValue,
        mutation.valueType,
        undefined,
        true // skipHistory
      );
    }
  } else if (mutation.type === 'CREATE_QUANTITY') {
    // Undo creation: remove the quantity mutation
    view.removeQuantityMutation(mutation.entityId, mutation.psetName!, mutation.propName);
  } else if (mutation.type === 'UPDATE_QUANTITY') {
    if (mutation.psetName && mutation.propName && mutation.oldValue !== undefined && mutation.oldValue !== null) {
      view.setQuantity(
        mutation.entityId,
        mutation.psetName,
        mutation.propName,
        Number(mutation.oldValue),
        undefined,
        undefined,
        true // skipHistory
      );
    }
  } else if (mutation.type === 'UPDATE_ATTRIBUTE') {
    if (mutation.attributeName) {
      if (mutation.oldValue !== undefined && mutation.oldValue !== null) {
        view.setAttribute(mutation.entityId, mutation.attributeName, String(mutation.oldValue), undefined, true);
      } else {
        view.removeAttributeMutation(mutation.entityId, mutation.attributeName);
      }
    }
  } else if (mutation.type === 'UPDATE_POSITIONAL_ATTRIBUTE') {
    // Positional attrs encode their index in `@N` since the existing
    // Mutation shape has no dedicated field for it.
    const index = positionalIndex(mutation.attributeName);
    if (index !== null) {
      if (mutation.oldValue === null || mutation.oldValue === undefined) {
        view.removePositionalMutation(mutation.entityId, index);
      } else {
        view.setPositionalAttribute(mutation.entityId, index, mutation.oldValue as IfcAttributeValue, true);
      }
    }
    // If this mutation carried a mesh translation (gizmo / numeric
    // move), reverse it so the rendered mesh follows the undo.
    const meshMove = get().mutationMeshTranslations.get(mutation.id);
    if (meshMove) {
      get().setPendingMeshTranslations(
        new Map([[meshMove.globalId, [
          -meshMove.rendererDelta[0],
          -meshMove.rendererDelta[1],
          -meshMove.rendererDelta[2],
        ]]]),
      );
    }
  } else if (mutation.type === 'CREATE_ENTITY') {
    // Undo of a create: stash the NewEntity payload so a subsequent redo
    // can restore it. Without this, redo finds an empty stash and becomes
    // a no-op for the create-then-undo-then-redo path.
    const overlay = view.getNewEntity(mutation.entityId);
    if (overlay) {
      set((s) => {
        const next = new Map(s.removedNewEntities);
        next.set(`${modelId}:${mutation.entityId}`, overlay);
        return { removedNewEntities: next };
      });
    }
    syncAuthoredTreeEntry(get(), modelId, mutation.entityId, overlay, false);
    // The view's `deleteEntity` returns false if it's already gone, which
    // is fine for redo to re-establish.
    view.deleteEntity(mutation.entityId);
    get().mirrorEntityRemove(modelId, mutation.entityId);
    // Also remove the created mesh from the scene + geometryResult (#4925).
    stashAndPruneEntityMesh(get, set, modelId, mutation.entityId);
  } else if (mutation.type === 'DELETE_ENTITY') {
    // Restore a source tombstone or replay an overlay-only entity.
    const stashKey = `${modelId}:${mutation.entityId}`;
    const stashed = get().removedNewEntities.get(stashKey);
    if (stashed) {
      view.restoreNewEntity(stashed); mirrorCreateEntityRedo(get(), modelId, stashed, get().removedMeshes.get(stashKey)?.meshes[0] ?? null);
      syncAuthoredTreeEntry(get(), modelId, mutation.entityId, stashed, true);
    } else {
      view.restoreFromTombstone(mutation.entityId);
      mirrorSourceEntityRestore(get(), modelId, mutation.entityId, get().removedMeshes.get(stashKey)?.meshes[0] ?? null);
    }
    // Re-insert the mesh removeEntity stashed when it pruned geometryResult (#4925).
    restoreStashedEntityMesh(get, set, modelId, mutation.entityId);
    // Also un-hide — covers the (no-mesh) fallback path in removeEntity.
    const cross = get() as unknown as {
      toGlobalId?: (modelId: string, expressId: number) => number;
      showEntity?: (id: number) => void;
    };
    if (cross.toGlobalId && cross.showEntity) {
      const globalId = cross.toGlobalId(modelId, mutation.entityId);
      cross.showEntity(globalId);
    }
  } else if (mutation.type === 'UPDATE_ENTITY_TYPE') {
    // `oldValue` is the class right before this retype: restore it when an
    // earlier retype is still on the stack, otherwise drop the intent to
    // revert the entity to its original class entirely.
    const prevType = mutation.oldValue;
    if (prevType != null && prevType !== '') {
      view.setEntityType(mutation.entityId, String(prevType), undefined, undefined, true);
    } else {
      view.removeTypeMutation(mutation.entityId);
    }
    syncTypeOverride(get, modelId, mutation.entityId);
  } else {
    reportUnreplayable('undo', mutation.type, mutation.entityId);
  }
}

/** Re-apply `mutation` to `view` (one redo step, stacks untouched). */
export function applyRedoToView(get: Get, set: Set, modelId: string, view: MutablePropertyView, mutation: Mutation): void {
  // Re-apply mutation (skipHistory=true); same tombstone guard as undo() (#5223)
  if (isTargetTombstoned(view, mutation)) {
    set({ collabGeometryNotice: 'An element was removed by a collaborator. Its local history was skipped.' });
  } else if (mutation.setOverlay) {
    // ...and from right after, so redo lands the edit exactly again (#5965).
    view.restoreSetOverlay(mutation.setOverlay.after);
  } else if (mutation.type === 'UPDATE_PROPERTY' || mutation.type === 'CREATE_PROPERTY') {
    if (mutation.psetName && mutation.propName && mutation.newValue !== undefined) {
      view.setProperty(
        mutation.entityId,
        mutation.psetName,
        mutation.propName,
        mutation.newValue,
        mutation.valueType,
        undefined,
        true // skipHistory
      );
    }
  } else if (mutation.type === 'DELETE_PROPERTY') {
    if (mutation.psetName && mutation.propName) {
      view.deleteProperty(mutation.entityId, mutation.psetName, mutation.propName, true);
    }
  } else if (mutation.type === 'CREATE_QUANTITY' || mutation.type === 'UPDATE_QUANTITY') {
    if (mutation.psetName && mutation.propName && mutation.newValue !== undefined) {
      view.setQuantity(
        mutation.entityId,
        mutation.psetName,
        mutation.propName,
        Number(mutation.newValue),
        undefined,
        undefined,
        true // skipHistory
      );
    }
  } else if (mutation.type === 'UPDATE_ATTRIBUTE') {
    if (mutation.attributeName && mutation.newValue !== undefined) {
      view.setAttribute(mutation.entityId, mutation.attributeName, String(mutation.newValue), undefined, true);
    }
  } else if (mutation.type === 'UPDATE_POSITIONAL_ATTRIBUTE') {
    const index = positionalIndex(mutation.attributeName);
    if (index !== null && mutation.newValue !== undefined) {
      view.setPositionalAttribute(mutation.entityId, index, mutation.newValue as IfcAttributeValue, true);
    }
    // Replay the mesh translation forward so the rendered mesh
    // follows the redo — mirror of the undo reversal above.
    const meshMove = get().mutationMeshTranslations.get(mutation.id);
    if (meshMove) {
      get().setPendingMeshTranslations(
        new Map([[meshMove.globalId, meshMove.rendererDelta]]),
      );
    }
  } else if (mutation.type === 'CREATE_ENTITY') {
    const stashKey = `${modelId}:${mutation.entityId}`;
    const stashed = get().removedNewEntities.get(stashKey);
    if (stashed) {
      view.restoreNewEntity(stashed);
      mirrorCreateEntityRedo(get(), modelId, stashed, get().removedMeshes.get(stashKey)?.meshes[0] ?? null);
      syncAuthoredTreeEntry(get(), modelId, mutation.entityId, stashed, true);
    } else {
      // Source-buffer entities have no stash; the editor's deleteEntity
      // call simply re-tombstoned them — which is exactly what we want
      // here? No — for CREATE_ENTITY redo we want the entity to come back.
      // Source-entity creates are not a real path; CREATE_ENTITY in this
      // codebase only ever fires for overlay-added entities. Nothing to
      // do if the stash is empty (means the redo is unreachable).
    }
    // Bring the mesh back too, inverse of the undo handler's stash (#4925).
    restoreStashedEntityMesh(get, set, modelId, mutation.entityId);
  } else if (mutation.type === 'DELETE_ENTITY') {
    // Redo of a delete: tombstone again. For overlay-only entities we
    // first stash the NewEntity (it'll be re-fetched for the next undo).
    const overlay = view.getNewEntity(mutation.entityId);
    if (overlay) {
      set((s) => {
        const next = new Map(s.removedNewEntities);
        next.set(`${modelId}:${mutation.entityId}`, overlay);
        return { removedNewEntities: next };
      });
    }
    syncAuthoredTreeEntry(get(), modelId, mutation.entityId, overlay, false);
    view.deleteEntity(mutation.entityId);
    get().mirrorEntityRemove(modelId, mutation.entityId);
    // Drop the mesh back out, inverse of the undo handler's restore (#4925).
    stashAndPruneEntityMesh(get, set, modelId, mutation.entityId);
    // Re-hide the mesh — symmetric with the menu's delete handler
    // and with the undo path above.
    const cross = get() as unknown as {
      toGlobalId?: (modelId: string, expressId: number) => number;
      hideEntity?: (id: number) => void;
    };
    if (cross.toGlobalId && cross.hideEntity) {
      const globalId = cross.toGlobalId(modelId, mutation.entityId);
      cross.hideEntity(globalId);
    }
  } else if (mutation.type === 'UPDATE_ENTITY_TYPE') {
    const newType = mutation.entityType ?? (typeof mutation.newValue === 'string' ? mutation.newValue : undefined);
    if (newType) {
      view.setEntityType(mutation.entityId, newType, mutation.predefinedType ?? undefined, undefined, true);
    }
    syncTypeOverride(get, modelId, mutation.entityId);
  } else {
    reportUnreplayable('redo', mutation.type, mutation.entityId);
  }
}
