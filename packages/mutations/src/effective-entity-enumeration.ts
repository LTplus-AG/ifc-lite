/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from './mutable-property-view.js';

/** The parser's source index shape, without a parser dependency. */
export interface EntityEnumerationSource {
  readonly entityIndex: {
    readonly byType: ReadonlyMap<string, readonly number[]>;
    readonly byId: { get(id: number): { type: string } | undefined };
  };
  /** Property atoms may live outside the primary ID index after parsing. */
  readonly deferredEntityIndex?: { get(id: number): { type: string } | undefined };
}

export interface EffectiveEntityId {
  expressId: number;
  /** Effective EXPRESS class, in the same uppercase form as STEP type keys. */
  type: string;
  overlayCreated: boolean;
}

/**
 * Iterate the entity set visible in this session (#5249). Source records are
 * visited in source-bucket order; retyped records entering a requested bucket
 * follow those records, and overlay creations follow both. The source index is
 * never mutated. Callers expand schema subtypes before passing `types`.
 */
export function* iterateEffectiveEntityIds(
  source: EntityEnumerationSource,
  view: MutablePropertyView | null | undefined,
  types?: readonly string[],
): IterableIterator<EffectiveEntityId> {
  const byType = source.entityIndex.byType;
  const wanted = types && types.length > 0 ? new Set(types.map((type) => type.toUpperCase())) : null;
  const retypes = view?.getTypeMutations();
  const created = view?.getNewEntities() ?? [];
  const createdIds = new Set(created.map((entity) => entity.expressId));

  const buckets: Iterable<[string, readonly number[]]> = wanted
    ? Array.from(wanted, (type) => [type, byType.get(type) ?? []])
    : byType;
  for (const [sourceType, ids] of buckets) {
    for (const expressId of ids) {
      if (expressId === 0 || view?.isDeleted(expressId)) continue;
      const type = (retypes?.get(expressId)?.newType ?? sourceType).toUpperCase();
      if (!wanted || wanted.has(type)) yield { expressId, type, overlayCreated: false };
    }
  }

  // A source record retyped INTO a requested bucket was absent from that
  // bucket's parsed list. Only queued retypes need this second pass.
  if (wanted && retypes) {
    for (const [expressId, mutation] of retypes) {
      if (expressId === 0 || createdIds.has(expressId) || view?.isDeleted(expressId)) continue;
      const type = mutation.newType.toUpperCase();
      if (!wanted.has(type)) continue;
      const sourceType = (source.entityIndex.byId.get(expressId)
        ?? source.deferredEntityIndex?.get(expressId))?.type.toUpperCase();
      if (!sourceType || wanted.has(sourceType) || !(byType.get(sourceType)?.includes(expressId))) continue;
      yield { expressId, type, overlayCreated: false };
    }
  }

  for (const entity of created) {
    if (view?.isDeleted(entity.expressId)) continue;
    const type = (retypes?.get(entity.expressId)?.newType ?? entity.type).toUpperCase();
    if (!wanted || wanted.has(type)) {
      yield { expressId: entity.expressId, type, overlayCreated: true };
    }
  }
}
