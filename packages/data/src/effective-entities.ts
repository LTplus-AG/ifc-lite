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
  /** Optional type fallback for a caller-supplied columnar source domain. */
  readonly entities?: { getTypeName(id: number): string };
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
  const created = overlay?.getNewEntities() ?? [];
  const createdIds = new Set(created.map((entity) => entity.expressId));

  if (sourceIds) {
    for (const expressId of sourceIds) {
      if (expressId === 0 || createdIds.has(expressId) || overlay?.isDeleted(expressId)) continue;
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
      if (expressId === 0 || createdIds.has(expressId) || overlay?.isDeleted(expressId)) continue;
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
