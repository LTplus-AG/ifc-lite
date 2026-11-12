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

import { MutablePropertyView, StoreEditor, iterateEffectiveEntityIds, type IfcAttributeValue } from '@ifc-lite/mutations';
import { effectiveMetadataRecord, type IfcDataStore } from '@ifc-lite/parser';
import { liveEntityConforms } from '@ifc-lite/create';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { resolveLiveOwnerHistoryId } from '@ifc-lite/sdk';
import type { TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { mutationDenialKey, mutationPermission } from '@/store/mutation-permission';
import { configureMutationView } from '@/utils/configureMutationView';
import { roomSlotFor } from '@/lib/collab/room-model-target';
import { mirrorStoreOverlayDelta, snapshotOverlay } from '@/sdk/adapters/store-adapter-cost';

import { setElementMaterial } from '@/components/viewer/model-inspector/inspector-edits';

export type AssociationResult = { ok: true } | { ok: false; reasonKey: TranslationKey };

export interface ClassificationInput { system: string; identification: string; name?: string }
export interface MaterialInput { name: string; category?: string; description?: string; color?: string }

/** Text the STEP writer would read as `$`, `*`, a `#N` reference or a `.ENUM.` instead of a string. */
const STEP_TOKEN = /^\s*(\$|\*|#\d+|\.[A-Za-z0-9_]+\.)\s*$/;

interface Target { storeModelId: string; store: IfcDataStore; view: MutablePropertyView; editor: StoreEditor; ifc2x3: boolean }

function resolveTarget(modelId: string): Target | AssociationResult {
  const state = useViewerStore.getState();
  const permission = mutationPermission(state, modelId);
  if (!permission.allowed) return {
    ok: false,
    reasonKey: permission.reason === 'collab-role'
      ? 'propertyEditor.association.readOnly' : mutationDenialKey(permission.reason),
  };
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

/** Source and overlay records, including positional edits from this session. */
function effectiveAttributes(target: Pick<Target, 'store' | 'view'>, id: number): IfcAttributeValue[] | null {
  if (target.view.isDeleted(id)) return null;
  const entity = target.view.getNewEntity(id) ?? target.store.getEntity(id);
  if (!entity) return null;
  const attrs = [...entity.attributes];
  for (const [index, value] of target.view.getPositionalMutationsForEntity(id) ?? []) attrs[index] = value;
  return attrs;
}

function entityNamed(target: Pick<Target, 'store' | 'view'>, type: string, name: string, nameSlot: number): number | null {
  if (type === 'IFCCLASSIFICATION') {
    for (const { expressId } of iterateEffectiveEntityIds(target.store, target.view, ['IfcClassification'])) {
      const record = effectiveMetadataRecord(target.store, expressId, target.view);
      if (record?.attributes[nameSlot] === name) return expressId;
    }
    return null;
  }
  const matches = (id: number) => effectiveAttributes(target, id)?.[nameSlot] === name;
  // The source is immutable, so this index walk happens only when the user
  // presses Add; no per-element attribute reparsing on the render path.
  // @raw-entity-enumeration-ok source Name candidates are paired with overlay entities; effectiveAttributes applies tombstones and edits before matching.
  for (const id of target.store.entityIndex.byType.get(type) ?? []) {
    if (matches(id)) return id;
  }
  for (const entity of target.view.getNewEntitiesOfType(type)) {
    if (matches(entity.expressId)) return entity.expressId;
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

function classificationText(input: ClassificationInput): Required<ClassificationInput> | null {
  const system = input.system.trim();
  const identification = input.identification.trim();
  const name = input.name?.trim() || identification;
  return [system, identification, name].some((v) => STEP_TOKEN.test(v)) ? null : { system, identification, name };
}

function classificationEntities(target: Pick<Target, 'store' | 'view'>, entityId: number,
  input: Required<ClassificationInput>, add: (type: string, attrs: IfcAttributeValue[]) => number, ownerHistory: string | null): void {
  const { system, identification, name } = input;
  const ifc2x3 = target.store.schemaVersion === 'IFC2X3';
  // IfcClassification.Name is slot 3 in every schema; Source and Edition are mandatory in IFC2X3.
  const attrs: IfcAttributeValue[] = ifc2x3 ? [system, '', null, system] : [null, null, null, system, null, null, null];
  const classification = entityNamed(target, 'IFCCLASSIFICATION', system, 3) ?? add('IfcClassification', attrs);
  // Location, ItemReference|Identification, Name, ReferencedSource (+ Description, Sort in IFC4+).
  const reference = add('IfcClassificationReference', ifc2x3
    ? [null, identification, name, `#${classification}`]
    : [null, identification, name, `#${classification}`, null, null]);
  add('IfcRelAssociatesClassification', [generateIfcGuid(), ownerHistory, null, null, [`#${entityId}`], `#${reference}`]);
}

/** Same native association construction on a caller-owned unpublished or approved draft (#7271). */
export function addClassificationInDraft(store: IfcDataStore, draft: StoreEditor, entityId: number, input: ClassificationInput): AssociationResult {
  const text = classificationText(input);
  if (!text) return { ok: false, reasonKey: 'propertyEditor.association.stepToken' };
  const view = draft.getMutationView();
  if (!liveEntityConforms(store, entityId, store.schemaVersion === 'IFC2X3' ? 'IfcRoot' : 'IfcDefinitionSelect', view)) {
    return { ok: false, reasonKey: 'propertyEditor.association.classificationTarget' };
  }
  const ownerHistoryId = resolveLiveOwnerHistoryId(store, draft, view);
  if (store.schemaVersion === 'IFC2X3' && ownerHistoryId === null) return { ok: false, reasonKey: 'propertyEditor.association.noOwnerHistory' };
  classificationEntities({ store, view }, entityId, text,
    (type, attrs) => draft.addEntity(type, attrs).expressId, ownerHistoryId === null ? null : `#${ownerHistoryId}`);
  return { ok: true };
}

export function addClassificationAssociation(modelId: string, entityId: number, input: ClassificationInput): AssociationResult {
  const text = classificationText(input);
  if (!text) return { ok: false, reasonKey: 'propertyEditor.association.stepToken' };
  const target = resolveTarget(modelId);
  if (!('editor' in target)) return target;
  return createAsOneStep(target, (add, ownerHistory) => classificationEntities(target, entityId, text, add, ownerHistory));
}

export function addMaterialAssociation(modelId: string, entityId: number, input: MaterialInput): AssociationResult {
  if ([input.name, input.category, input.description].some(v => v !== undefined && STEP_TOKEN.test(v))) return { ok: false, reasonKey: 'propertyEditor.association.stepToken' };
  const target = resolveTarget(modelId);
  if (!('editor' in target)) return target;
  const owner = resolveLiveOwnerHistoryId(target.store, target.editor, target.view);
  if (target.ifc2x3 && owner === null) return { ok: false, reasonKey: 'propertyEditor.association.noOwnerHistory' };
  const existing = input.color === undefined ? entityNamed(target, 'IFCMATERIAL', input.name.trim(), 0) : null;
  return setElementMaterial(modelId, entityId, existing ?? { Name: input.name.trim(), Color: input.color, Category: target.ifc2x3 ? undefined : input.category || undefined, Description: target.ifc2x3 ? undefined : input.description || undefined })
    ? { ok: true } : { ok: false, reasonKey: 'propertyEditor.association.invalidRelatedObjects' };
}
