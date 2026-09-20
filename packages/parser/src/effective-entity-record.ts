/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcAttributeValue } from '@ifc-lite/data';
import { getAttributeNamesForSchema, normalizeIfcTypeName } from './ifc-schema.js';

/** The pending edits a read model must fold into one entity record. */
export interface EntityRecordEdits {
  /** Class a queued `setEntityType` gives the entity, when present. */
  retype?: string;
  named: Iterable<readonly [string, unknown]>;
  positional: Iterable<readonly [number, IfcAttributeValue | unknown]>;
}

export interface EffectiveEntityRecord {
  /** `IfcWall` spelling of the effective class. */
  type: string;
  attributes: unknown[];
  /** Attribute names of the effective class, positionally aligned with `attributes`. */
  names: string[];
}

/**
 * Re-lay authored attributes out by NAME into the target class's layout, as
 * `retypeArgTokens` does on export: a slot the target class does not share
 * is unset, never the value that happened to sit at the same index. Without
 * a resolvable source layout export keeps the list verbatim (keyword-only
 * swap), and so does this.
 */
export function retypedAttributes(
  sourceType: string,
  attributes: readonly unknown[],
  effectiveType: string,
  targetNames: readonly string[],
  schemaVersion: string | undefined,
): unknown[] {
  if (effectiveType.toUpperCase() === sourceType.toUpperCase()) return [...attributes];
  const sourceNames = getAttributeNamesForSchema(sourceType, schemaVersion);
  if (sourceNames.length === 0) return [...attributes];
  const byName = new Map(sourceNames.map((name, index) => [name, attributes[index]]));
  return targetNames.map((name) => byName.get(name) ?? null);
}

/**
 * One entity record as export will write it: retype first (name-based
 * re-layout), then named edits resolved against the effective class, then
 * positional edits (which win over a named edit to the same slot). Every read
 * surface (CLI, MCP, viewer) must describe a created or edited entity
 * through this, or it disagrees with the saved file (#5009 review).
 */
export function resolveEffectiveEntityRecord(
  entity: { type: string; attributes: readonly unknown[] },
  edits: EntityRecordEdits,
  schemaVersion: string | undefined,
): EffectiveEntityRecord {
  const type = edits.retype ? normalizeIfcTypeName(edits.retype) : entity.type;
  const names = getAttributeNamesForSchema(type, schemaVersion);
  const attributes = names.length > 0
    ? retypedAttributes(entity.type, entity.attributes, type, names, schemaVersion)
    : [...entity.attributes];
  for (const [name, value] of edits.named) {
    const index = names.indexOf(name);
    if (index >= 0) attributes[index] = value;
  }
  for (const [index, value] of edits.positional) attributes[index] = value;
  return { type, attributes, names };
}
