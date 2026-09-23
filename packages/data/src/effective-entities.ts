/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The effective entity set of a live model session (#5249, charter #5236).
 *
 * A parsed store's `entityIndex` answers for the file as parsed. The mutation
 * overlay (`MutablePropertyView`) never writes back into it: a deleted entity
 * keeps its index entry, and an entity created this session has none. So every
 * bulk enumeration that walks `entityIndex.byType` / `entityIndex.byId` directly
 * returns tombstoned entities and misses created ones, while the point lookups
 * next to it (`isDeleted`, `getNewEntity`) answer correctly. Eight seed issues
 * were that one defect in eight consumers, several of them wrong in only one
 * direction (#5185 missed creates, #5205 kept tombstones, in the same function).
 *
 * These two functions are the one rule, answered in both directions at once:
 *
 *   - every source entity except the tombstoned ones;
 *   - every overlay-created entity, exactly once; created-then-deleted is absent;
 *   - a retype moves an entity to its new class for type-filtered enumeration.
 *
 * The overlay is passed in explicitly, never looked up from global state, so a
 * federated session cannot read one model's edits through another's store.
 * {@link EffectiveEntityOverlay} is structural: a live `MutablePropertyView`
 * satisfies it as-is, and so does a structured-clone snapshot of one (the IDS
 * worker re-parses the source bytes and gets the overlay as plain data).
 *
 * Order is deterministic: source ids in the index's own order, followed by the
 * overlay's additions (retyped-in source ids ascending, then created entities
 * in creation order, which is ascending express id).
 *
 * Point lookups stay on their existing mutation-aware paths; this module is for
 * enumeration only. `packages/export/src/effective-index.ts` answers the same
 * membership question for STEP output, with byte ranges and reference walks a
 * query consumer does not need.
 */

/** The overlay half of a live session, as enumeration needs it. */
export interface EffectiveEntityOverlay {
  /**
   * Every id deleted this session: source entities AND created-then-deleted
   * ones. `MutablePropertyView.getTombstones()` returns exactly this.
   */
  getTombstones(): ReadonlySet<number>;
  /**
   * Overlay-created entities still alive, in creation order. `type` is the
   * class as authored (any case); a retype is read from
   * {@link getTypeMutations}, not from here.
   */
  getNewEntities(): ReadonlyArray<{ readonly expressId: number; readonly type: string }>;
  /** Retype intents by express id. Absent means the overlay carries none. */
  getTypeMutations?(): ReadonlyMap<number, { readonly newType: string }>;
}

/** The parsed half: any store carrying the parser's entity index. */
export interface EffectiveEntitySource {
  readonly entityIndex: {
    readonly byId: {
      has(expressId: number): boolean;
      keys(): Iterable<number>;
    };
    /** Source ids keyed by UPPERCASE STEP class. */
    readonly byType: {
      get(upperType: string): ArrayLike<number> | undefined;
    };
  };
}

/**
 * Every entity id in the model's effective state: source ids minus tombstones,
 * then overlay-created ids. With no overlay (or one that has created and
 * deleted nothing) this is exactly the source index's id list.
 *
 * Always returns a fresh array the caller may mutate.
 */
export function effectiveEntityIds(
  store: EffectiveEntitySource,
  overlay: EffectiveEntityOverlay | null | undefined,
): number[] {
  // @raw-entity-enumeration-ok the effective-entity accessor itself: the one place the source id list is read, with the overlay folded in below
  const sourceIds = store.entityIndex.byId;
  if (!overlay) return Array.from(sourceIds.keys());

  const tombstones = overlay.getTombstones();
  const ids: number[] = [];
  if (tombstones.size === 0) {
    for (const id of sourceIds.keys()) ids.push(id);
  } else {
    for (const id of sourceIds.keys()) if (!tombstones.has(id)) ids.push(id);
  }
  appendCreated(store, overlay, tombstones, null, ids);
  return ids;
}

/**
 * Entity ids whose EFFECTIVE class is one of `types`, matched case-insensitively
 * against the exact class name (no subtype expansion: a caller that wants
 * `IfcWall` to include `IfcWallStandardCase` passes both, as it would have with
 * `entityIndex.byType`).
 *
 * A retyped entity is listed under its new class only. Duplicate entries in
 * `types` are ignored, so every id appears at most once.
 */
export function effectiveEntityIdsOfType(
  store: EffectiveEntitySource,
  overlay: EffectiveEntityOverlay | null | undefined,
  types: string | Iterable<string>,
): number[] {
  const wanted = new Set<string>();
  for (const type of typeof types === 'string' ? [types] : types) wanted.add(type.toUpperCase());

  const tombstones: ReadonlySet<number> = overlay ? overlay.getTombstones() : EMPTY_IDS;
  const retypes: ReadonlyMap<number, { readonly newType: string }> =
    overlay?.getTypeMutations?.() ?? EMPTY_RETYPES;
  const filterSource = tombstones.size > 0 || retypes.size > 0;

  const ids: number[] = [];
  for (const type of wanted) {
    // @raw-entity-enumeration-ok the effective-entity accessor itself: source buckets are read here and nowhere else, tombstones and retypes filtered below
    const bucket = store.entityIndex.byType.get(type);
    if (!bucket) continue;
    for (let i = 0; i < bucket.length; i++) {
      const id = bucket[i];
      if (filterSource && (tombstones.has(id) || retypes.has(id))) continue;
      ids.push(id);
    }
  }
  if (!overlay) return ids;

  // Retyped source entities, under their NEW class only. The bucket pass above
  // skipped every retyped id, so this is the single place one is admitted.
  if (retypes.size > 0) {
    const retypedIn: number[] = [];
    for (const [id, retype] of retypes) {
      if (!wanted.has(retype.newType.toUpperCase())) continue;
      if (tombstones.has(id) || !isSourceEntity(store, id)) continue;
      retypedIn.push(id);
    }
    retypedIn.sort((a, b) => a - b);
    for (const id of retypedIn) ids.push(id);
  }
  appendCreated(store, overlay, tombstones, { wanted, retypes }, ids);
  return ids;
}

const EMPTY_IDS: ReadonlySet<number> = new Set<number>();
const EMPTY_RETYPES: ReadonlyMap<number, { readonly newType: string }> = new Map();

function isSourceEntity(store: EffectiveEntitySource, id: number): boolean {
  // @raw-entity-enumeration-ok point membership test inside the effective-entity accessor, used to keep a created or retyped id from being listed twice
  return store.entityIndex.byId.has(id);
}

/**
 * Overlay-created entities, in creation order. A created id is skipped when it
 * is tombstoned (created-then-deleted; `MutablePropertyView.deleteEntity`
 * already forgets it, but a snapshot might not) or when the source index
 * already lists it, so "exactly once" does not depend on the caller's overlay
 * being internally consistent.
 */
function appendCreated(
  store: EffectiveEntitySource,
  overlay: EffectiveEntityOverlay,
  tombstones: ReadonlySet<number>,
  typeFilter: {
    wanted: ReadonlySet<string>;
    retypes: ReadonlyMap<number, { readonly newType: string }>;
  } | null,
  out: number[],
): void {
  for (const entity of overlay.getNewEntities()) {
    const id = entity.expressId;
    if (tombstones.has(id) || isSourceEntity(store, id)) continue;
    if (typeFilter) {
      const effectiveType = typeFilter.retypes.get(id)?.newType ?? entity.type;
      if (!typeFilter.wanted.has(effectiveType.toUpperCase())) continue;
    }
    out.push(id);
  }
}
