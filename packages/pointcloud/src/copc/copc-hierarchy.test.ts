/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hierarchy pages are file-supplied references (AGENTS.md "Bounding walks
 * over file-supplied references"). These tests build adversarial page trees
 * in memory: cycles, self-loops, long acyclic chains, fan-out past the
 * budget, and malformed entries. Every walk must terminate, and every bound
 * that fires must surface as an error rather than a truncated hierarchy.
 */

import { describe, expect, it } from 'vitest';
import type { VoxelKey } from './copc-info.js';
import {
  CopcHierarchy,
  copcChildKeys,
  loadPendingCopcPages,
  parseCopcHierarchyPage,
  type CopcHierarchyPage,
  type CopcPageRef,
} from './copc-hierarchy.js';

interface RawEntry {
  key: VoxelKey;
  offset: number;
  byteSize: number;
  pointCount: number;
}

function page(entries: RawEntry[]): Uint8Array {
  const out = new Uint8Array(entries.length * 32);
  const view = new DataView(out.buffer);
  entries.forEach((e, i) => {
    const at = i * 32;
    view.setInt32(at, e.key.d, true);
    view.setInt32(at + 4, e.key.x, true);
    view.setInt32(at + 8, e.key.y, true);
    view.setInt32(at + 12, e.key.z, true);
    view.setUint32(at + 16, e.offset % 0x100000000, true);
    view.setUint32(at + 20, Math.floor(e.offset / 0x100000000), true);
    view.setInt32(at + 24, e.byteSize, true);
    view.setInt32(at + 28, e.pointCount, true);
  });
  return out;
}

const K = (d: number, x = 0, y = 0, z = 0): VoxelKey => ({ d, x, y, z });
const FILE = 1 << 30;

/** An in-memory "file" of pages keyed by offset, read by a counting fetcher. */
function pageStore(pages: Map<number, Uint8Array>) {
  let reads = 0;
  const fetchPage = async (ref: CopcPageRef): Promise<CopcHierarchyPage> => {
    reads++;
    const bytes = pages.get(ref.offset);
    if (!bytes) throw new Error(`no page at ${ref.offset}`);
    return parseCopcHierarchyPage(bytes, FILE);
  };
  return { fetchPage, reads: () => reads };
}

describe('parseCopcHierarchyPage (#6869)', () => {
  it('splits node entries from child-page pointers, keeping 64-bit offsets', () => {
    const big = 2 ** 33 + 96;
    const parsed = parseCopcHierarchyPage(page([
      { key: K(0), offset: 1000, byteSize: 50, pointCount: 10 },
      { key: K(1, 1, 0, 1), offset: big, byteSize: 64, pointCount: -1 },
      { key: K(1, 0, 0, 0), offset: 0, byteSize: 0, pointCount: 0 },
    ]), 2 ** 34);
    expect(parsed.nodes.map((n) => [n.key.d, n.pointCount])).toEqual([[0, 10], [1, 0]]);
    expect(parsed.pages).toEqual([{ key: K(1, 1, 0, 1), offset: big, byteSize: 64 }]);
  });

  it.each([
    ['a page size that is not a multiple of 32', new Uint8Array(33), /multiple of 32/],
    ['a negative level', page([{ key: K(-1), offset: 0, byteSize: 0, pointCount: 0 }]), /level/],
    ['a level past the int32-safe depth', page([{ key: K(31), offset: 0, byteSize: 0, pointCount: 0 }]), /level/],
    ['a cell outside [0, 2^d)', page([{ key: K(2, 4), offset: 0, byteSize: 0, pointCount: 0 }]), /cell/],
    ['a node past the end of the file', page([{ key: K(0), offset: FILE - 10, byteSize: 64, pointCount: 3 }]), /outside/],
    ['a child page with a ragged size', page([{ key: K(1), offset: 64, byteSize: 40, pointCount: -1 }]), /invalid size/],
    ['a point count below -1', page([{ key: K(0), offset: 64, byteSize: 32, pointCount: -2 }]), /invalid point count/],
    ['points with no bytes', page([{ key: K(0), offset: 64, byteSize: 0, pointCount: 5 }]), /bytes/],
    ['an absurd node size', page([{ key: K(0), offset: 64, byteSize: 32, pointCount: 2 ** 30 }]), /limit/],
  ])('rejects %s', (_label, bytes, message) => {
    expect(() => parseCopcHierarchyPage(bytes, FILE)).toThrow(message);
  });
});

describe('loadPendingCopcPages bounds (#6869)', () => {
  it('a child page pointing back at the root terminates after reading each page once', async () => {
    const pages = new Map<number, Uint8Array>([
      [0, page([{ key: K(0), offset: 4096, byteSize: 10, pointCount: 1 }, { key: K(1), offset: 64, byteSize: 64, pointCount: -1 }])],
      [64, page([
        { key: K(1), offset: 4096, byteSize: 10, pointCount: 1 },
        { key: K(0), offset: 0, byteSize: 64, pointCount: -1 }, // cycle to root
        { key: K(1), offset: 64, byteSize: 64, pointCount: -1 }, // self-loop
      ])],
    ]);
    const store = pageStore(pages);
    const h = new CopcHierarchy();
    h.addPage({ offset: 0, byteSize: 64 }, await store.fetchPage({ key: K(0), offset: 0, byteSize: 64 }));
    await loadPendingCopcPages(h, store.fetchPage);
    expect(store.reads()).toBe(2);
    expect(h.nodes.size).toBe(2);
    expect(h.pendingPages.size).toBe(0);
  });

  it('a long acyclic chain of pages walks without recursion and stops at the page budget', async () => {
    const depth = 25;
    const pages = new Map<number, Uint8Array>();
    for (let d = 0; d < depth; d++) {
      const entries: RawEntry[] = [{ key: K(d), offset: 1 << 20, byteSize: 8, pointCount: 1 }];
      if (d + 1 < depth) entries.push({ key: K(d + 1), offset: (d + 1) * 64, byteSize: 64, pointCount: -1 });
      pages.set(d * 64, page(entries));
    }
    const ok = new CopcHierarchy();
    const store = pageStore(pages);
    ok.addPage({ offset: 0, byteSize: 64 }, await store.fetchPage({ key: K(0), offset: 0, byteSize: 64 }));
    await loadPendingCopcPages(ok, store.fetchPage);
    expect(ok.nodes.size).toBe(depth);

    const capped = new CopcHierarchy({ maxPages: 10, maxNodes: 1_000, maxPageBytes: 1 << 20 });
    capped.addPage({ offset: 0, byteSize: 64 }, await store.fetchPage({ key: K(0), offset: 0, byteSize: 64 }));
    await expect(loadPendingCopcPages(capped, store.fetchPage)).rejects.toThrow(/exceeds 10 pages/);
  });

  it('fan-out past the node budget throws instead of returning a truncated tree', async () => {
    const children = copcChildKeys(K(0)).map((key, i) => ({ key, offset: (i + 1) * 4096, byteSize: 32 * 8, pointCount: -1 }));
    const pages = new Map<number, Uint8Array>([[0, page([{ key: K(0), offset: 1 << 20, byteSize: 8, pointCount: 1 }, ...children])]]);
    children.forEach((c) => pages.set(c.offset, page(copcChildKeys(c.key).map((key) => ({ key, offset: 1 << 20, byteSize: 8, pointCount: 1 })))));
    const store = pageStore(pages);
    const h = new CopcHierarchy({ maxPages: 100, maxNodes: 40, maxPageBytes: 1 << 20 });
    h.addPage({ offset: 0, byteSize: 32 * 9 }, await store.fetchPage({ key: K(0), offset: 0, byteSize: 0 }));
    await expect(loadPendingCopcPages(h, store.fetchPage)).rejects.toThrow(/exceeds 40 nodes/);
  });

  it('a node listed twice is an error, not a silent overwrite', async () => {
    const pages = new Map<number, Uint8Array>([
      [0, page([{ key: K(0), offset: 4096, byteSize: 8, pointCount: 1 }, { key: K(1), offset: 64, byteSize: 32, pointCount: -1 }])],
      [64, page([{ key: K(0), offset: 8192, byteSize: 8, pointCount: 2 }])],
    ]);
    const store = pageStore(pages);
    const h = new CopcHierarchy();
    h.addPage({ offset: 0, byteSize: 64 }, await store.fetchPage({ key: K(0), offset: 0, byteSize: 64 }));
    await expect(loadPendingCopcPages(h, store.fetchPage)).rejects.toThrow(/twice/);
  });

  it('maxLevel loads only the pages near the root, leaving deeper ones pending', async () => {
    const pages = new Map<number, Uint8Array>([
      [0, page([{ key: K(0), offset: 4096, byteSize: 8, pointCount: 1 }, { key: K(1), offset: 64, byteSize: 64, pointCount: -1 }])],
      [64, page([{ key: K(1), offset: 4096, byteSize: 8, pointCount: 1 }, { key: K(2), offset: 128, byteSize: 32, pointCount: -1 }])],
      [128, page([{ key: K(2), offset: 4096, byteSize: 8, pointCount: 1 }])],
    ]);
    const store = pageStore(pages);
    const h = new CopcHierarchy();
    h.addPage({ offset: 0, byteSize: 64 }, await store.fetchPage({ key: K(0), offset: 0, byteSize: 64 }));
    await loadPendingCopcPages(h, store.fetchPage, { maxLevel: 1 });
    expect(h.stateOf(K(1))).toBe('node');
    expect(h.stateOf(K(2))).toBe('page');
    expect(h.stateOf(K(3))).toBe('absent');
  });

  it('refuses a page that was never pointed at', async () => {
    const h = new CopcHierarchy();
    h.addPage({ offset: 0, byteSize: 32 }, { nodes: [], pages: [] });
    expect(() => h.addPage({ offset: 512, byteSize: 32, key: K(1) }, { nodes: [], pages: [] })).toThrow(/not a pending/);
  });
});

describe('copcChildKeys', () => {
  it('yields the 8 distinct children one level down, each inside the parent', () => {
    const parent = K(3, 5, 2, 7);
    const kids = copcChildKeys(parent);
    expect(new Set(kids.map((k) => `${k.x},${k.y},${k.z}`)).size).toBe(8);
    for (const k of kids) {
      expect(k.d).toBe(4);
      expect([k.x >> 1, k.y >> 1, k.z >> 1]).toEqual([5, 2, 7]);
    }
  });
});
