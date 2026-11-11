/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The physical-to-analytical link, asked from either end. The read model
 * stores one direction (each structural member and connection names its
 * `physicalElementIds`); this module answers "what are the counterparts of
 * entity X" for a physical element and for a structural item alike. The
 * viewer's properties card asks it here; consistency checks and a CLI command
 * should ask it the same way rather than reading `physicalElementIds`.
 */

import { addUnique } from './structural-step-values.js';
import type { StructuralExtraction } from './structural-types.js';

/** The counterparts of one entity, all on the other side of the link. */
export interface StructuralCounterparts {
  /**
   * `analytical`: the entity is a physical element and these are the
   * structural members and connections assigned to it (members first, then
   * connections, in read-model order). `physical`: the entity is a structural
   * item and these are the elements it idealises, in its `physicalElementIds`
   * order.
   */
  side: 'analytical' | 'physical';
  /** Model-local express ids; never empty, frozen (shared by every lookup). */
  expressIds: readonly number[];
}

const indexes = new WeakMap<StructuralExtraction, Map<number, StructuralCounterparts>>();

/**
 * Counterparts of a model-local express id, or null when the entity has no
 * link. The index over both directions is built once per extraction object,
 * on the first call, so a lookup per selection is a map read.
 */
export function structuralCounterparts(data: StructuralExtraction, expressId: number): StructuralCounterparts | null {
  let index = indexes.get(data);
  if (!index) {
    index = new Map();
    const analytical = new Map<number, number[]>();
    for (const item of [...data.members, ...data.connections]) {
      const physical = item.physicalElementIds;
      if (!physical?.length) continue;
      index.set(item.expressId, { side: 'physical', expressIds: Object.freeze([...physical]) });
      for (const elementId of physical) addUnique(analytical, elementId, item.expressId);
    }
    for (const [elementId, items] of analytical) index.set(elementId, { side: 'analytical', expressIds: Object.freeze(items) });
    indexes.set(data, index);
  }
  return index.get(expressId) ?? null;
}
