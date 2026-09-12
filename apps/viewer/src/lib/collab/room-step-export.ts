/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, type Mutation } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';
import { roomSymbolicSource } from './room-symbolic-source';
import { asExpressIdRef, readAttributes, resolvePlacementChain, resolveRotationState } from '@/lib/placement-core';
import '@/lib/placement-edit.boot';

export interface RoomStepExportSource {
  dataStore: IfcDataStore;
  mutationView?: MutablePropertyView;
  toSourceIds(ids: ReadonlySet<number> | null | undefined): Set<number> | null | undefined;
  resources?: { modelPath?: string; resources: ReadonlyMap<string, Uint8Array> };
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
    ['Name', (id: number) => roomStore.entities.getName(id), (id: number) => portable.dataStore.entities.getName(id)],
    ['Description', (id: number) => roomStore.entities.getDescription(id), (id: number) => portable.dataStore.entities.getDescription(id)],
    ['ObjectType', (id: number) => roomStore.entities.getObjectType(id), (id: number) => portable.dataStore.entities.getObjectType(id)],
  ] as const;
  for (const [sourceId, roomId] of portable.ownerIds) {
    for (const [name, current, original] of attrs) {
      const value = current(roomId);
      if (value !== original(sourceId)) view.setAttribute(sourceId, name, value);
    }

    const roomPsets = roomStore.getProperties(roomId);
    const roomPsetNames = new Set(roomPsets.map(pset => pset.name));
    for (const pset of portable.dataStore.getProperties(sourceId)) {
      if (!roomPsetNames.has(pset.name)) view.deletePropertySet(sourceId, pset.name);
    }
    for (const pset of roomPsets) for (const prop of pset.properties) {
      view.setProperty(sourceId, pset.name, prop.name, prop.value, prop.type, prop.unit, false, prop.dataType);
    }

    const roomQsets = roomStore.getQuantities(roomId);
    const roomQsetNames = new Set(roomQsets.map(qset => qset.name));
    for (const qset of portable.dataStore.getQuantities(sourceId)) {
      if (!roomQsetNames.has(qset.name)) view.deleteQuantitySet(sourceId, qset.name);
    }
    for (const qset of roomQsets) for (const quantity of qset.quantities) {
      view.setQuantity(sourceId, qset.name, quantity.name, quantity.value, quantity.type, quantity.unit);
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
