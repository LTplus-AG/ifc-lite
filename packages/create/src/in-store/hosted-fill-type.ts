/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A placed door or window is a typed occurrence (#9296 lane C2).
 *
 * Revit families and Archicad door/window objects are always instances of a
 * type. A hosted fill placed without one is typed by an IfcDoorType or
 * IfcWindowType named for its size and operation, reusing a live type of that
 * name, so twenty 0.9 × 2.1 m doors share one type rather than making twenty.
 * An explicit `TypeId` types the fill by that type instead. IFC2X3 has no
 * IfcDoorType / IfcWindowType (its IfcDoorStyle is a different record), so
 * fills there stay untyped.
 */

import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { HostAnchor } from './anchor.js';
import { addElementTypeToStore, assignTypeInStore } from './element-type.js';
import { DOOR_OPERATION_ENUM } from './door.js';
import { WINDOW_PARTITIONING_ENUM } from './window.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { liveEntityConforms, readRelatedLists } from './resolve-relations.js';

export interface HostedFillTypeParams {
  Width: number;
  Height: number;
  PredefinedType?: string;
  OperationType?: string;
  UserDefinedOperationType?: string;
  PartitioningType?: string;
  UserDefinedPartitioningType?: string;
  /** Type the fill by this IfcDoorType / IfcWindowType; omitted reuses or creates one by size. */
  TypeId?: number;
}

const DEFAULT_OPERATION = 'SINGLE_SWING_LEFT';

/** The type's PredefinedType: the fill's own, or DOOR / WINDOW when it names none. */
function typePredefined(kind: 'door' | 'window', params: HostedFillTypeParams): string {
  return params.PredefinedType ?? (kind === 'door' ? 'DOOR' : 'WINDOW');
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  DOOR: 'Door', GATE: 'Gate', TRAPDOOR: 'Trapdoor', WINDOW: 'Window', SKYLIGHT: 'Skylight', LIGHTDOME: 'Light dome',
};

/** `Door 900 × 2100` / `Gate 900 × 2100`, with a non-default operation or partitioning appended. */
export function hostedFillTypeName(kind: 'door' | 'window', params: HostedFillTypeParams): string {
  const mm = (metres: number) => String(Math.round(metres * 1000));
  const predefined = typePredefined(kind, params);
  const label = KIND_LABEL[predefined] ?? `${kind === 'door' ? 'Door' : 'Window'} (${predefined.toLowerCase()})`;
  const base = `${label} ${mm(params.Width)} × ${mm(params.Height)}`;
  const variant = kind === 'door'
    ? (params.OperationType && params.OperationType !== DEFAULT_OPERATION ? params.OperationType : undefined)
    : (params.PartitioningType && params.PartitioningType !== 'NOTDEFINED' ? params.PartitioningType : undefined);
  return variant ? `${base} ${variant.toLowerCase().replace(/_/g, ' ')}` : base;
}

/** Type `fillId` (a just-placed IfcDoor or IfcWindow); returns the type's id, or null when the schema has no such type. */
export function typeHostedFillInStore(
  draft: StoreEditor,
  store: IfcDataStore,
  view: MutablePropertyView,
  host: HostAnchor,
  kind: 'door' | 'window',
  fillId: number,
  params: HostedFillTypeParams,
): number | null {
  const typeClass = kind === 'door' ? 'IfcDoorType' : 'IfcWindowType';
  if (params.TypeId !== undefined) {
    if (!liveEntityConforms(store, params.TypeId, typeClass, view)) {
      throw new Error(`TypeId #${params.TypeId} is not a live ${typeClass}`);
    }
  } else if (host.schema === 'IFC2X3') {
    return null;
  }
  const name = hostedFillTypeName(kind, params);
  const predefined = typePredefined(kind, params);
  const typeId = params.TypeId ?? findType(store, view, typeClass, name, predefined) ?? addElementTypeToStore(draft, host, kind === 'door'
    ? { Type: typeClass, Name: name, PredefinedType: predefined,
      ...enumOrUserDefined(params.OperationType ?? DEFAULT_OPERATION, params.UserDefinedOperationType, DOOR_OPERATION_ENUM, 'OperationType') }
    : { Type: typeClass, Name: name, PredefinedType: predefined,
      ...enumOrUserDefined(params.PartitioningType ?? 'NOTDEFINED', params.UserDefinedPartitioningType, WINDOW_PARTITIONING_ENUM, 'PartitioningType') }).typeId;
  assignTypeInStore(draft, host, typeId, [fillId], readRelatedLists(store, 'IfcRelDefinesByType', view));
  return typeId;
}

/**
 * The occurrence's own rule (`doorAttributeTail` / `windowAttributeTail`): a value
 * outside the IFC enumeration is written as USERDEFINED with the value as its
 * user-defined description, so the type matches the door it types.
 */
function enumOrUserDefined<K extends 'OperationType' | 'PartitioningType'>(
  requested: string, userDefined: string | undefined, known: ReadonlySet<string>, key: K,
): Record<K | `UserDefined${K}`, string | undefined> {
  const value = known.has(requested) ? requested : 'USERDEFINED';
  const description = value !== 'USERDEFINED' ? undefined : known.has(requested) ? userDefined : requested;
  return { [key]: value, [`UserDefined${key}`]: description } as Record<K | `UserDefined${K}`, string | undefined>;
}

/** A live type of that name whose PredefinedType is the fill's: a renamed GATE type never types a door. */
function findType(store: IfcDataStore, view: MutablePropertyView, typeClass: string, name: string, predefined: string): number | null {
  const reader = new AnchorEntityReader(store, view);
  for (const id of reader.ids(typeClass.toUpperCase())) {
    const entity = reader.entity(id);
    if (!entity || text(entity.attributes[entity.names.indexOf('Name')]) !== name) continue;
    const kind = entity.attributes[entity.names.indexOf('PredefinedType')];
    if (typeof kind === 'string' && kind.replace(/\./g, '').trim().toUpperCase() === predefined) return id;
  }
  return null;
}

/** A STEP text value as written by either the parser (bare) or an authoring call (quoted). */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'") ? trimmed.slice(1, -1).replace(/''/g, "'") : trimmed;
}
