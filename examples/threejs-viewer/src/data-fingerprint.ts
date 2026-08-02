/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical, order-independent data fingerprinting for the compare demo.
 *
 * **The real implementation lives in `@ifc-lite/diff`** — see
 * `packages/diff/src/fingerprint.ts` in this repo, which exports
 * `buildDataFingerprint`, `buildComponentFingerprints`, `normalizeValue` and
 * `stableHash` with the same semantics and far more prose about why each rule
 * exists. In a real application, import them from the package instead of
 * copying this file:
 *
 * ```ts
 * import { buildDataFingerprint, stableHash } from '@ifc-lite/diff';
 * ```
 *
 * This example keeps a local copy on purpose. Its `@ifc-lite/*` dependencies
 * are ordinary published semver ranges, not workspace links, so that the
 * folder can be copied out of the repo and started with `npm install` — and
 * the published `@ifc-lite/diff` at the time of writing (0.5.0) still carries
 * the two bugs corrected below, so depending on it here would reintroduce
 * exactly what this file exists to demonstrate the fix for. Switch the copy
 * for the import once a release containing the fix is out.
 *
 * TODO(remove-by: the first `@ifc-lite/diff` release that contains the
 * FNV-1a-64 `stableHash`, `{name, type}` type projection and code-unit sorts;
 * owner: the #1891 workstream; tracking: issue #1891). Delete this file and
 * replace `fingerprintEntityData`'s call with the package import above. The
 * condition is checkable: `npm view @ifc-lite/diff version` past 0.5.0 plus a
 * `dist/fingerprint.js` free of `2166136261` and `localeCompare`.
 *
 * The projection below is deliberately byte-identical to the package's, so the
 * hashes this demo prints match the ones `@ifc-lite/diff` produces for the
 * same entity.
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

/**
 * An assigned type, identified **semantically**: its name and its IFC class.
 *
 * The type's own `GlobalId` is deliberately absent. `IfcTypeObject` is an
 * `IfcRoot`, so a from-scratch re-export regenerates the *type's* GlobalId
 * along with every product's. Hashing it moved the data fingerprint of every
 * typed element — walls, doors, windows, most of a real model — on precisely
 * the re-export where nothing substantive changed, which is the comparison
 * this demo is meant to survive.
 */
export interface TypeAssignmentInput {
  name?: string;
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

/** FNV-1a-64 offset basis. */
const FNV_OFFSET_BASIS_64 = 0xcbf2_9ce4_8422_2325n;
/** FNV-1a-64 prime. */
const FNV_PRIME_64 = 0x0000_0100_0000_01b3n;

/**
 * FNV-1a over a string -> 64-bit hex (16 lowercase chars, zero-padded).
 * Stable across runs, machines and browsers.
 *
 * The width is load-bearing. A data fingerprint is compared for *identity*,
 * and 32 bits — what this demo used to use — is narrow enough that collisions
 * between plausible IFC content are findable by enumeration. JS has no
 * unsigned 64-bit integer, so the state is a `BigInt` masked back to 64 bits
 * after every multiply.
 */
export function stableHash(value: string): string {
  let hash = FNV_OFFSET_BASIS_64;
  for (let index = 0; index < value.length; index++) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(value.charCodeAt(index))) * FNV_PRIME_64);
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Order-independent serialization: object keys are sorted, so two semantically
 * equal values with different key insertion order serialize identically (plain
 * `JSON.stringify` preserves key order and would report a spurious change).
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

/** Normalize a property/quantity value to a stable scalar. */
export function normalizeValue(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return stableSerialize(value);
  } catch (error) {
    console.warn('[compare] normalizeValue: non-serializable value, using String() fallback:', error);
    return String(value);
  }
}

/**
 * Locale-independent string ordering: compare UTF-16 code units, never
 * `localeCompare`.
 *
 * `localeCompare` without an explicit locale uses the *runtime's* default, and
 * collations genuinely disagree: under `en-US` the order is `a, A, ae, B`,
 * under `sv-SE` it is `a, A, B, ae` (with `ae` standing for the a-umlaut).
 * Every sort here feeds a `JSON.stringify` that is then hashed, so the same
 * two models compared on two machines would produce different hashes — in a
 * value whose entire purpose is machine-independent identity.
 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Total order: name first, then the record's own serialized content.
 *
 * Sorting on name alone is NOT total. `Array.prototype.sort` is stable, so two
 * records sharing a name keep their INPUT order, and the sorted result is
 * serialized and hashed — putting the adapter's walk order into the hash. Same-
 * named property sets are ordinary IFC (a type pset and an occurrence pset of
 * one name). Mirrors the package fix.
 */
function byNameThenContent<T extends { name: string }>(a: T, b: T): number {
  return compareCodeUnits(a.name, b.name) || compareCodeUnits(stableSerialize(a), stableSerialize(b));
}

function sortedEntries(entries: PropertyEntryInput[]): { name: string; value: string | number | boolean | null }[] {
  return entries
    .map((entry) => ({ name: entry.name, value: normalizeValue(entry.value) }))
    .sort(byNameThenContent);
}

function sortedPropertySets(input: DataFingerprintInput) {
  return (input.propertySets ?? [])
    .map((set) => ({ name: set.name, properties: sortedEntries(set.properties) }))
    .sort(byNameThenContent);
}

function sortedQuantitySets(input: DataFingerprintInput) {
  return (input.quantitySets ?? [])
    .map((set) => ({ name: set.name, quantities: sortedEntries(set.quantities) }))
    .sort(byNameThenContent);
}

/**
 * Assigned types projected to their semantic identity only, then sorted by
 * (class, name). Those two fields are the whole projected record, so a tie on
 * both means the records are identical and their relative order cannot change
 * the serialization — no further tiebreaker is needed.
 */
function sortedTypeAssignments(input: DataFingerprintInput) {
  return (input.typeAssignments ?? [])
    .map((assignment) => ({ name: assignment.name ?? '', type: assignment.type ?? '' }))
    .sort((a, b) => compareCodeUnits(a.type, b.type) || compareCodeUnits(a.name, b.name));
}

/**
 * Build a canonical data fingerprint for one entity. Property sets, quantity
 * sets, their members and the type assignments are all sorted, so collection
 * ordering never produces a spurious "changed".
 */
export function buildDataFingerprint(input: DataFingerprintInput): string {
  return stableHash(
    JSON.stringify({
      Type: input.ifcType,
      Name: input.name ?? '',
      Description: input.description ?? '',
      ObjectType: input.objectType ?? '',
      PredefinedType: input.predefinedType ?? '',
      TypeAssignments: sortedTypeAssignments(input),
      PropertySets: sortedPropertySets(input),
      QuantitySets: sortedQuantitySets(input),
    }),
  );
}
