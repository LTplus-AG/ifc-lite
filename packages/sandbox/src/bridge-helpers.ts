/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared helper functions used across bridge namespace modules.
 */

import type { EntityRef, EntityData } from '@ifc-lite/sdk';

/**
 * Add PascalCase IFC aliases to entity data for script flexibility.
 * Scripts can use either e.name or e.Name, e.type or e.Type, etc.
 */
export function withAliases(entity: EntityData): Record<string, unknown> {
  return {
    ref: entity.ref,
    globalId: entity.globalId, GlobalId: entity.globalId,
    name: entity.name, Name: entity.name,
    type: entity.type, Type: entity.type,
    description: entity.description, Description: entity.description,
    objectType: entity.objectType, ObjectType: entity.objectType,
  };
}

/**
 * Extract an EntityRef from a dumped entity object.
 * Accepts both { ref: { modelId, expressId } } and { modelId, expressId }.
 */
export function toRef(raw: unknown): EntityRef | null {
  const obj = raw as Record<string, unknown> | null;
  if (!obj) return null;
  if (obj.ref && typeof obj.ref === 'object') {
    const ref = obj.ref as Record<string, unknown>;
    if (typeof ref.modelId === 'string' && typeof ref.expressId === 'number') {
      return ref as unknown as EntityRef;
    }
  }
  if (typeof obj.modelId === 'string' && typeof obj.expressId === 'number') {
    return obj as unknown as EntityRef;
  }
  return null;
}

export function mapNamedProperties(
  properties: Array<{ name: string; value: unknown; type: string | number }>,
): Array<{
  name: string;
  Name: string;
  value: unknown;
  Value: unknown;
  NominalValue: unknown;
  type: string | number;
  Type: string | number;
}> {
  return properties.map((property) => ({
    name: property.name, Name: property.name,
    value: property.value, Value: property.value,
    NominalValue: property.value,
    type: property.type, Type: property.type,
  }));
}
