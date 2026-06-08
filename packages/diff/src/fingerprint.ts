/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical, order-independent data fingerprinting for model diffing.
 *
 * Lifted from the Three.js compare example into a shared, store-agnostic form:
 * callers extract a plain {@link DataFingerprintInput} from whatever store they
 * have and hash it here, so the base and head adapters (CLI, viewer) produce
 * byte-identical fingerprints for an unchanged entity.
 */

export interface PropertyEntryInput {
  name: string;
  value: unknown;
}

export interface PropertySetInput {
  name: string;
  properties: PropertyEntryInput[];
}

export interface QuantitySetInput {
  name: string;
  quantities: PropertyEntryInput[];
}

export interface TypeAssignmentInput {
  /** The type entity's `GlobalId` (preferred stable key). */
  globalId?: string;
  name?: string;
  /** IFC type name of the assigned type (e.g. `IfcWallType`). */
  type?: string;
}

export interface DataFingerprintInput {
  ifcType: string;
  name?: string;
  description?: string;
  objectType?: string;
  predefinedType?: string;
  propertySets?: PropertySetInput[];
  quantitySets?: QuantitySetInput[];
  typeAssignments?: TypeAssignmentInput[];
}

/** FNV-1a over a string → 32-bit hex. Stable across runs and platforms. */
export function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Order-independent serialization: object keys are sorted, so two semantically
 * equal values with different key insertion order serialize identically (plain
 * `JSON.stringify` preserves key order and would produce a spurious "modified").
 */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

/**
 * Normalize a property/quantity value to a stable scalar so that structurally
 * equal values hash identically regardless of object identity or key order.
 */
export function normalizeValue(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return stableSerialize(value);
  } catch (error) {
    // Circular or otherwise non-serializable — fall back to a string form so
    // hashing never throws (an unstable-but-present token beats a crash).
    console.warn('[diff] normalizeValue: non-serializable value, using String() fallback:', error);
    return String(value);
  }
}

function sortedEntries(entries: PropertyEntryInput[]): { name: string; value: string | number | boolean | null }[] {
  return entries
    .map((entry) => ({ name: entry.name, value: normalizeValue(entry.value) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build a canonical data fingerprint for one entity. Property sets, quantity
 * sets, their members, and type assignments are all sorted, so collection
 * ordering never produces a spurious "modified".
 */
export function buildDataFingerprint(input: DataFingerprintInput): string {
  const propertySets = (input.propertySets ?? [])
    .map((set) => ({ name: set.name, properties: sortedEntries(set.properties) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const quantitySets = (input.quantitySets ?? [])
    .map((set) => ({ name: set.name, quantities: sortedEntries(set.quantities) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const typeAssignments = (input.typeAssignments ?? [])
    .map((assignment) => ({
      globalId: assignment.globalId ?? '',
      name: assignment.name ?? '',
      type: assignment.type ?? '',
    }))
    .sort(
      (a, b) =>
        a.type.localeCompare(b.type) ||
        a.name.localeCompare(b.name) ||
        a.globalId.localeCompare(b.globalId),
    );

  return stableHash(
    JSON.stringify({
      Type: input.ifcType,
      Name: input.name ?? '',
      Description: input.description ?? '',
      ObjectType: input.objectType ?? '',
      PredefinedType: input.predefinedType ?? '',
      TypeAssignments: typeAssignments,
      PropertySets: propertySets,
      QuantitySets: quantitySets,
    }),
  );
}
