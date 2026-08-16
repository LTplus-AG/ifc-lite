/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `filterResultBySeverity` feeds `exportBcf`/`bcfPreview` (`useClash.ts`). It
 * must rebuild the WHOLE summary, not just `total`: a stale `byTypePair` /
 * `byRule` / `bySeverity` would still advertise buckets the severity filter
 * just removed from `clashes` (the same bug class `applyClashExclusions` in
 * `lib/clash/exclusions.ts` documents and fixes for the exclusions path).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Clash, ClashElementRef, ClashResult } from '@ifc-lite/clash';
import { filterResultBySeverity } from './useClash.js';

function ref(key: string, tag: string): ClashElementRef {
  return { model: 'm1', key, tag, ref: 0 };
}

let seq = 0;
function clash(a: ClashElementRef, b: ClashElementRef, severity: Clash['severity']): Clash {
  seq += 1;
  return {
    id: `c${seq}`,
    a,
    b,
    rule: 'all-clashes',
    status: 'hard',
    distance: -0.05,
    point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    severity,
  };
}

describe('filterResultBySeverity', () => {
  it('drops the excluded-severity buckets from byTypePair/byRule/bySeverity, not just total', () => {
    const beam = ref('GUID_BEAM', 'IfcBeam');
    const slab = ref('GUID_SLAB', 'IfcSlab');
    const pipe = ref('GUID_PIPE', 'IfcPipeSegment');
    const wall = ref('GUID_WALL', 'IfcWall');
    const result: ClashResult = {
      clashes: [clash(beam, slab, 'critical'), clash(pipe, wall, 'info')],
      summary: {
        total: 2,
        byRule: { 'all-clashes': 2 },
        byTypePair: { 'IfcBeam vs IfcSlab': 1, 'IfcPipeSegment vs IfcWall': 1 },
        bySeverity: { critical: 1, major: 0, minor: 0, info: 1 },
      },
      rulesRun: [],
      settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
    };

    const filtered = filterResultBySeverity(result, new Set(['critical']));

    assert.equal(filtered.summary.total, 1);
    // The info-severity pipe/wall clash is gone: its type pair must not still
    // be advertised (a BCF export grouped `byTypePair` would otherwise create
    // a topic for a pair with zero surviving clashes).
    assert.deepEqual(filtered.summary.byTypePair, { 'IfcBeam vs IfcSlab': 1 });
    assert.deepEqual(filtered.summary.bySeverity, { critical: 1, major: 0, minor: 0, info: 0 });
  });
});
