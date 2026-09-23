/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  iterateEffectiveEntities,
  type EffectiveEntity,
  type EffectiveEntitySource,
} from '@ifc-lite/data';
import type { MutablePropertyView } from './mutable-property-view.js';

/** The parser's source index shape, without a parser dependency. */
export interface EntityEnumerationSource extends EffectiveEntitySource {}

export interface EffectiveEntityId extends EffectiveEntity {}

/**
 * Iterate the entity set visible in this session (#5249). Source records are
 * visited in source-bucket order; retyped records entering a requested bucket
 * follow those records, and overlay creations follow both. The source index is
 * never mutated. Callers expand schema subtypes before passing `types`.
 * `sourceIds` restricts source rows to a caller's existing table domain while
 * still appending overlay creations; it avoids scanning unrelated STEP records.
 *
 * The algorithm is `@ifc-lite/data`'s `iterateEffectiveEntities`, shared with
 * consumers that cannot depend on this package (IDS, charts). This entry point
 * keeps the `MutablePropertyView`-typed signature callers already use.
 */
export function iterateEffectiveEntityIds(
  source: EntityEnumerationSource,
  view: MutablePropertyView | null | undefined,
  types?: readonly string[],
  sourceIds?: Iterable<number>,
): IterableIterator<EffectiveEntityId> {
  return iterateEffectiveEntities(source, view, types, sourceIds);
}
