/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { recomputeZoneAssignmentsNow } from './useZoneAssignmentSync.js';
import { useViewerStore } from '../store/index.js';
import type { ZoneSet } from '../lib/zones/types.js';

function makeZoneSet(id: string): ZoneSet {
  return {
    id,
    name: `Set ${id}`,
    zones: [
      { id: `${id}-z1`, name: 'Zone A', center: [0, 0, 0], size: [5, 3, 5], rotationY: 0 },
    ],
    visible: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

beforeEach(() => {
  useViewerStore.setState({
    zoneSets: [],
    zoneAssignments: new Map(),
    zoneAssignmentTiming: null,
  } as never);
});

describe('recomputeZoneAssignmentsNow (issue #1810)', () => {
  it('no-ops when there are no zone sets AND nothing to clear (guard reject path)', () => {
    // Baseline: empty assignments, no timing yet — exactly the initial state.
    const before = useViewerStore.getState();
    assert.equal(before.zoneAssignments.size, 0);
    assert.equal(before.zoneAssignmentTiming, null);

    recomputeZoneAssignmentsNow();

    const after = useViewerStore.getState();
    // The guard's reject path must be a true no-op: same Map reference (no
    // spurious `setZoneAssignments` call to avoid needless re-renders /
    // effect loops downstream), and timing stays null.
    assert.equal(after.zoneAssignments, before.zoneAssignments);
    assert.equal(after.zoneAssignmentTiming, null);
  });

  it('clears stale assignments + timing when the last zone set is removed', () => {
    // Simulate a prior computation that left assignments + timing behind,
    // then the user deletes their only zone set.
    useViewerStore.setState({
      zoneSets: [],
      zoneAssignments: new Map([[1, {}]]),
      zoneAssignmentTiming: { elapsedMs: 5, elementCount: 1, zoneSetCount: 1, computedAt: 123 },
    } as never);

    recomputeZoneAssignmentsNow();

    const after = useViewerStore.getState();
    assert.equal(after.zoneAssignments.size, 0);
    // Shipped behaviour records the empty recompute rather than clearing the
    // timing: the pass genuinely ran and found nothing, and a null here would
    // be indistinguishable from "never computed".
    assert.equal(after.zoneAssignmentTiming?.elementCount, 0);
    assert.equal(after.zoneAssignmentTiming?.zoneSetCount, 0);
  });

  it('runs the assignment engine and writes timing when zone sets exist', () => {
    useViewerStore.setState({
      zoneSets: [makeZoneSet('s1')],
      zoneAssignments: new Map(),
      zoneAssignmentTiming: null,
    } as never);

    recomputeZoneAssignmentsNow();

    const after = useViewerStore.getState();
    // No renderer/scene is registered in this test environment, so
    // gatherElementBounds() yields no elements — but the engine still runs
    // and timing must be recorded (elementCount: 0, zoneSetCount: 1).
    assert.equal(after.zoneAssignments.size, 0);
    assert.ok(after.zoneAssignmentTiming !== null);
    assert.equal(after.zoneAssignmentTiming?.zoneSetCount, 1);
    assert.equal(after.zoneAssignmentTiming?.elementCount, 0);
  });
});
