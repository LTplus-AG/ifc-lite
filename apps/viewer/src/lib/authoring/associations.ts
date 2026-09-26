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
 * - IfcClassification (reused by Name from source or overlay) ->
 *   IfcClassificationReference -> IfcRelAssociatesClassification;
 * - IfcMaterial (reused by Name likewise) -> IfcRelAssociatesMaterial.
 *
 * Attribute layouts follow the model's schema (IFC2X3 vs IFC4/IFC4X3), the
 * whole add is ONE undo step, and the STEP exporter writes the entities like
 * any other overlay entity. The same overlay delta is mirrored into a shared
 * room so recipients reconstruct the same IFC relationships.
 */

import { MutablePropertyView, StoreEditor, type IfcAttributeValue } from '@ifc-lite/mutations';
import { resolveAllMaterialDefIds, type IfcDataStore } from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { resolveLiveOwnerHistoryId } from '@ifc-lite/sdk';
import type { TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { roomSlotFor } from '@/lib/collab/room-model-target';
import { mirrorStoreOverlayDelta, snapshotOverlay } from '@/sdk/adapters/store-adapter-cost';

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

const referenceId = (value: IfcAttributeValue | undefined): number | null => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  const match = typeof value === 'string' ? /^#(\d+)$/.exec(value) : null;
  return match ? Number(match[1]) : null;
};

/** Source and overlay records, including positional edits from this session. */
function effectiveAttributes(target: Target, id: number): IfcAttributeValue[] | null {
  if (target.view.isDeleted(id)) return null;
  const entity = target.view.getNewEntity(id) ?? target.store.getEntity(id);
  if (!entity) return null;
  const attrs = [...entity.attributes];
  for (const [index, value] of target.view.getPositionalMutationsForEntity(id) ?? []) attrs[index] = value;
  return attrs;
}

function entityNamed(target: Target, type: string, name: string, nameSlot: number): number | null {
  // The source is immutable, so this index walk happens only when the user
  // presses Add; no per-element attribute reparsing on the render path.
  // @raw-entity-enumeration-ok source Name candidates are paired with overlay entities; effectiveAttributes applies tombstones and edits before matching.
  for (const id of target.store.entityIndex.byType.get(type) ?? []) {
    if (effectiveAttributes(target, id)?.[nameSlot] === name) return id;
  }
  for (const entity of target.view.getNewEntitiesOfType(type)) {
    if (effectiveAttributes(target, entity.expressId)?.[nameSlot] === name) return entity.expressId;
  }
  return null;
}

function relatedObjects(attrs: IfcAttributeValue[] | null): IfcAttributeValue[] | null {
  return Array.isArray(attrs?.[4]) ? attrs[4] : null;
}

function relatesTo(attrs: IfcAttributeValue[] | null, ids: readonly number[]): boolean {
  return relatedObjects(attrs)?.some((value) => ids.includes(referenceId(value) ?? -1)) ?? false;
}

/** Include edited source rels: the parser's relationship graph is source-only. */
function effectiveMaterialIds(target: Target, entityIds: readonly number[]): Set<number> {
  const ids = new Set(resolveAllMaterialDefIds(target.store, entityIds.at(-1)!));
  const sourceRelIds = new Set(target.view.getMutations()
    .filter((mutation) => mutation.type === 'UPDATE_POSITIONAL_ATTRIBUTE' && mutation.attributeName === '@4')
    .map((mutation) => mutation.entityId));
  const relIds = [...Array.from(target.view.getNewEntitiesOfType('IFCRELASSOCIATESMATERIAL'), (entity) => entity.expressId), ...sourceRelIds];
  for (const relId of relIds) {
    const entity = target.view.getNewEntity(relId) ?? target.store.getEntity(relId);
    if (entity?.type.toUpperCase() !== 'IFCRELASSOCIATESMATERIAL') continue;
    const attrs = effectiveAttributes(target, relId);
    if (!relatesTo(attrs, entityIds)) continue;
    const materialId = referenceId(attrs?.[5]);
    if (materialId !== null) ids.add(materialId);
  }
  return ids;
}

/** Reuse one existing relationship for this material instead of duplicating it. */
function materialRelationship(target: Target, materialId: number): { id: number; related: string[] } | 'invalid' | null {
  const overlay = target.view.getNewEntitiesOfType('IFCRELASSOCIATESMATERIAL');
  const source = target.store.relationships.forward.getEdges(materialId, RelationshipType.AssociatesMaterial)
    .map((edge) => edge.relationshipId);
  for (const id of [...Array.from(overlay, (entity) => entity.expressId), ...source]) {
    const attrs = effectiveAttributes(target, id);
    const related = relatedObjects(attrs);
    if (referenceId(attrs?.[5]) !== materialId || !related) continue;
    // EntityNode decodes source #references as numbers, but the STEP writer
    // serializes numeric array members as numeric literals. Normalize every
    // preexisting RelatedObjects member before overriding the whole list;
    // otherwise extending a real source rel drops its original recipients.
    const refs: number[] = [];
    for (const value of related) {
      const ref = referenceId(value);
      if (ref === null) return 'invalid';
      refs.push(ref);
    }
    return { id, related: refs.map((ref) => `#${ref}`) };
  }
  return null;
}

function editAsOneStep(target: Target, edit: (draft: StoreEditor) => void): AssociationResult {
  const state = useViewerStore.getState();
  const beforeRoom = roomSlotFor(state, target.storeModelId) ? snapshotOverlay(target.view) : null;
  const before = target.view.getMutations().length;
  target.editor.runAtomic(edit);
  state.recordMutationBatch(target.storeModelId, target.view.getMutations().slice(before));
  if (beforeRoom) mirrorStoreOverlayDelta(useViewerStore, target.storeModelId, target.editor, target.store, beforeRoom, 'association');
  return { ok: true };
}

/**
 * Create the entities `build` adds and record them as ONE undo step. The rel
 * is created last, so undo (which pops newest first) removes it first.
 */
function createAsOneStep(target: Target, build: (add: (type: string, attrs: IfcAttributeValue[]) => number, ownerHistory: string | null) => void): AssociationResult {
  const ownerHistoryId = resolveLiveOwnerHistoryId(target.store, target.editor, target.view);
  // IFC2X3 makes IfcRoot.OwnerHistory mandatory; a rel without one is invalid.
  if (target.ifc2x3 && ownerHistoryId === null) return { ok: false, reasonKey: 'propertyEditor.association.noOwnerHistory' };
  return editAsOneStep(target, (draft) => {
    build((type, attrs) => draft.addEntity(type, attrs).expressId, ownerHistoryId === null ? null : `#${ownerHistoryId}`);
  });
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
    const classification = entityNamed(target, 'IFCCLASSIFICATION', system, 3) ?? add('IfcClassification', attrs);
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
  const baseId = target.view.resolveBaseEntityId(entityId) ?? entityId;
  const material = entityNamed(target, 'IFCMATERIAL', name, 0);
  const current = effectiveMaterialIds(target, [entityId, baseId]);
  // A different material association is a conflict; the target material is
  // already present when this Add is repeated, so the action is idempotent.
  if ([...current].some((id) => id !== material)) {
    return { ok: false, reasonKey: 'propertyEditor.association.hasMaterial' };
  }
  if (material !== null && current.has(material)) return { ok: true };
  const existingRel = material === null ? null : materialRelationship(target, material);
  if (existingRel === 'invalid') return { ok: false, reasonKey: 'propertyEditor.association.invalidRelatedObjects' };
  if (existingRel) {
    return editAsOneStep(target, (draft) => {
      draft.setPositionalAttribute(existingRel.id, 4, [...existingRel.related, `#${entityId}`]);
    });
  }
  return createAsOneStep(target, (add, ownerHistory) => {
    // Existing materials keep their original Category/Description; Name is the
    // IFC identity the user selected for reuse.
    const attrs: IfcAttributeValue[] = target.ifc2x3 ? [name] : [name, description, category];
    const materialId = material ?? add('IfcMaterial', attrs);
    add('IfcRelAssociatesMaterial', [generateIfcGuid(), ownerHistory, null, null, [`#${entityId}`], `#${materialId}`]);
  });
}
