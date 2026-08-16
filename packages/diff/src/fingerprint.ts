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
  /**
   * The entity's `Tag`, and **only for a type object** (issue #2021).
   *
   * A type object carries no geometry hash, so its data fingerprint is the
   * whole of the evidence a content match has about it. That was not enough on
   * real files: Duplex has eight `IfcFurnitureType` entities all named
   * `'800 mm'`, identical in every other attribute this hashes and separable
   * only by `Tag` (`'157200'`, `'157607'`, …), so they landed in one bucket and
   * the engine correctly abstained on all of them. Hashing `Tag` gives that
   * bucket the discriminator it was missing.
   *
   * **An occurrence's `Tag` must NOT be supplied here, and the shipped adapters
   * do not.** `IfcElement.Tag` is the authoring tool's own element id (Revit
   * writes its ElementId). It is not a property of the design, it is a property
   * of the file's producer — so two tools exporting one design disagree on it
   * for every element, and `dataHash` is the bucket key, which means an
   * occurrence whose `Tag` moved cannot content-match at all. That is exactly
   * the re-export scenario `matchUnpairedByContent` exists for, and an
   * occurrence has a geometry hash to be separated by anyway. The same argument
   * is why the assigned type's `GlobalId` is not hashed; see
   * {@link TypeAssignmentInput.globalId}.
   *
   * The blast radius is contained to the type object itself: type *assignments*
   * project only {@link TypeAssignmentInput.name} and
   * {@link TypeAssignmentInput.type}, so re-tagging a type does not move the
   * fingerprint of a single element assigned to it.
   */
  tag?: string;
  propertySets?: PropertySetInput[];
  quantitySets?: QuantitySetInput[];
  typeAssignments?: TypeAssignmentInput[];
  /**
   * The entity's **resolved material NAMES**. Missing from this projection
   * entirely before, so a re-specified element (measured: `Soil1` ->
   * `topsoil` on an infrastructure pair) read as unchanged in every channel.
   *
   * **Names, never entity references** — an `IfcMaterial`'s express id is
   * reassigned on every save, so comparing references flags every re-exported
   * element. Same argument that keeps {@link TypeAssignmentInput.globalId}
   * out of the hash, and a material is not even an `IfcRoot`, so its id is
   * the only thing a reference comparison could see.
   *
   * **Resolve through every indirection before supplying this**: the usage /
   * set / list wrappers (`IfcMaterialLayerSetUsage`, `IfcMaterialLayerSet`,
   * `IfcMaterialProfileSet`, `IfcMaterialConstituentSet`, `IfcMaterialList`,
   * and their layer/profile/constituent members), down to `IfcMaterial.Name`
   * at the leaf. The shipped viewer adapter does this via
   * `extractAllMaterialsOnDemand` + `lensMaterialNames`; reading only a
   * directly attached `IfcMaterial` silently under-reports on any layered
   * element. Order is irrelevant (sorted here), and an empty array is
   * identical to omitting the field: both say "no material named".
   */
  materials?: string[];
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

/**
 * Total order over already-normalized records: name first, then the record's
 * own serialized content as a tiebreak.
 *
 * The name alone is NOT a total order. `Array.prototype.sort` is stable, so
 * two entries sharing a name keep their INPUT order — and the sorted result is
 * then `JSON.stringify`d and hashed, which makes `dataHash` depend on the order
 * the adapter happened to walk its relationships in. Same content, two orders,
 * two hashes. Same-named property sets are not hypothetical here: type and
 * occurrence psets of one name are a normal IFC arrangement (#1913), and an
 * adapter that supplies them unmerged hands us duplicates.
 *
 * Tiebreaking on the serialized content makes the order total and content-
 * derived, so it cannot depend on input order at all.
 */
function byNameThenContent<T extends { name: string }>(a: T, b: T): number {
  return compareCodeUnits(a.name, b.name) || compareCodeUnits(stableSerialize(a), stableSerialize(b));
}

function sortedEntries(entries: PropertyEntryInput[]): { name: string; value: string | number | boolean | null }[] {
  return entries
    .map((entry) => ({ name: entry.name, value: normalizeValue(entry.value) }))
    .sort(byNameThenContent);
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
 *
 * `Tag` participates, and is supplied for TYPE OBJECTS ONLY — the one place
 * where it is design content rather than the exporter's element id. See
 * {@link DataFingerprintInput.tag} for both halves of that argument.
 */
export function buildDataFingerprint(input: DataFingerprintInput): string {
  const propertySets = sortedPropertySets(input);
  const quantitySets = sortedQuantitySets(input);
  const typeAssignments = sortedTypeAssignments(input);

  const materials = sortedMaterials(input);

  return stableHash(
    JSON.stringify({
      ...coreAttributes(input),
      TypeAssignments: typeAssignments,
      PropertySets: propertySets,
      QuantitySets: quantitySets,
      // Present only when the entity names a material, unlike the three
      // collections above. That is deliberate: an unconditional key would move
      // the fingerprint of every material-LESS entity in every model the moment
      // this field shipped, for a slice they do not carry. Absent and empty
      // therefore hash alike, which is the documented contract of
      // {@link DataFingerprintInput.materials}.
      ...(materials.length > 0 ? { Materials: materials } : {}),
    }),
  );
}

/**
 * Canonical projection of the resolved material names: sorted by code unit,
 * duplicates kept.
 *
 * Sorting is what makes the fingerprint independent of the order an adapter
 * happened to walk an element's `IfcRelAssociatesMaterial` rows in — the same
 * requirement, and the same reason, as the property-set sort. Duplicates
 * survive for the reason `sortedTypeAssignments` keeps its own: cardinality is
 * content when an adapter supplies it — two separate material associations
 * naming one material are not the same statement as one. (The shipped viewer
 * adapter reaches this through `lensMaterialNames`, which de-duplicates
 * *within* one association's resolved set, so only cross-association repeats
 * arrive here from that path; the engine keeps whatever cardinality it is
 * given rather than second-guessing the adapter.) Blank and whitespace-only
 * names are dropped, because a nameless material is not a material a
 * comparison can speak about and different exporters spell "no name"
 * differently (`''`, `' '`).
 */
function sortedMaterials(input: DataFingerprintInput): string[] {
  return (input.materials ?? [])
    .filter((name) => typeof name === 'string' && name.trim().length > 0)
    .sort(compareCodeUnits);
}

/**
 * The direct-attribute slice, in one place because two functions hash it and
 * they are required to hash the SAME thing.
 *
 * {@link buildComponentFingerprints}' `attr:core` is a collision *guard* on
 * {@link buildDataFingerprint}'s hash, which only holds while the two project
 * identically — a sub-hash that saw an attribute `dataHash` does not would veto
 * genuine matches instead of catching collisions. Two literals kept in step by
 * review is how that invariant gets broken; one function is how it cannot be.
 */
function coreAttributes(input: DataFingerprintInput) {
  return {
    Type: input.ifcType,
    Name: input.name ?? '',
    Description: input.description ?? '',
    ObjectType: input.objectType ?? '',
    PredefinedType: input.predefinedType ?? '',
    Tag: input.tag ?? '',
  };
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
 *                        PredefinedType, Tag) + the IFC type itself
 * - `pset:<PsetName>`  — one hash per property set
 * - `qset:<QsetName>`  — one hash per quantity set
 * - `type-assignment`  — assigned type entities, by name + IFC class
 * - `material`         — resolved material names (see
 *                        {@link DataFingerprintInput.materials})
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
 * not worth either. The two functions must project identically — which is why
 * the direct attributes, `Tag` included, come from one {@link coreAttributes}
 * call rather than from two object literals held in step by review.
 */
export function buildComponentFingerprints(
  input: DataFingerprintInput,
): Record<ComponentKey, string> {
  const components: Record<ComponentKey, string> = {};

  components['attr:core'] = stableHash(JSON.stringify(coreAttributes(input)));

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

  const materials = sortedMaterials(input);
  if (materials.length > 0) {
    components['material'] = stableHash(JSON.stringify(materials));
  }

  return components;
}
