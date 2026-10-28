/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The effective entity set of a live model session: the one enumeration
 * algorithm (#5249, charter #5236).
 *
 * A parsed store's `entityIndex` answers for the file as parsed. The mutation
 * overlay (`MutablePropertyView`) never writes back into it: a deleted entity
 * keeps its index entry, and an entity created this session has none. So every
 * bulk enumeration that walks `entityIndex.byType` / `entityIndex.byId` directly
 * returns tombstoned entities and misses created ones, while the point lookups
 * next to it (`isDeleted`, `getNewEntity`) answer correctly. The seed issues of
 * the charter were that one defect in eight consumers, several wrong in only
 * one direction (#5185 missed creates, #5205 kept tombstones, in one function).
 *
 * This generator answers both directions at once:
 *
 *   - every source entity except tombstoned ones;
 *   - every overlay-created entity; created-then-deleted is absent;
 *   - a retyped entity carries, and is filtered by, its new class.
 *
 * It lives here rather than in `@ifc-lite/mutations` because `@ifc-lite/ids`
 * and `@ifc-lite/charts` depend on `@ifc-lite/data` and deliberately not on
 * mutations. `@ifc-lite/mutations`' `iterateEffectiveEntityIds` delegates to
 * it, so there is one algorithm. The overlay is passed in explicitly, never
 * looked up from global state, so a federated session cannot read one model's
 * edits through another's store. {@link EffectiveEntityOverlay} is structural:
 * a live `MutablePropertyView` satisfies it, and so does a structured-clone
 * snapshot (the IDS worker re-parses the source bytes and receives the
 * overlay as plain data).
 *
 * Order: source records in source-bucket order (the type buckets as indexed,
 * or `sourceIds` as given); then source records retyped INTO a requested type
 * they were not indexed under, in the overlay's retype order; then overlay
 * creations in the overlay's creation order.
 *
 * Point lookups stay on their existing mutation-aware paths. This is for
 * enumeration only. `packages/export/src/effective-index.ts` answers the same
 * membership question for STEP output, with byte ranges and reference walks a
 * query consumer does not need.
 */

/** The overlay half of a live session, as enumeration needs it. */
export interface EffectiveEntityOverlay {
  /** True for a deleted source entity and for a created-then-deleted one. */
  isDeleted(expressId: number): boolean;
  /** Overlay-created entities, in creation order, with their authored class. */
  getNewEntities(): ReadonlyArray<{ readonly expressId: number; readonly type: string }>;
  /** Retype intents by express id. Absent means the overlay carries none. */
  getTypeMutations?(): ReadonlyMap<number, { readonly newType: string }>;
  /** Optional indexed tombstones let aggregate counts avoid a full source walk. */
  getTombstones?(): ReadonlySet<number>;
  /** O(1) created-entity lookup. Absent (a plain-data snapshot): membership is built from `getNewEntities`. */
  getNewEntity?(expressId: number): { readonly type: string } | null;
  /**
   * Created entities authored as one class, in creation order. Lets a
   * single-class query skip the other created entities, which is what keeps
   * per-element authoring linear (#5413). Absent: the full list is scanned.
   */
  getNewEntitiesOfType?(type: string): Iterable<{ readonly expressId: number; readonly type: string }>;
}

/**
 * Count effective classes without walking a large source bucket for a small
 * edit set. A caller-supplied source domain is counted through the canonical
 * iterator instead (for example IFCX, whose STEP type index is empty).
 * Source classes with no surviving records retain a zero row.
 */
export function countEffectiveEntityTypes(
  source: EffectiveEntitySource,
  overlay: EffectiveEntityOverlay | null | undefined,
  sourceIds?: Iterable<number>,
): Map<string, number> {
  // @raw-entity-enumeration-ok the canonical aggregate accessor reads parsed bucket sizes, then applies all membership and class deltas below
  const byType = source.entityIndex.byType;
  const counts = new Map<string, number>();
  const tombstones = overlay?.getTombstones?.();
  // An IFCX store's STEP index is empty; the canonical iterator walks its entity table instead (see below).
  const ifc5Table = !sourceIds && byType.size === 0 && source.schemaVersion === 'IFC5' && !!source.entities?.expressId;
  const walk = !!sourceIds || ifc5Table || !!(overlay && !tombstones);
  for (const [type, ids] of byType) counts.set(type, walk ? 0 : ids.length);
  // The same zero rows for an IFCX store's source classes, so a class whose every row is deleted still reads 0.
  if (ifc5Table && source.entities) {
    for (const type of bucketsOf(source.entities).keys()) if (type !== 'UNKNOWN') counts.set(type, 0);
  }
  if (walk) {
    for (const entity of iterateEffectiveEntities(source, overlay, undefined, sourceIds)) {
      counts.set(entity.type, (counts.get(entity.type) ?? 0) + 1);
    }
    return counts;
  }
  if (!overlay) return counts;

  const retypes = overlay.getTypeMutations?.();
  const created = overlay.getNewEntities();
  const createdIds = new Set(created.map((entity) => entity.expressId));
  const changedSourceIds = new Set<number>([...(tombstones ?? []), ...(retypes?.keys() ?? [])]);
  for (const expressId of changedSourceIds) {
    if (createdIds.has(expressId)) continue;
    // @raw-entity-enumeration-ok the canonical aggregate accessor reads the original source class for a sparse deletion or retype delta
    const sourceType = (source.entityIndex.byId.get(expressId)
      ?? source.deferredEntityIndex?.get(expressId))?.type
      ?? source.entities?.getTypeName(expressId);
    if (!sourceType || sourceType === 'Unknown') continue;
    const original = sourceType.toUpperCase();
    if (!counts.has(original)) continue;
    const next = overlay.isDeleted(expressId) ? null : retypes?.get(expressId)?.newType.toUpperCase();
    if (next === original || (!next && !overlay.isDeleted(expressId))) continue;
    counts.set(original, (counts.get(original) ?? 0) - 1);
    if (next) counts.set(next, (counts.get(next) ?? 0) + 1);
  }
  for (const entity of created) {
    if (overlay.isDeleted(entity.expressId)) continue;
    const type = (retypes?.get(entity.expressId)?.newType ?? entity.type).toUpperCase();
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

/**
 * Rows a reader added to, or reclassified in, a source's entity table that the SOURCE FILE does not state: the
 * IFCX reader derives an `IfcWindowType` from a node the file calls `IfcWindow`, and an `IfcMaterial` from a
 * class-less node. Consumers read the table as derived; an exporter must write what the file said, so it takes
 * the original class from `retyped` and writes nothing for `added`.
 */
export interface DerivedEntities {
  /** Express id to the class the source file gives it (the table says something else). */
  readonly retyped: ReadonlyMap<number, string>;
  /** Express ids of table rows with no source node of their own class. */
  readonly added: ReadonlySet<number>;
}

/** The parser's source index shape, without a parser dependency. */
export interface EffectiveEntitySource {
  readonly entityIndex: {
    /** Source ids keyed by UPPERCASE STEP class. */
    readonly byType: ReadonlyMap<string, readonly number[]>;
    readonly byId: { get(id: number): { type: string } | undefined };
  };
  /** Property atoms may live outside the primary ID index after parsing. */
  readonly deferredEntityIndex?: { get(id: number): { type: string } | undefined };
  /**
   * Optional type fallback for a caller-supplied columnar source domain. `expressId` lists the table's
   * rows: with `schemaVersion` 'IFC5' it is also the source domain when the caller supplies none.
   */
  readonly entities?: {
    getTypeName(id: number): string;
    readonly expressId?: Iterable<number> & ArrayLike<number>;
    /** See `EntityTable.typeRevision`: a retype invalidates the class buckets built over this table. */
    readonly typeRevision?: number;
  };
  /** The model's schema. An 'IFC5' (IFCX) store has no STEP type index, so its entity table is the source. */
  readonly schemaVersion?: string;
}

export interface EffectiveEntity {
  expressId: number;
  /** Effective EXPRESS class, in the same uppercase form as STEP type keys. */
  type: string;
  overlayCreated: boolean;
}

/**
 * Iterate the entity set visible in this session. The source index is never
 * mutated. Callers expand schema subtypes before passing `types` (matched
 * case-insensitively against the exact class). `sourceIds` restricts source
 * records to a caller's existing domain (an `EntityTable`'s rows, say) while
 * still appending overlay creations. It avoids scanning unrelated STEP records.
 */
export function* iterateEffectiveEntities(
  source: EffectiveEntitySource,
  overlay: EffectiveEntityOverlay | null | undefined,
  types?: readonly string[],
  sourceIds?: Iterable<number>,
): IterableIterator<EffectiveEntity> {
  // @raw-entity-enumeration-ok the canonical accessor: the one place source type buckets are read, with the overlay applied below
  const byType = source.entityIndex.byType;
  const wanted = types && types.length > 0 ? new Set(types.map((type) => type.toUpperCase())) : null;
  const retypes = overlay?.getTypeMutations?.();
  // Created-entity membership, O(1) per id when the overlay can answer it;
  // a snapshot overlay builds the set once, and only if a pass asks.
  let createdIds: Set<number> | undefined;
  const isCreated = (expressId: number): boolean => {
    if (!overlay) return false;
    if (overlay.getNewEntity) return overlay.getNewEntity(expressId) != null;
    createdIds ??= new Set(overlay.getNewEntities().map((entity) => entity.expressId));
    return createdIds.has(expressId);
  };

  // Snapshot the created entities now, as a copy, so writes made while the
  // caller iterates are not seen (and cannot extend this walk). One requested
  // class and no retype touching a created entity: that class's bucket IS the
  // answer, in the same creation order the full list gives, at O(matches).
  const only = wanted?.size === 1 ? [...wanted][0] : undefined;
  const byClass = only !== undefined && overlay?.getNewEntitiesOfType
    && ![...(retypes?.keys() ?? [])].some(isCreated)
    ? overlay.getNewEntitiesOfType(only)
    : undefined;
  const created = byClass ? Array.from(byClass) : overlay?.getNewEntities() ?? [];

  // An IFCX store has no STEP records, so its `entityIndex` is empty and every walk of the buckets above finds
  // nothing: no space, no material, no wall, whoever asks. The entity table is its source then, and is walked
  // here, once, for every caller, instead of each caller knowing to pass it.
  // The table is walked once per model, into buckets by class; a filtered call takes its buckets, not the table
  // (a per-element loop asking for one class would otherwise rescan the whole table per element). A queued
  // retype can move a row INTO a wanted class, so with retypes the whole table is the domain.
  if (!sourceIds && byType.size === 0 && source.schemaVersion === 'IFC5' && source.entities?.expressId) {
    sourceIds = wanted && !retypes?.size ? idsOfClasses(source.entities, wanted) : source.entities.expressId;
  }

  if (sourceIds) {
    for (const expressId of sourceIds) {
      if (expressId === 0 || isCreated(expressId) || overlay?.isDeleted(expressId)) continue;
      // @raw-entity-enumeration-ok the canonical accessor reads source class before applying queued retypes
      const sourceType = (source.entityIndex.byId.get(expressId)
        ?? source.deferredEntityIndex?.get(expressId))?.type
        ?? source.entities?.getTypeName(expressId);
      if (!sourceType || sourceType === 'Unknown') continue;
      const type = (retypes?.get(expressId)?.newType ?? sourceType).toUpperCase();
      if (!wanted || wanted.has(type)) yield { expressId, type, overlayCreated: false };
    }
  } else {
    const buckets: Iterable<[string, readonly number[]]> = wanted
      ? Array.from(wanted, (type): [string, readonly number[]] => [type, byType.get(type) ?? []])
      : byType;
    for (const [sourceType, ids] of buckets) {
      for (const expressId of ids) {
        if (expressId === 0 || overlay?.isDeleted(expressId)) continue;
        const type = (retypes?.get(expressId)?.newType ?? sourceType).toUpperCase();
        if (!wanted || wanted.has(type)) yield { expressId, type, overlayCreated: false };
      }
    }
  }

  // A source record retyped INTO a requested bucket was absent from that
  // bucket's parsed list. Only queued retypes need this second pass.
  if (!sourceIds && wanted && retypes) {
    for (const [expressId, mutation] of retypes) {
      if (expressId === 0 || isCreated(expressId) || overlay?.isDeleted(expressId)) continue;
      const type = mutation.newType.toUpperCase();
      if (!wanted.has(type)) continue;
      // @raw-entity-enumeration-ok the canonical accessor checks source bucket membership before adding retypes
      const sourceType = (source.entityIndex.byId.get(expressId)
        ?? source.deferredEntityIndex?.get(expressId))?.type.toUpperCase();
      if (!sourceType || wanted.has(sourceType) || !(byType.get(sourceType)?.includes(expressId))) continue;
      yield { expressId, type, overlayCreated: false };
    }
  }

  for (const entity of created) {
    if (overlay?.isDeleted(entity.expressId)) continue;
    const type = (retypes?.get(entity.expressId)?.newType ?? entity.type).toUpperCase();
    if (!wanted || wanted.has(type)) {
      yield { expressId: entity.expressId, type, overlayCreated: true };
    }
  }
}

const BUCKETS = new WeakMap<object, { count: number; revision: number; byClass: Map<string, number[]> }>();

/** The rows of `classes` (upper case) in an entity table, from buckets built once per table and rebuilt if its row count changes. */
function idsOfClasses(
  table: NonNullable<EffectiveEntitySource['entities']>,
  classes: ReadonlySet<string>,
): number[] {
  const byClass = bucketsOf(table);
  const out: number[] = [];
  // A loop, not `push(...bucket)`: spreading a large class bucket can exceed the engine's argument limit.
  for (const key of classes) for (const id of byClass.get(key) ?? []) out.push(id);
  return out;
}

/** An entity table's rows by class (upper case), built once per table and rebuilt if its row count or type revision changes. */
function bucketsOf(table: NonNullable<EffectiveEntitySource['entities']>): Map<string, number[]> {
  const rows = table.expressId ?? [];
  // A retype (`setTypeOverride`) moves a row between classes without changing the row count. A table that can be
  // retyped but reports no revision cannot be cached safely, so its buckets are rebuilt on every call.
  const revision = table.typeRevision;
  const cacheable = revision !== undefined || !('setTypeOverride' in table);
  let held = cacheable ? BUCKETS.get(table) : undefined;
  if (!held || held.count !== rows.length || held.revision !== (revision ?? 0)) {
    held = { count: rows.length, revision: revision ?? 0, byClass: new Map() };
    for (const id of rows) {
      const key = table.getTypeName(id).toUpperCase();
      const list = held.byClass.get(key);
      if (list) list.push(id);
      else held.byClass.set(key, [id]);
    }
    if (cacheable) BUCKETS.set(table, held);
  }
  return held.byClass;
}
