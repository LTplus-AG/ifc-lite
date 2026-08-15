/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { MemoryHistorySidecar, type HistoryEntry, type HistorySidecar } from '../src/branch/history.js';
import { buildBranchTree } from '../src/branch/branch-tree.js';

const ifcx = {
  header: {
    id: 't',
    ifcxVersion: 'ifcx_alpha',
    dataVersion: '1.0.0',
    author: 't',
    timestamp: 'now',
  },
  imports: [],
  schemas: {},
  data: [],
};

describe('branch-tree', () => {
  it('emits anchor + entry nodes with history edges', async () => {
    const s = new MemoryHistorySidecar();
    const e1 = await s.record({ snapshot: ifcx, label: 'first' });
    const e2 = await s.record({ snapshot: ifcx, label: 'second' });
    const tree = await buildBranchTree(s);

    const ids = tree.nodes.map((n) => n.id);
    expect(ids).toContain('branch:main');
    expect(ids).toContain(e1.entryId);
    expect(ids).toContain(e2.entryId);

    const historyEdges = tree.edges.filter((e) => e.kind === 'history');
    expect(historyEdges).toHaveLength(2);
    expect(historyEdges[0].from).toBe('branch:main');
    expect(historyEdges[0].to).toBe(e1.entryId);
  });

  it('emits fork edges for non-main branches', async () => {
    const s = new MemoryHistorySidecar();
    const m1 = await s.record({ snapshot: ifcx });
    await s.branch('exp', m1.entryId);
    const e1 = await s.record({ branch: 'exp', snapshot: ifcx });
    const tree = await buildBranchTree(s);

    const fork = tree.edges.find((e) => e.kind === 'fork');
    expect(fork).toBeDefined();
    expect(fork!.from).toBe(m1.entryId);
    expect(fork!.to).toBe('branch:exp');
    void e1;
  });

  it('marks merge nodes and emits merge edges', async () => {
    const s = new MemoryHistorySidecar();
    const m1 = await s.record({ snapshot: ifcx });
    await s.branch('exp', m1.entryId);
    const eExp = await s.record({ branch: 'exp', snapshot: ifcx });
    const merge = await s.merge('exp', 'main', ifcx);
    const tree = await buildBranchTree(s);

    const mergeNode = tree.nodes.find((n) => n.id === merge.entryId);
    expect(mergeNode?.kind).toBe('merge');
    expect(mergeNode?.mergedFromBranch).toBe('exp');
    const mergeEdge = tree.edges.find(
      (e) => e.kind === 'merge' && e.from === eExp.entryId && e.to === merge.entryId,
    );
    expect(mergeEdge).toBeDefined();
  });

  it('re-sorts same-branch entries by `at` even when the sidecar hands them back out of order', async () => {
    // `MemoryHistorySidecar.record()` always appends in call order, which
    // happens to equal chronological order too (`at: new Date().toISOString()`
    // ticks up on every call) — so a test built by calling `record()`
    // sequentially can never observe whether `buildBranchTree` actually
    // sorts by `at`, only whether it preserves insertion order. That is the
    // "commuting fixture" trap: deleting the `arr.sort(...)` call in
    // branch-tree.ts still passes every `record()`-driven test.
    //
    // This fake sidecar sidesteps `record()` entirely and hands
    // `buildBranchTree` two same-branch entries through `entries()` in
    // REVERSE chronological order (`newer` before `older`) — the interface
    // contract ("oldest first", see `HistorySidecar.entries` doc) says
    // callers should never see this, but `buildBranchTree` must not rely on
    // it: it re-sorts defensively. Only a fixture that is NOT already
    // `at`-sorted can tell the two apart.
    const older: HistoryEntry = {
      entryId: 'older',
      at: '2020-01-01T00:00:01.000Z',
      branch: 'main',
      snapshot: ifcx,
    };
    const newer: HistoryEntry = {
      entryId: 'newer',
      at: '2020-01-01T00:00:02.000Z',
      branch: 'main',
      snapshot: ifcx,
    };
    const fake: HistorySidecar = {
      record: async () => {
        throw new Error('not used by this test');
      },
      entries: async () => [newer, older], // deliberately NOT `at`-sorted
      at: async () => null,
      diff: async () => ({ from: '', to: '', added: [], removed: [], changed: [] }),
      branches: async () => [{ name: 'main', createdAt: '2020-01-01T00:00:00.000Z' }],
      branch: async () => {
        throw new Error('not used by this test');
      },
      merge: async () => {
        throw new Error('not used by this test');
      },
      clear: async () => {},
    };

    const tree = await buildBranchTree(fake);
    const historyEdges = tree.edges.filter((e) => e.kind === 'history');
    expect(historyEdges).toHaveLength(2);
    // Chronological order (older first), NOT the `entries()` return order
    // (which was newer-then-older).
    expect(historyEdges[0].to).toBe(older.entryId);
    expect(historyEdges[0].from).toBe('branch:main');
    expect(historyEdges[1].to).toBe(newer.entryId);
    expect(historyEdges[1].from).toBe(older.entryId);
  });
});
