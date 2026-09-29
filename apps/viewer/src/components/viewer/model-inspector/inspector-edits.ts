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
import { AUTHORED_KINDS, occurrencesOf } from '@/lib/commands/modeling/authored-kinds';
import type { AuthoringTransaction, ModelingCommand } from '@/lib/commands/modeling/types';
import type { AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';
import { detachFromType, recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { setWallSection, type WallSection } from '@/store/slices/mutation-wall-section';

/**
 * Run one inspector edit as one undo step. `edit` writes through
 * `tx.store` and returns the express ids whose mesh it changed. False (with
 * a toast) when the edit was refused or threw; nothing is left behind then.
 */
export function runInspectorEdit(modelId: string, edit: (tx: AuthoringTransaction) => readonly number[]): boolean {
  const command: ModelingCommand = {
    id: 'inspector.edit',
    labelKey: 'modelInspector.edit',
    hud: {},
    snap: 'modeling',
    init: () => null,
    pointerMove: (g) => g,
    pointerDown: (g) => g,
    commit: (_g, tx) => ({ created: [], deleted: [], remesh: [...edit(tx)] }),
  };
  const get = useViewerStore.getState;
  const outcome = runTransaction(useViewerStore, command, null, { get, modelId, storeyId: get().session?.storeyId ?? null, workplane: null });
  if (!outcome.ok) toast.error(outcome.reason);
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
  return runInspectorEdit(modelId, (tx) => {
    const dataStore = tx.store.models.get(tx.modelId)?.ifcDataStore;
    if (!dataStore) throw new Error(`No model loaded for id "${tx.modelId}"`);
    recordModellingEdit(useViewerStore, tx.modelId, (methods, draft) => {
      if (typeId === null) detachFromType(draft, dataStore, [elementId]);
      else methods.assignType(tx.modelId, typeId, [elementId]);
    });
    return [elementId];
  });
}

/** A new type object of the kind's class, typing `elementId` when given. The new type's id, or null when refused. */
export function createElementType(modelId: string, kind: AuthoredElementKind, name: string, elementId?: number): number | null {
  let typeId: number | null = null;
  const ok = runInspectorEdit(modelId, (tx) => {
    recordModellingEdit(useViewerStore, tx.modelId, (methods) => {
      typeId = methods.addElementType(tx.modelId, { Type: AUTHORED_KINDS[kind].type, Name: name }).expressId;
      if (elementId !== undefined) methods.assignType(tx.modelId, typeId, [elementId]);
    });
    return elementId === undefined ? [] : [elementId];
  });
  return ok ? typeId : null;
}

/** A wall's thickness and/or height, in metres. */
export function setWallDimensions(modelId: string, expressId: number, section: WallSection): boolean {
  return runInspectorEdit(modelId, (tx) => {
    const outcome = setWallSection(() => tx.store, tx.modelId, expressId, section);
    if (!outcome.ok) throw new Error(outcome.reason);
    return [expressId];
  });
}

export interface LayerInput {
  /** Metres, > 0. */
  readonly thickness: number;
  /** An existing IfcMaterial, a new one by name, or none. */
  readonly material: { readonly id: number } | { readonly name: string } | null;
}

export interface ApplyLayersSpec {
  readonly kind: AuthoredElementKind;
  readonly layers: readonly LayerInput[];
  /** Where the set goes: an IfcMaterialLayerSetUsage on `elementId`, or the set on `typeId`. */
  readonly target: 'element' | 'type';
  /** Absent in defaults mode: the set is only written, for the defaults to name. */
  readonly elementId?: number;
  readonly typeId: number | null;
}

/**
 * Write any new IfcMaterial, the IfcMaterialLayerSet, and associate it (on
 * the element through a usage: across a wall centred on its axis, up through
 * a slab; or on the type). A wall layered this way takes the layers' total
 * thickness in the same step. The new set's id, or null when refused.
 */
export function applyMaterialLayers(modelId: string, spec: ApplyLayersSpec): number | null {
  const { kind, layers, target, elementId, typeId } = spec;
  const direction = AUTHORED_KINDS[kind].layers;
  if (!direction) throw new Error(`A ${kind} has no material layers`);
  const total = layers.reduce((sum, layer) => sum + layer.thickness, 0);
  let layerSetId: number | null = null;
  const ok = runInspectorEdit(modelId, (tx) => {
    recordModellingEdit(useViewerStore, tx.modelId, (m) => {
      const MaterialLayers = layers.map((layer) => ({
        LayerThickness: layer.thickness,
        Material: layer.material === null ? undefined
          : 'id' in layer.material ? layer.material.id
            : m.addMaterial(tx.modelId, { Name: layer.material.name }).expressId,
      }));
      const setId = m.addMaterialLayerSet(tx.modelId, { MaterialLayers }).expressId;
      layerSetId = setId;
      if (target === 'type') {
        if (typeId === null) throw new Error('This element has no type to layer');
        m.assignMaterial(tx.modelId, setId, [typeId]);
      } else if (elementId !== undefined) {
        const usage = m.addMaterialLayerSetUsage(tx.modelId, {
          ForLayerSet: setId, LayerSetDirection: direction, OffsetFromReferenceLine: direction === 'AXIS2' ? -total / 2 : 0,
        });
        m.assignMaterial(tx.modelId, usage.expressId, [elementId]);
      }
    });
    if (target === 'type') {
      const dataStore = tx.store.models.get(tx.modelId)?.ifcDataStore;
      return typeId === null || !dataStore ? [] : occurrencesOf({ dataStore, view: tx.store.mutationViews.get(tx.modelId) }, typeId);
    }
    if (elementId === undefined) return [];
    if (kind === 'wall') {
      const section = setWallSection(() => tx.store, tx.modelId, elementId, { thickness: total });
      if (!section.ok) throw new Error(section.reason);
    }
    return [elementId];
  });
  return ok ? layerSetId : null;
}
