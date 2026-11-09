/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which occurrences follow their type's layers (#9296 lane U3).
 *
 * IFC lets an occurrence carry its own IfcMaterialLayerSetUsage, and that
 * association wins over its type's material. A wall or slab is still drawn with
 * its type's build-up when its usage points AT the type's layer set: the usage
 * only places that set on the element (direction, sense, offset). So:
 *
 *  - no material of its own, or a usage whose ForLayerSet is the type's set:
 *    the occurrence INHERITS, and a change to the type's layers reaches it;
 *  - a usage on another set, or any other material: it DIFFERS from the type
 *    and keeps its own layers.
 *
 * A type layer edit that writes a new set re-points the inheriting usages to it
 * (`retargetInheritingLayerUsagesInStore`), so the change reaches every element
 * that was drawn with the type, not only the ones with no material at all.
 */

import { effectiveMetadataRecord, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { EditTarget } from './edit/target.js';
import { liveEntityConforms, readRelatedLists, resolveAuthoringAnchor } from './resolve-relations.js';
import { fromNativeLength } from './anchor.js';
import { addMaterialLayerSetUsageToStore, assignMaterialInStore } from './material.js';
import { typeOccurrencesInStore } from './type-layer-thickness.js';

/** A model's data and its live overlay (null: the file as parsed). */
type Reader = { readonly dataStore: IfcDataStore; readonly view: MutablePropertyView | null | undefined };

export interface TypeLayerScope {
  /** The type's own IfcMaterialLayerSet, or null when it has none. */
  readonly layerSetId: number | null;
  /** Occurrences that follow the type's layers. */
  readonly inheriting: readonly number[];
  /** Occurrences with a material of their own that differs from the type's. */
  readonly differing: readonly number[];
}

/** Every occurrence of `typeId`, split by whether a change to its layers would reach it. */
export function typeLayerScopeInStore(target: Reader, typeId: number): TypeLayerScope {
  const own = ownMaterials(target);
  const layerSetId = typeLayerSetInStore(target, typeId, own);
  const inheriting: number[] = [], differing: number[] = [];
  for (const id of typeOccurrencesInStore(target, typeId)) {
    const material = own.get(id);
    const follows = material === undefined || (layerSetId !== null && usageSet(target, material) === layerSetId);
    (follows ? inheriting : differing).push(id);
  }
  return { layerSetId, inheriting, differing };
}

/** The IfcMaterialLayerSet associated with `typeId` (directly, or through a usage), or null. */
export function typeLayerSetInStore(target: Reader, typeId: number, own = ownMaterials(target)): number | null {
  const material = own.get(typeId);
  if (material === undefined) return null;
  if (liveEntityConforms(target.dataStore, material, 'IfcMaterialLayerSet', target.view)) return material;
  return usageSet(target, material);
}

/**
 * Before `typeId` is given `newLayerSetId`: point every inheriting
 * occurrence's usage at the new set, keeping a wall centred on its axis when it
 * was. A usage that also places the set on an element that does NOT inherit
 * from this type is split: the inheriting occurrences get a usage of their own
 * on the new set (same direction and sense), and the other element keeps the
 * old one. So every occurrence `typeLayerScopeInStore` counts as inheriting,
 * and the impact preview resizes, follows. Returns the occurrences re-pointed;
 * the caller sizes them with the rest.
 */
export function retargetInheritingLayerUsagesInStore(target: EditTarget, typeId: number, newLayerSetId: number): number[] {
  const scope = typeLayerScopeInStore(target, typeId);
  if (scope.layerSetId === null || scope.layerSetId === newLayerSetId) return [];
  const own = ownMaterials(target);
  const inheriting = new Set(scope.inheriting);
  const users = new Map<number, number[]>();
  for (const rel of readRelatedLists(target.dataStore, 'IfcRelAssociatesMaterial', target.view)) {
    if (rel.relatingId !== undefined) users.set(rel.relatingId, [...(users.get(rel.relatingId) ?? []), ...rel.relatedIds]);
  }
  const oldTotal = nativeTotal(target, scope.layerSetId), newTotal = nativeTotal(target, newLayerSetId);
  /** The usage's offset on the new set: a wall's layers centred on its axis start half the total off it, and stay centred. */
  const offsetFor = (attributes: unknown[] | null): number => {
    const offset = real(attributes?.[3]);
    const centred = String(attributes?.[1]).replace(/\./g, '') === 'AXIS2' && oldTotal !== null && newTotal !== null
      && Math.abs(offset + oldTotal / 2) <= 1e-9 * Math.max(1, oldTotal);
    return centred ? -newTotal! / 2 : offset;
  };
  const retargeted: number[] = [];
  for (const usage of new Set(scope.inheriting.map(id => own.get(id)).filter((id): id is number => id !== undefined))) {
    const placed = users.get(usage) ?? [];
    const attributes = attributesOf(target, usage);
    const offset = offsetFor(attributes);
    if (placed.every(id => inheriting.has(id))) {
      target.editor.setPositionalAttribute(usage, 0, `#${newLayerSetId}`);
      if (offset !== real(attributes?.[3])) target.editor.setPositionalAttribute(usage, 3, offset);
      retargeted.push(...placed);
      continue;
    }
    // Shared with an element that keeps the old set: the inheriting ones move to a usage of their own.
    const followers = placed.filter(id => inheriting.has(id));
    const anchor = resolveAuthoringAnchor(target.dataStore, target.view);
    const token = (value: unknown) => String(value).replace(/\./g, '');
    const direction = token(attributes?.[1]), sense = token(attributes?.[2]);
    const split = addMaterialLayerSetUsageToStore(target.editor, anchor, {
      ForLayerSet: newLayerSetId,
      LayerSetDirection: direction === 'AXIS1' || direction === 'AXIS3' ? direction : 'AXIS2',
      DirectionSense: sense === 'NEGATIVE' ? 'NEGATIVE' : 'POSITIVE',
      OffsetFromReferenceLine: fromNativeLength(anchor, offset),
    }).usageId;
    assignMaterialInStore(target.editor, anchor, split, followers, readRelatedLists(target.dataStore, 'IfcRelAssociatesMaterial', target.view));
    retargeted.push(...followers);
  }
  return retargeted;
}

/** Each object's own material association (IfcRelAssociatesMaterial.RelatingMaterial). */
function ownMaterials(target: Reader): Map<number, number> {
  const out = new Map<number, number>();
  for (const rel of readRelatedLists(target.dataStore, 'IfcRelAssociatesMaterial', target.view)) {
    if (rel.relatingId !== undefined) for (const id of rel.relatedIds) out.set(id, rel.relatingId);
  }
  return out;
}

function usageSet(target: Reader, materialId: number): number | null {
  if (!liveEntityConforms(target.dataStore, materialId, 'IfcMaterialLayerSetUsage', target.view)) return null;
  return refId(attributesOf(target, materialId)?.[0]);
}

/** A layer set's total thickness in the file's own length unit, or null when a layer cannot be read. */
function nativeTotal(target: Reader, layerSetId: number): number | null {
  const layers = attributesOf(target, layerSetId)?.[0];
  if (!Array.isArray(layers)) return null;
  let total = 0;
  for (const ref of layers) {
    const id = refId(ref);
    const thickness = id === null ? NaN : real(attributesOf(target, id)?.[1]);
    if (!Number.isFinite(thickness)) return null;
    total += thickness;
  }
  return total;
}

function attributesOf(target: Reader, id: number): unknown[] | null {
  const record = effectiveMetadataRecord(target.dataStore, id, target.view ?? undefined);
  return record?.attributes.length ? record.attributes : null;
}

function refId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  const match = typeof value === 'string' ? /^#(\d+)$/.exec(value) : null;
  return match ? Number(match[1]) : null;
}

function real(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'real' in value) return Number(value.real);
  return Number.NaN;
}
