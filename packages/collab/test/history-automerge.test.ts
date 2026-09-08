/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomergeHistorySidecar } from '../src/branch/history-automerge.js';

const ifcx = (id: string, data: Array<{ path: string }> = []) => ({
  header: {
    id,
    ifcxVersion: 'ifcx_alpha',
    dataVersion: '1.0.0',
    author: 't',
    timestamp: new Date().toISOString(),
  },
  imports: [],
  schemas: {},
  data,
});

describe('AutomergeHistorySidecar', () => {
  it('records and lists entries', async () => {
    const sidecar = new AutomergeHistorySidecar();
    const a = await sidecar.record({ snapshot: ifcx('A'), label: 'first' });
    const b = await sidecar.record({ snapshot: ifcx('B'), label: 'second' });
    const list = await sidecar.entries();
    expect(list.map((e) => e.entryId)).toEqual([a.entryId, b.entryId]);
  });

  it('save / load round-trips through binary encoding', async () => {
    const sidecar = new AutomergeHistorySidecar();
    await sidecar.record({ snapshot: ifcx('A', [{ path: 'wall' }]) });
    const bytes = sidecar.save();
    expect(bytes.byteLength).toBeGreaterThan(0);

    const restored = new AutomergeHistorySidecar({ serialised: bytes });
    const list = await restored.entries();
    expect(list).toHaveLength(1);
    expect(list[0].snapshot.data[0]?.path).toBe('wall');
  });

  it('diff reports added / removed / changed', async () => {
    const sidecar = new AutomergeHistorySidecar();
    const a = await sidecar.record({
      snapshot: ifcx('A', [{ path: 'wall' }, { path: 'door' }]),
    });
    const b = await sidecar.record({
      snapshot: ifcx('B', [
        { path: 'wall' /* changed below by adding attrs */ },
        { path: 'window' },
      ]),
    });
    // Mutate the second snapshot's wall so diff reports it.
    const updated = ifcx('B', [
      { path: 'wall', attributes: { Name: 'Q' } } as never,
      { path: 'window' },
    ]);
    const c = await sidecar.record({ snapshot: updated });
    void b;

    const diff = await sidecar.diff(a.entryId, c.entryId);
    expect(diff.added).toEqual(['window']);
    expect(diff.removed).toEqual(['door']);
    expect(diff.changed).toEqual(['wall']);
  });

  it('branches and merges', async () => {
    const sidecar = new AutomergeHistorySidecar();
    const main = await sidecar.record({ snapshot: ifcx('M') });
    const exp = await sidecar.branch('experiment', main.entryId);
    expect(exp.forkedFromEntryId).toBe(main.entryId);
    await sidecar.record({ branch: 'experiment', snapshot: ifcx('E') });
    const merge = await sidecar.merge('experiment', 'main', ifcx('M2'));
    expect(merge.label).toContain('merge experiment → main');
    const branches = (await sidecar.branches()).map((b) => b.name).sort();
    expect(branches).toEqual(['experiment', 'main']);
  });

  describe('entries() ordering', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('sorts unfiltered entries() by `at`, not by record()/insertion order', async () => {
      // `records and lists entries` above always calls record() in
      // chronological order, so `at` order and insertion/call order are
      // identical there — deleting the `.sort(...)` in `entries()` still
      // passes it. That is a commuting fixture: it can't distinguish "sorted
      // by at" from "returned in whatever order Object.values() happens to
      // walk the entries map".
      //
      // Here we force the two orders to DIVERGE: record the
      // chronologically-LATER entry first (so it is inserted into the
      // underlying Automerge map first), then wind the clock backwards and
      // record the chronologically-EARLIER entry second. Insertion order is
      // [later, earlier]; `at` order must be [earlier, later]. Only a real
      // sort recovers the latter.
      const sidecar = new AutomergeHistorySidecar();
      vi.setSystemTime(new Date('2024-01-02T00:00:00.000Z'));
      const later = await sidecar.record({ snapshot: ifcx('later') });
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
      const earlier = await sidecar.record({ snapshot: ifcx('earlier') });

      // Sanity-check the fixture itself is NOT already `at`-sorted, i.e. it
      // actually exercises the sort rather than commuting around it.
      expect(later.at > earlier.at).toBe(true);

      const list = await sidecar.entries();
      expect(list.map((e) => e.entryId)).toEqual([earlier.entryId, later.entryId]);
    });
  });
});
