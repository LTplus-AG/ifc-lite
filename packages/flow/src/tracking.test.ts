/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { isValidIfcGuid } from '@ifc-lite/encoding';
import { digest, trackingGuid } from './digest.js';
import { emptyTrackedSet, planTracking, trackedSetFrom, TrackingPinMismatch, withTrackedSet } from './tracking.js';

describe('trackingGuid', () => {
  it('is a valid IFC GUID, deterministic, and independent of anything session-scoped', () => {
    const a = trackingGuid('office/columns', 'A|L1');
    expect(isValidIfcGuid(a)).toBe(true);
    expect(trackingGuid('office/columns', 'A|L1')).toBe(a);
    expect(trackingGuid('office/columns', 'A|L2')).not.toBe(a);
    expect(trackingGuid('office/beams', 'A|L1')).not.toBe(a);
  });
});

describe('planTracking', () => {
  const lanes = (...keys: string[]) => keys.map((laneKey) => ({ laneKey, digest: digest({ laneKey, v: 1 }) }));

  it('first run creates every lane under its tracking GUID', () => {
    const plan = planTracking(emptyTrackedSet('g/cols'), lanes('A|L1', 'B|L1'), 'update');
    expect(plan.create.map((c) => c.laneKey)).toEqual(['A|L1', 'B|L1']);
    expect(plan.create[0].globalId).toBe(trackingGuid('g/cols', 'A|L1'));
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(Object.keys(plan.next.entries)).toEqual(['A|L1', 'B|L1']);
  });

  it('re-run with the same inputs keeps everything; a changed lane updates under the same GUID', () => {
    const first = planTracking(emptyTrackedSet('g/cols'), lanes('A|L1', 'B|L1'), 'update');
    const same = planTracking(first.next, lanes('A|L1', 'B|L1'), 'update');
    expect(same.keep).toHaveLength(2);
    expect(same.create).toEqual([]);

    const changed = planTracking(first.next, [{ laneKey: 'A|L1', digest: 'different' }, lanes('B|L1')[0]], 'update');
    expect(changed.update).toEqual([{ laneKey: 'A|L1', globalId: first.next.entries['A|L1'].globalId }]);
    expect(changed.keep.map((k) => k.laneKey)).toEqual(['B|L1']);
  });

  it('a vanished lane is removed — the orphan Dynamo leaves behind', () => {
    const first = planTracking(emptyTrackedSet('g/cols'), lanes('A|L1', 'B|L1', 'C|L1'), 'update');
    const after = planTracking(first.next, lanes('A|L1', 'C|L1'), 'update');
    expect(after.remove).toEqual([{ laneKey: 'B|L1', globalId: first.next.entries['B|L1'].globalId }]);
    expect(Object.keys(after.next.entries)).toEqual(['A|L1', 'C|L1']);
  });

  it('replace removes the previous set and creates fresh, deterministic GUIDs', () => {
    const first = planTracking(emptyTrackedSet('g/cols'), lanes('A|L1'), 'update');
    const replaced = planTracking(first.next, lanes('A|L1'), 'replace');
    expect(replaced.remove.map((r) => r.globalId)).toEqual([first.next.entries['A|L1'].globalId]);
    expect(replaced.create[0].globalId).not.toBe(first.next.entries['A|L1'].globalId);
    expect(replaced.next.generation).toBe(1);
    const again = planTracking(first.next, lanes('A|L1'), 'replace');
    expect(again.create[0].globalId).toBe(replaced.create[0].globalId);
  });

  it('disabled plans nothing and leaves the set untouched', () => {
    const first = planTracking(emptyTrackedSet('g/cols'), lanes('A|L1'), 'update');
    const off = planTracking(first.next, lanes('Z'), 'disabled');
    expect(off.create).toEqual([]);
    expect(off.remove).toEqual([]);
    expect(off.next).toBe(first.next);
  });

  it('a duplicated lane key is tracked once and reported', () => {
    const plan = planTracking(emptyTrackedSet('g'), lanes('A', 'A'), 'update');
    expect(plan.create).toHaveLength(1);
    expect(plan.duplicateLanes).toEqual(['A']);
  });
});

describe('tracking sidecar', () => {
  it('refuses a sidecar pinned to another model state instead of adopting it', () => {
    const set = planTracking(emptyTrackedSet('g/cols'), [{ laneKey: 'A', digest: 'd' }], 'update').next;
    const sidecar = withTrackedSet(undefined, 'stack:abc', set);
    expect(trackedSetFrom(sidecar, 'stack:abc', 'g/cols')).toEqual(set);
    expect(trackedSetFrom(sidecar, 'stack:abc', 'other')).toEqual(emptyTrackedSet('other'));
    expect(() => trackedSetFrom(sidecar, 'stack:def', 'g/cols')).toThrow(TrackingPinMismatch);
  });

  it('re-pinning drops sets that belonged to the old state', () => {
    const set = emptyTrackedSet('g/cols');
    const old = withTrackedSet(undefined, 'stack:abc', set);
    const repinned = withTrackedSet(old, 'stack:def', emptyTrackedSet('g/beams'));
    expect(Object.keys(repinned.sets)).toEqual(['g/beams']);
  });
});
