/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live, read-only facts a reviewed authoring operation is checked against:
 * an element's class and name, its type and material, its placement location
 * and angle, and what a deletion would orphan. Everything reads through the
 * model's effective view (base + this session's edits); nothing writes, so a
 * preview can run during render.
 */

import { StoreEditor } from '@ifc-lite/mutations';
import { RelationshipType } from '@ifc-lite/data';
import { liveEntityConforms, liveEntityType, readRelatedLists } from '@ifc-lite/create';
import { remeshContextRoots } from '@ifc-lite/export';
import type { ViewerState } from '@/store';
import { entityName, typeOf } from '@/lib/commands/modeling/authored-kinds';
import { pointToMetres } from '@/lib/length-unit-scale';
import { resolvePlacementChain, resolveRotationState } from '@/lib/placement-edit';
import { modelReader, type ModelReader } from './model-change-values';

export interface AuthoringReader extends ModelReader {
  readonly modelId: string;
  readonly editor: StoreEditor;
}

/** The live view and the store's cached editor when the model has them; otherwise private ones that never enter the store. */
export function authoringReader(state: ViewerState, modelId: string): AuthoringReader | null {
  const reader = modelReader(state, modelId);
  if (!reader) return null;
  const cached = state.mutationViews.get(modelId) === reader.view ? state.storeEditors.get(modelId) : undefined;
  return { ...reader, modelId, editor: cached ?? new StoreEditor(reader.dataStore, reader.view) };
}

const live = (reader: AuthoringReader) => ({ dataStore: reader.dataStore, view: reader.view });

export function conforms(reader: AuthoringReader, expressId: number, ifcClass: string): boolean {
  return liveEntityConforms(reader.dataStore, expressId, ifcClass, reader.view);
}

/** The live class in IFC PascalCase where the schema knows it (`IfcWall`), else as stored. */
export function className(reader: AuthoringReader, expressId: number): string {
  return reader.view.getNewEntity(expressId)?.type || reader.dataStore.entities.getTypeName(expressId)
    || liveEntityType(reader.dataStore, expressId, reader.view) || '';
}

export const nameOf = (reader: AuthoringReader, expressId: number): string => entityName(live(reader), expressId);

/** The name of the element's type object, or null when untyped. */
export function typeNameOf(reader: AuthoringReader, expressId: number): string | null {
  const typeId = typeOf(live(reader), expressId);
  return typeId === null ? null : nameOf(reader, typeId);
}

/** The name of what is directly associated as material (an IfcMaterial's Name, a set's name or ''), or null. */
export function materialNameOf(reader: AuthoringReader, expressId: number): string | null {
  const relating = readRelatedLists(reader.dataStore, 'IfcRelAssociatesMaterial', reader.view)
    .find((rel) => rel.relatedIds.includes(expressId))?.relatingId;
  return relating === undefined ? null : nameOf(reader, relating);
}

/** Placement location relative to the parent placement, metres; null when the chain is not a plain local placement. */
export function placementLocation(reader: AuthoringReader, expressId: number): [number, number, number] | null {
  const chain = resolvePlacementChain(reader.dataStore, reader.view, reader.editor, expressId);
  return chain ? pointToMetres(reader.dataStore, chain.coordinates) : null;
}

/** Yaw about Z in degrees, and whether the placement carries the explicit RefDirection a turn rewrites. */
export function placementAngle(reader: AuthoringReader, expressId: number): { deg: number; turnable: boolean } | null {
  const state = resolveRotationState(reader.dataStore, reader.view, reader.editor, expressId);
  return state ? { deg: (state.yawZ * 180) / Math.PI, turnable: state.refDirectionId !== null } : null;
}

/** Classes a reviewed deletion may remove: single elements whose removal leaves no dependent geometry behind. */
const DELETABLE = ['IfcWall', 'IfcSlab', 'IfcRoof', 'IfcPlate', 'IfcColumn', 'IfcBeam', 'IfcMember', 'IfcSpace', 'IfcDoor', 'IfcWindow',
  'IfcCovering', 'IfcFurnishingElement', 'IfcBuildingElementProxy'];

/** Why deleting the element would break the model (dependents, unsupported class), or null. */
export function deletionRefusal(reader: AuthoringReader, expressId: number): string | null {
  if (!DELETABLE.some((ifcClass) => conforms(reader, expressId, ifcClass))) {
    return `${className(reader, expressId)} is not deleted by reviewed authoring (supported: ${DELETABLE.join(', ')})`;
  }
  const parts = reader.dataStore.relationships?.getRelated(expressId, RelationshipType.Aggregates, 'forward') ?? [];
  if (parts.some((id) => !reader.view.isDeleted(id))) return 'It is an assembly of other elements; deleting it would orphan its parts';
  if (conforms(reader, expressId, 'IfcDoor') || conforms(reader, expressId, 'IfcWindow')) return null;
  const openings = [...remeshContextRoots(reader.dataStore, reader.view, new Set([expressId]))]
    .filter((id) => id !== expressId && conforms(reader, id, 'IfcOpeningElement'));
  return openings.length > 0 ? `It hosts ${openings.length} opening(s); deleting it would leave their voids and fillings without a host` : null;
}
