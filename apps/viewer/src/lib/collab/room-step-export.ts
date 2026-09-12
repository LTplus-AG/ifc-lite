/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getAttributeNamesAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';
import type { Property, PropertyValue, Quantity } from '@ifc-lite/data';
import { MutablePropertyView, StoreEditor, type Mutation } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';
import { roomSymbolicSource } from './room-symbolic-source';
import { propertyValueTypeFor } from './mutation-bridge';
import { asExpressIdRef, readAttributes, resolvePlacementChain, resolveRotationState } from '@/lib/placement-core';
import '@/lib/placement-edit.boot';

export interface RoomStepExportSource {
  dataStore: IfcDataStore;
  mutationView?: MutablePropertyView;
  toSourceIds(ids: ReadonlySet<number> | null | undefined): Set<number> | null | undefined;
  resources?: { modelPath?: string; resources: ReadonlyMap<string, Uint8Array> };
}

function valuesEqual(left: PropertyValue, right: PropertyValue): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return left === right;
  return left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]!));
}

function propertyEqual(left: Property, right: Property): boolean {
  if (Array.isArray(right.value) && typeof left.value === 'string') {
    return left.value === JSON.stringify(right.value);
  }
  return valuesEqual(left.value, right.value);
}

function quantityEqual(left: Quantity, right: Quantity): boolean {
  return left.value === right.value;
}

function snapshotView(
  roomStore: IfcDataStore,
  portable: NonNullable<ReturnType<typeof roomSymbolicSource>>,
  modelId: string,
): MutablePropertyView {
  const view = new MutablePropertyView(portable.dataStore.properties, modelId);
  configureMutationView(view, portable.dataStore);
  const editor = new StoreEditor(portable.dataStore, view);
  const attrs = [
    ['Name', (id: number) => portable.dataStore.entities.getName(id)],
    ['Description', (id: number) => portable.dataStore.entities.getDescription(id)],
    ['ObjectType', (id: number) => portable.dataStore.entities.getObjectType(id)],
    ['Tag', (id: number) => portable.dataStore.entities.getTag?.(id) ?? ''],
  ] as const;
  for (const [sourceId, roomId] of portable.ownerIds) {
    const roomAttributes = portable.structuredAttributes.get(sourceId) ?? {};
    for (const [name, original] of attrs) {
      const value = roomAttributes[`bsi::ifc::prop::${name}`];
      const originalValue = original(sourceId);
      if (value === undefined) {
        if (!originalValue) continue;
        const type = portable.dataStore.entities.getTypeName(sourceId);
        const index = getAttributeNamesAcrossSchemas(type).indexOf(name);
        if (index >= 0) editor.setPositionalAttribute(sourceId, index, null);
      } else if (typeof value === 'string' && value !== originalValue) {
        view.setAttribute(sourceId, name, value);
      }
    }

    const originalPsets = portable.dataStore.getProperties(sourceId);
    const originalPsetsByName = new Map(originalPsets.map(pset => [pset.name, pset]));
    const roomPsets = portable.structuredPsets.get(sourceId) ?? {};
    for (const pset of originalPsets) {
      const current = roomPsets[pset.name];
      if (!current) {
        view.deletePropertySet(sourceId, pset.name);
        continue;
      }
      for (const prop of pset.properties) {
        if (!(prop.name in current)) view.deleteProperty(sourceId, pset.name, prop.name);
      }
    }
    for (const [psetName, properties] of Object.entries(roomPsets)) for (const [propName, value] of Object.entries(properties)) {
      const original = originalPsetsByName.get(psetName)?.properties.find(item => item.name === propName);
      const current: Property = { name: propName, type: propertyValueTypeFor(value.type), value: value.value, unit: value.unit };
      if (original && propertyEqual(current, original)) continue;
      view.setProperty(
        sourceId,
        psetName,
        propName,
        value.value,
        original?.type ?? current.type,
        original?.unit ?? value.unit,
        false,
        original?.dataType ?? value.type,
      );
    }

    const roomQsets = portable.structuredQuantities.get(sourceId) ?? {};
    const roomQsetDisplay = new Map(roomStore.getQuantities(roomId).map(qset => [qset.name, qset]));
    const originalQsets = portable.dataStore.getQuantities(sourceId);
    const originalQsetsByName = new Map(originalQsets.map(qset => [qset.name, qset]));
    const roomQsetNames = new Set(Object.keys(roomQsets));
    for (const qset of originalQsets) {
      if (!roomQsetNames.has(qset.name)) view.deleteQuantitySet(sourceId, qset.name);
      else for (const quantity of qset.quantities) {
        if (!(quantity.name in roomQsets[qset.name]!)) view.deleteQuantity(sourceId, qset.name, quantity.name);
      }
    }
    for (const [qsetName, quantities] of Object.entries(roomQsets)) for (const [quantityName, value] of Object.entries(quantities)) {
      const original = originalQsetsByName.get(qsetName)?.quantities.find(item => item.name === quantityName);
      const displayed = roomQsetDisplay.get(qsetName)?.quantities.find(item => item.name === quantityName);
      const current: Quantity = { name: quantityName, type: original?.type ?? displayed?.type ?? 0, value };
      if (original && quantityEqual(current, original)) continue;
      view.setQuantity(
        sourceId,
        qsetName,
        quantityName,
        value,
        current.type,
        original?.unit ?? displayed?.unit,
      );
    }

    const placement = portable.placements.get(sourceId);
    if (!placement) continue;
    const chain = resolvePlacementChain(portable.dataStore, view, editor, sourceId);
    if (chain) editor.setPositionalAttribute(chain.cartesianPointId, 0, placement.location);
    const axisAttrs = chain ? readAttributes(portable.dataStore, view, editor, chain.axisPlacementId) : null;
    const axisId = asExpressIdRef(axisAttrs?.[1]);
    if (axisId && placement.axis) editor.setPositionalAttribute(axisId, 0, placement.axis);
    const rotation = resolveRotationState(portable.dataStore, view, editor, sourceId);
    if (rotation?.refDirectionId && placement.refDirection) {
      editor.setPositionalAttribute(rotation.refDirectionId, 0, placement.refDirection);
    }
  }
  return view;
}

/** True only while the portable source covers every root in the live room. */
export function canExportRoomAsStep(
  roomStore: IfcDataStore,
  roomView?: MutablePropertyView,
): boolean {
  const portable = roomSymbolicSource(roomStore);
  if (!portable) return false;
  if (portable.ownerIds.size !== portable.seededIds.size) return false;
  const portableRoomIds = new Set(portable.ownerIds.values());
  if (portableRoomIds.size !== roomStore.entities.expressId.length) return false;
  if (!roomStore.entities.expressId.every(roomId => portableRoomIds.has(roomId))) return false;
  if (!roomView) return true;
  return roomView.getMutations().every(mutation => portableRoomIds.has(mutation.entityId));
}

/**
 * Recover a room slot's complete STEP model for ordinary IFC export. Room
 * mutations address the reconstructed IFCX ids, so replay them under the
 * source ids matched by GlobalId before handing the model to StepExporter.
 */
export function roomStepExportSource(
  roomStore: IfcDataStore,
  roomView: MutablePropertyView | undefined,
  modelId: string,
): RoomStepExportSource | null {
  const portable = roomSymbolicSource(roomStore);
  if (!portable || !canExportRoomAsStep(roomStore, roomView)) return null;

  const sourceIdByRoomId = new Map<number, number>();
  for (const [sourceId, roomId] of portable.ownerIds) sourceIdByRoomId.set(roomId, sourceId);
  const toSourceIds = (ids: ReadonlySet<number> | null | undefined): Set<number> | null | undefined => {
    if (ids === null || ids === undefined) return ids;
    const out = new Set<number>();
    for (const roomId of ids) {
      const sourceId = sourceIdByRoomId.get(roomId);
      if (sourceId === undefined) throw new Error(`Room entity #${roomId} is outside the portable IFC source.`);
      out.add(sourceId);
    }
    return out;
  };
  const view = snapshotView(roomStore, portable, modelId);
  const mutations: Mutation[] = (roomView?.getMutations() ?? []).map(mutation => ({
    ...mutation,
    modelId,
    entityId: sourceIdByRoomId.get(mutation.entityId)!,
  }));
  view.applyMutations(mutations);
  return {
    dataStore: portable.dataStore,
    mutationView: view.hasPendingChanges() ? view : undefined,
    toSourceIds,
    resources: portable.resources,
  };
}
