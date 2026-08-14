/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared helper functions used across bridge namespace modules.
 */

import type { EntityRef, EntityData } from '@ifc-lite/sdk';

/**
 * Expose entity data under both spellings, symmetrically: `e.Name` and
 * `e.name` are always present and always carry the same value.
 *
 * **PascalCase is the canonical spelling** — it is the EXPRESS attribute name
 * for `GlobalId`, `Name`, `Description` and `ObjectType`, it is what the
 * built-in templates and the assistant's system prompt write, and it is what
 * new scripts should use. (`ref` and `type`/`Type` have no EXPRESS counterpart
 * at all: `Type` is the entity's class name, not an attribute. The
 * `IfcTypeObject` is reached with `bim.query.typeProperties`.)
 *
 * The camelCase half is kept, not deprecated (#2422). Sandbox scripts are
 * user-authored and have no version channel, and the script editor is
 * CodeMirror with syntax highlighting only — no TypeScript service — so a
 * `@deprecated` tag would reach nobody while a removal would break saved
 * scripts silently at runtime. Symmetry is pinned by `bridge-helpers.test.ts`;
 * dropping a spelling here also makes `bim-globals.d.ts` wrong.
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
