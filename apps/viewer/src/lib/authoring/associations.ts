/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Add Classification" and "Add Material" as real IFC entities (#5876).
 *
 * The Properties panel used to store these as look-alike property sets
 * ("Classification [Uniclass]", "Material [Concrete]"), which no exporter,
 * reader, IDS facet or downstream tool recognises. They now create, in the
 * model's mutation overlay:
 *
 * - IfcClassification (reused if this session already made an identical one) ->
 *   IfcClassificationReference -> IfcRelAssociatesClassification;
 * - IfcMaterial (reused likewise) -> IfcRelAssociatesMaterial.
 *
 * Attribute layouts follow the model's schema (IFC2X3 vs IFC4/IFC4X3), the
 * whole add is ONE undo step, and the STEP exporter writes the entities like
 * any other overlay entity. Collab mirroring is out of scope, as it was for
 * the property-set form this replaces.
 */

import { MutablePropertyView, StoreEditor, type IfcAttributeValue } from '@ifc-lite/mutations';
import { extractAllMaterialsOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { resolveLiveOwnerHistoryId } from '@ifc-lite/sdk';
import type { TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { overlayMaterials } from './association-overlay';

export type AssociationResult = { ok: true } | { ok: false; reasonKey: TranslationKey };

export interface ClassificationInput { system: string; identification: string; name?: string }
export interface MaterialInput { name: string; category?: string; description?: string }

/** Text the STEP writer would read as `$`, `*`, a `#N` reference or a `.ENUM.` instead of a string. */
const STEP_TOKEN = /^\s*(\$|\*|#\d+|\.[A-Za-z0-9_]+\.)\s*$/;

interface Target { storeModelId: string; store: IfcDataStore; view: MutablePropertyView; editor: StoreEditor; ifc2x3: boolean }

function resolveTarget(modelId: string): Target | AssociationResult {
  const state = useViewerStore.getState();
  if (!state.canCollabEdit()) return { ok: false, reasonKey: 'propertyEditor.association.readOnly' };
  const storeModelId = modelId === 'legacy' ? '__legacy__' : modelId;
  const store = state.models.get(modelId)?.ifcDataStore ?? state.ifcDataStore;
  if (!store) return { ok: false, reasonKey: 'propertyEditor.association.noModel' };
  let view = state.getMutationView(storeModelId);
  if (!view) {
    view = new MutablePropertyView(store.properties || null, storeModelId);
    configureMutationView(view, store);
    state.registerMutationView(storeModelId, view);
  }
  let editor = state.storeEditors.get(storeModelId);
  if (!editor) {
    editor = new StoreEditor(store, view);
    state.storeEditors.set(storeModelId, editor);
  }
  return { storeModelId, store, view, editor, ifc2x3: store.schemaVersion === 'IFC2X3' };
}

/** A live session-created entity of `type` whose attributes equal `attrs` exactly. */
function sessionEntityMatching(view: MutablePropertyView, type: string, attrs: IfcAttributeValue[]): number | null {
  const key = JSON.stringify(attrs);
  for (const e of view.getNewEntitiesOfType(type)) {
    if (!view.isDeleted(e.expressId) && JSON.stringify(e.attributes) === key) return e.expressId;
  }
  return null;
}

/**
 * Create the entities `build` adds and record them as ONE undo step. The rel
 * is created last, so undo (which pops newest first) removes it first.
 */
function createAsOneStep(target: Target, build: (add: (type: string, attrs: IfcAttributeValue[]) => number, ownerHistory: string | null) => void): AssociationResult {
  const ownerHistoryId = resolveLiveOwnerHistoryId(target.store, target.editor, target.view);
  // IFC2X3 makes IfcRoot.OwnerHistory mandatory; a rel without one is invalid.
  if (target.ifc2x3 && ownerHistoryId === null) return { ok: false, reasonKey: 'propertyEditor.association.noOwnerHistory' };
  const before = target.view.getMutations().length;
  target.editor.runAtomic((draft) => {
    build((type, attrs) => draft.addEntity(type, attrs).expressId, ownerHistoryId === null ? null : `#${ownerHistoryId}`);
  });
  useViewerStore.getState().recordMutationBatch(target.storeModelId, target.view.getMutations().slice(before));
  return { ok: true };
}

export function addClassificationAssociation(modelId: string, entityId: number, input: ClassificationInput): AssociationResult {
  const system = input.system.trim();
  const identification = input.identification.trim();
  const name = input.name?.trim() || identification;
  if ([system, identification, name].some((v) => STEP_TOKEN.test(v))) return { ok: false, reasonKey: 'propertyEditor.association.stepToken' };
  const target = resolveTarget(modelId);
  if (!('editor' in target)) return target;
  return createAsOneStep(target, (add, ownerHistory) => {
    // IfcClassification.Name is slot 3 in every schema; Source and Edition are mandatory in IFC2X3.
    const attrs: IfcAttributeValue[] = target.ifc2x3 ? [system, '', null, system] : [null, null, null, system, null, null, null];
    const classification = sessionEntityMatching(target.view, 'IFCCLASSIFICATION', attrs) ?? add('IfcClassification', attrs);
    // Location, ItemReference|Identification, Name, ReferencedSource (+ Description, Sort in IFC4+).
    const reference = add('IfcClassificationReference', target.ifc2x3
      ? [null, identification, name, `#${classification}`]
      : [null, identification, name, `#${classification}`, null, null]);
    add('IfcRelAssociatesClassification', [generateIfcGuid(), ownerHistory, null, null, [`#${entityId}`], `#${reference}`]);
  });
}

export function addMaterialAssociation(modelId: string, entityId: number, input: MaterialInput): AssociationResult {
  const name = input.name.trim();
  const category = input.category?.trim() || null;
  const description = input.description?.trim() || null;
  if ([name, category, description].some((v) => v !== null && STEP_TOKEN.test(v))) return { ok: false, reasonKey: 'propertyEditor.association.stepToken' };
  const target = resolveTarget(modelId);
  if (!('editor' in target)) return target;
  // One material association per element: a second IfcRelAssociatesMaterial
  // would leave two competing materials, which no reader resolves the same way.
  const baseId = target.view.resolveBaseEntityId(entityId) ?? entityId;
  if (extractAllMaterialsOnDemand(target.store, baseId).length > 0 || overlayMaterials(target.view, [entityId, baseId], target.store.schemaVersion).length > 0) {
    return { ok: false, reasonKey: 'propertyEditor.association.hasMaterial' };
  }
  return createAsOneStep(target, (add, ownerHistory) => {
    // Reused only when Name, Description and Category all match: a same-named
    // material with another category is a different material.
    const attrs: IfcAttributeValue[] = target.ifc2x3 ? [name] : [name, description, category];
    const material = sessionEntityMatching(target.view, 'IFCMATERIAL', attrs) ?? add('IfcMaterial', attrs);
    add('IfcRelAssociatesMaterial', [generateIfcGuid(), ownerHistory, null, null, [`#${entityId}`], `#${material}`]);
  });
}
