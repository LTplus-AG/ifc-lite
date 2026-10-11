/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';

type EntityAttributes = ReadonlyArray<{
  name: string;
  value: string | number | boolean;
}>;

/**
 * An entity's predefined type as the IDS 1.0 entity facet reads it.
 *
 * `raw` is the `PredefinedType` enum token (`BEAM`, `USERDEFINED`,
 * `NOTDEFINED`, …) of whichever entity defines it — the type object or
 * the occurrence. `userDefined` is that SAME entity's user-defined name
 * (`ElementType` / `ObjectType` / `ProcessType` / `ResourceType`), and is
 * only ever set when `raw` is `USERDEFINED`.
 */
export interface ResolvedPredefinedType {
  readonly raw: string | undefined;
  readonly userDefined: string | undefined;
}

const NONE: ResolvedPredefinedType = { raw: undefined, userDefined: undefined };

/** The user-defined name slot, in the order the IFC classes declare it. */
const USER_DEFINED_SLOTS = ['ElementType', 'ObjectType', 'ProcessType', 'ResourceType'];

function stringAttr(attrs: EntityAttributes, name: string): string | undefined {
  const value = attrs.find((a) => a.name === name)?.value;
  return typeof value === 'string' && value ? value : undefined;
}

function fromEntity(attrs: EntityAttributes, raw: string): ResolvedPredefinedType {
  if (raw !== 'USERDEFINED') return { raw, userDefined: undefined };
  for (const slot of USER_DEFINED_SLOTS) {
    const name = stringAttr(attrs, slot);
    if (name) return { raw, userDefined: name };
  }
  return { raw, userDefined: undefined };
}

/**
 * Resolve an entity's predefined type by the IDS 1.0 rule (User Manual,
 * entity facet, "The logic for the identification of predefinedType"):
 *
 *  1. If a type object related through `IfcRelDefinesByType` carries a
 *     `PredefinedType` (anything but unset or `NOTDEFINED`), it defines
 *     the predefined type — `USERDEFINED` reads the type's
 *     `ElementType` (or `ProcessType` / `ResourceType`).
 *  2. Otherwise the occurrence's own `PredefinedType` applies —
 *     `USERDEFINED` reads its `ObjectType`.
 *  3. Otherwise the entity has no predefined type.
 *
 * The user-defined name is consulted ONLY for `USERDEFINED`: an
 * occurrence whose `PredefinedType` is unset or `NOTDEFINED` does not
 * acquire one from a stray `ObjectType` (#7394).
 *
 * `attributesOf` is the accessor's (cached, overlay-aware) attribute
 * reader, so a resolution costs no extra re-parse.
 */
export function resolvePredefinedType(
  store: IfcDataStore,
  expressId: number,
  attributesOf: (expressId: number) => EntityAttributes
): ResolvedPredefinedType {
  const typeIds =
    store.relationships?.getRelated?.(
      expressId,
      RelationshipType.DefinesByType,
      'inverse'
    ) || [];
  for (const typeId of typeIds) {
    const typeAttrs = attributesOf(typeId);
    const typeRaw = stringAttr(typeAttrs, 'PredefinedType');
    if (typeRaw && typeRaw !== 'NOTDEFINED') return fromEntity(typeAttrs, typeRaw);
  }

  const attrs = attributesOf(expressId);
  const raw = stringAttr(attrs, 'PredefinedType');
  return raw ? fromEntity(attrs, raw) : NONE;
}
