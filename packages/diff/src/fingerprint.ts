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
  /**
   * The type entity's `GlobalId`.
   *
   * **Not hashed, and not a stable key.** `IfcTypeObject` is an `IfcRoot`
   * subtype, so a from-scratch re-export regenerates the *type's* GlobalId
   * exactly as it regenerates every product's. Folding it into the fingerprint
   * made the content hash of every typed element — most of a real model —
   * change on a re-export where nothing substantive did, which defeats
   * `matchUnpairedByContent`, the pass that exists for precisely that
   * scenario. The assigned type is identified by {@link name} +
   * {@link type} instead; see {@link buildDataFingerprint}.
   *
   * The field is kept because callers already populate it and it is useful for
   * display and for resolving the type entity, but it does not participate in
   * any hash this module produces.
   */
  globalId?: string;
  /** Name of the assigned type (e.g. `WT-200`). Part of its hashed identity. */
  name?: string;
  /** IFC type name of the assigned type (e.g. `IfcWallType`). Part of its hashed identity. */
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

/** FNV-1a-64 offset basis. Same constant as `rust/processing/src/determinism.rs`;
 *  see `stableHash` for why that does NOT make the two outputs comparable. */
const FNV_OFFSET_BASIS_64 = 0xcbf2_9ce4_8422_2325n;
/** FNV-1a-64 prime. Same constant as `rust/processing/src/determinism.rs`. */
const FNV_PRIME_64 = 0x0000_0100_0000_01b3n;

/**
 * FNV-1a over a string → 64-bit hex (16 lowercase chars, zero-padded).
 * Stable across runs and platforms.
 *
 * **The width is load-bearing, not decoration.** This hash is not only a
 * drift detector: `diffModels(..., { matchUnpairedByContent: true })` treats
 * equality of the derived `dataHash` as *identity* — the 1:1 branch retires a
 * real `added` and a real `deleted` entry in favour of one match record. That
 * is an all-pairs birthday problem whose exposure grows with the square of the
 * number of distinct fingerprints compared, and a from-scratch re-export
 * leaves the whole model unpaired, which is the worst case. The previous
 * 32-bit width was demonstrably too narrow for that: collisions between
 * plausible IFC content were findable by enumeration (issue #1962).
 *
 * 64-bit FNV-1a is much stronger but still not a cryptographic hash — it is
 * chosen for non-adversarial drift-catching and content matching, not for
 * verifier-facing claims. The guards in `diff.ts` (bucket by `ifcType`,
 * require `components` agreement) stay: they are what makes a residual
 * collision non-destructive, and they are unaffected by the width.
 *
 * JS has no unsigned 64-bit integer type, so the state is a `BigInt` masked
 * back to 64 bits after every multiply. Characters are fed in as UTF-16 code
 * units (`charCodeAt`), the same construction as before — the Rust twin hashes
 * bytes, so the two agree on constants and mixing, not on output for a given
 * string, and neither is compared against the other.
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

/**
 * Locale-independent string ordering: compare UTF-16 code units, never
 * `localeCompare`.
 *
 * `localeCompare` without an explicit locale uses the RUNTIME's default, and
 * collations genuinely disagree: under `en-US` the order is `a, A, ae, B`,
 * under `sv-SE` it is `a, A, B, ae` (with `ae` standing for the a-umlaut).
 * Every sort here feeds a `JSON.stringify` that is then hashed, so a locale
 * difference between the machine that fingerprinted the base and the one that
 * fingerprinted the head would move `dataHash` for identical content - in a
 * hash whose whole purpose is cross-machine identity. Code-unit order is
 * total, deterministic and identical everywhere.
 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedEntries(entries: PropertyEntryInput[]): { name: string; value: string | number | boolean | null }[] {
  return entries
    .map((entry) => ({ name: entry.name, value: normalizeValue(entry.value) }))
    .sort((a, b) => compareCodeUnits(a.name, b.name));
}

/**
 * Build a canonical data fingerprint for one entity. Property sets, quantity
 * sets, their members, and type assignments are all sorted, so collection
 * ordering never produces a spurious "modified".
 *
 * **Assigned types are identified semantically — by name and IFC class, never
 * by GlobalId.** A `GlobalId` is only stable while the file is edited in
 * place; a from-scratch re-export regenerates every `IfcRoot`'s, and
 * `IfcTypeObject` is an `IfcRoot`. Hashing the type's GlobalId therefore
 * changed the fingerprint of every *typed* element — walls, doors, windows,
 * most of a real model — on exactly the re-export where nothing substantive
 * changed, and `matchUnpairedByContent` buckets on `dataHash`, so those
 * elements could never content-match. Name + class is the part of a type
 * assignment that survives a re-GUID, and is what the equivalent IfcOpenShell
 * comparison keys on.
 *
 * The cost is a real, accepted loss of discrimination: two *different* type
 * entities that share a name and a class are now indistinguishable here, so
 * re-pointing an element from one to the other does not move its `dataHash`.
 * That trade is lopsided in favour of the semantic key. The loss needs
 * duplicate type names within one class, which is a modelling defect and
 * indistinguishable to a human reader of the model anyway; and it only
 * surfaces on elements that are otherwise byte-identical in every attribute,
 * property and quantity. The bug it replaces fired on every typed element of
 * every re-exported model.
 */
export function buildDataFingerprint(input: DataFingerprintInput): string {
  const propertySets = sortedPropertySets(input);
  const quantitySets = sortedQuantitySets(input);
  const typeAssignments = sortedTypeAssignments(input);

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

function sortedPropertySets(input: DataFingerprintInput) {
  return (input.propertySets ?? [])
    .map((set) => ({ name: set.name, properties: sortedEntries(set.properties) }))
    .sort((a, b) => compareCodeUnits(a.name, b.name));
}

function sortedQuantitySets(input: DataFingerprintInput) {
  return (input.quantitySets ?? [])
    .map((set) => ({ name: set.name, quantities: sortedEntries(set.quantities) }))
    .sort((a, b) => compareCodeUnits(a.name, b.name));
}

/**
 * Canonical projection of the assigned types: **semantic identity only** —
 * the type's name and its IFC class. {@link TypeAssignmentInput.globalId} is
 * deliberately dropped here, which is what makes a re-exported model's typed
 * elements hash identically; see {@link buildDataFingerprint}.
 *
 * Sorted by (class, name). Those two fields are the whole projected object, so
 * two assignments that tie on both are *identical* records and their relative
 * order cannot affect the serialization — the sort is total on the output even
 * though it is not total on the input, and no `globalId` tiebreaker is needed
 * to keep it deterministic.
 *
 * Duplicates are kept rather than collapsed. Cardinality is content: an
 * occurrence bound to two type entities is not the same as one bound to a
 * single type, and IFC allows an occurrence at most one `IfcRelDefinesByType`,
 * so two assignments are an anomaly a diff should surface rather than
 * normalize away. This also matches `propertySets`/`quantitySets`, which are
 * likewise sorted but never deduped, and it preserves the previous behaviour
 * for repeated relationship rows, which did not dedupe either.
 */
function sortedTypeAssignments(input: DataFingerprintInput) {
  return (input.typeAssignments ?? [])
    .map((assignment) => ({
      name: assignment.name ?? '',
      type: assignment.type ?? '',
    }))
    .sort((a, b) => compareCodeUnits(a.type, b.type) || compareCodeUnits(a.name, b.name));
}

/**
 * Per-component fingerprint keys. Aligned with the layer op model
 * (docs/architecture/layer-prs/02-layer-format.md §2.2) so diff keys and
 * op keys share one vocabulary:
 *
 * - `attr:core`        — direct attributes (Name, Description, ObjectType,
 *                        PredefinedType) + the IFC type itself
 * - `pset:<PsetName>`  — one hash per property set
 * - `qset:<QsetName>`  — one hash per quantity set
 * - `type-assignment`  — assigned type entities, by name + IFC class
 */
export type ComponentKey = string;

/**
 * Opt-in per-componentKey sub-hash mode (the whole-blob
 * {@link buildDataFingerprint} stays the default). Sub-hashes make the
 * conflict unit (entity, componentKey): an architect editing placement and
 * an agent editing `Pset_FireSafety` on the same wall is not a conflict.
 *
 * Only components the entity actually carries get a key: a missing pset
 * has no entry rather than an "empty" hash, so add/remove of a component
 * is visible as key presence.
 *
 * **Every sub-hash is computed over the same canonical projection
 * {@link buildDataFingerprint} hashes — including the GlobalId-free type
 * assignment.** That is a requirement, not a convenience. `diffModels`'
 * content pass uses these sub-hashes as a *collision guard*: it retires an
 * `added`/`deleted` pair only once they agree, on the stated grounds that a
 * component hashes a slice of the content `dataHash` hashes whole, so a
 * disagreement under an equal `dataHash` proves a collision. Feeding the
 * type's `GlobalId` into `type-assignment` while `dataHash` ignores it would
 * break that: a genuine re-export match would have an equal `dataHash` and a
 * differing `type-assignment`, and the guard would veto the very match the
 * GlobalId was removed to enable — turning a collision guard into a
 * re-export filter. It would also make the key-based pass self-contradictory,
 * reporting an entity as `unchanged` while listing `type-assignment` in its
 * `changedComponents`. The extra discrimination a GlobalId would buy here is
 * not worth either. The two functions must project identically.
 */
export function buildComponentFingerprints(
  input: DataFingerprintInput,
): Record<ComponentKey, string> {
  const components: Record<ComponentKey, string> = {};

  components['attr:core'] = stableHash(
    JSON.stringify({
      Type: input.ifcType,
      Name: input.name ?? '',
      Description: input.description ?? '',
      ObjectType: input.objectType ?? '',
      PredefinedType: input.predefinedType ?? '',
    }),
  );

  for (const set of sortedPropertySets(input)) {
    components[`pset:${set.name}`] = stableHash(JSON.stringify(set.properties));
  }
  for (const set of sortedQuantitySets(input)) {
    components[`qset:${set.name}`] = stableHash(JSON.stringify(set.quantities));
  }

  const typeAssignments = sortedTypeAssignments(input);
  if (typeAssignments.length > 0) {
    components['type-assignment'] = stableHash(JSON.stringify(typeAssignments));
  }

  return components;
}
