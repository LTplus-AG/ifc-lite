/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { applyRelAggregateStrip } from './merged-rel-aggregates.js';

describe('applyRelAggregateStrip', () => {
  const line = "#10=IFCRELAGGREGATES('guid',#2,$,$,#5,(#6,#7));";

  it('returns the line unchanged when the id has no strip entry', () => {
    expect(applyRelAggregateStrip(line, 10, new Map())).toBe(line);
  });

  it('narrows the RelatedObjects list to the members not stripped', () => {
    const strip = new Map([[10, new Set([6])]]);
    expect(applyRelAggregateStrip(line, 10, strip)).toBe(
      "#10=IFCRELAGGREGATES('guid',#2,$,$,#5,(#7));",
    );
  });

  it('returns null, not the unfiltered line, when the filter would withhold it', () => {
    // Degenerate input: the strip set reaches a single-valued ref (here the
    // RelatingObject, #5, in a self-aggregating line). The filter answers
    // null; passing the original bytes through instead would re-emit the
    // duplicate membership the strip exists to remove.
    const selfLine = "#10=IFCRELAGGREGATES('guid',#2,$,$,#5,(#5,#6));";
    const strip = new Map([[10, new Set([5])]]);
    expect(applyRelAggregateStrip(selfLine, 10, strip)).toBeNull();
  });
});
