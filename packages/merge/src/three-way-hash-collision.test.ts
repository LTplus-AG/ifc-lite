/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `snapshotOf` (component-state.ts) hashes a component's canonical JSON with
 * `stableHash` and the three-way merge trusts equality of that hash alone to
 * decide "same edit, fold" (see the decision matrix in three-way.ts: "both
 * changed, equal sub-hash -> fold (auto)"). A real 64-bit FNV-1a collision is
 * not something this test can find by brute force (the birthday bound needs
 * on the order of 2^32 hash computations), so `stableHash` is mocked here to
 * force one deterministically between two component payloads that are
 * genuinely different content ('REI90' vs 'REI120'). This isolates the
 * question the audit cares about: IF stableHash ever collides, does the
 * merge engine notice? Everything else about the merge (the actual
 * three-way decision matrix, the entity/component walk) runs unmocked.
 */

import { describe, expect, it, vi } from 'vitest';
import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';

vi.mock('@ifc-lite/diff', () => ({
  stableHash: (value: string): string => {
    // Force exactly the two payloads this test cares about to collide;
    // everything else still hashes distinctly so the rest of the merge
    // matrix behaves normally.
    if (value.includes('REI90') || value.includes('REI120')) return 'deadbeefdeadbeef';
    let h = 0;
    for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) >>> 0;
    return h.toString(16).padStart(16, '0');
  },
}));

const { planThreeWayMerge } = await import('./three-way.js');

function makeLayer(data: IfcxNode[], id = 'layer'): IfcxFile {
  return {
    header: {
      id,
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: 'test',
      timestamp: '2026-06-09T00:00:00Z',
    },
    imports: [],
    schemas: {},
    data,
  };
}

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';

const base = makeLayer(
  [{ path: 'wall-1', attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' } }],
  'base',
);

describe('three-way merge under a forced stableHash collision', () => {
  it('does not silently fold two genuinely different concurrent edits into one', () => {
    const plan = planThreeWayMerge({
      ancestor: [base],
      ours: [base, makeLayer([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'ours')],
      theirs: [base, makeLayer([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }], 'theirs')],
    });

    // Ours set FireRating to REI90, theirs set it to REI120: a genuine
    // concurrent edit that must surface as a conflict. The mocked
    // stableHash makes their component sub-hashes collide — exactly the
    // "equal sub-hash" condition the fold branch trusts with no fallback.
    // Before the fix: the fold branch fires on the collision, plan.conflicts
    // is empty AND plan.autoOps is empty, so the merge silently keeps
    // "ours" (REI90) and theirs' edit (REI120) vanishes with no trace, no
    // warning, no conflict for a human to resolve.
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.kind).toBe('concurrent-edit');
    expect(plan.conflicts[0]?.ours?.attributes).toEqual({ [FIRE]: 'REI90' });
    expect(plan.conflicts[0]?.theirs?.attributes).toEqual({ [FIRE]: 'REI120' });
    expect(plan.autoOps).toEqual([]);
  });
});
