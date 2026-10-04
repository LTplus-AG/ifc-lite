/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * COPC hierarchy pages (#6869).
 *
 * A page is a packed array of 32-byte entries:
 *   VoxelKey (int32 level, x, y, z) | uint64 offset | int32 byteSize | int32 pointCount
 * `pointCount >= 0` describes a node whose LAZ chunk sits at `offset`;
 * `pointCount === -1` points at a CHILD PAGE of `byteSize` bytes at `offset`.
 *
 * The page tree comes from the file, so its shape is attacker-controlled.
 * Following AGENTS.md "Bounding walks over file-supplied references", the
 * walk is ITERATIVE (no stack to overflow), keeps a global visited set of
 * page offsets (a page is a pure function of its offset, so memoising is
 * safe and kills cycles and fan-out), and carries work budgets for pages,
 * nodes and page bytes. Exceeding a budget THROWS: a truncated hierarchy
 * would render as silently missing geometry.
 */

import { voxelKeyId, type VoxelKey } from './copc-info.js';

const ENTRY_SIZE = 32;
/** Deepest level accepted: keeps `2^d` cell indices inside int32. */
export const MAX_COPC_LEVEL = 30;
/** Largest single node accepted (points). Real writers stay far below. */
export const MAX_COPC_NODE_POINTS = 1 << 24;

export interface CopcNodeEntry {
  key: VoxelKey;
  /** Absolute file offset of the node's LAZ chunk. */
  offset: number;
  byteSize: number;
  pointCount: number;
}

export interface CopcPageRef {
  /** Root of the subtree the page describes. */
  key: VoxelKey;
  offset: number;
  byteSize: number;
}

export interface CopcHierarchyPage {
  nodes: CopcNodeEntry[];
  pages: CopcPageRef[];
}

export interface CopcHierarchyLimits {
  maxPages: number;
  maxNodes: number;
  maxPageBytes: number;
}

export const DEFAULT_COPC_HIERARCHY_LIMITS: CopcHierarchyLimits = {
  maxPages: 1 << 16,
  maxNodes: 1 << 21,
  maxPageBytes: (1 << 21) * ENTRY_SIZE,
};

function checkSpan(what: string, offset: number, size: number, fileSize: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > fileSize) {
    throw new Error(`COPC: ${what} [${offset}, +${size}) lies outside the ${fileSize}-byte file`);
  }
}

/** Parse and validate one page. Every entry is checked against the file size. */
export function parseCopcHierarchyPage(bytes: Uint8Array, fileSize: number): CopcHierarchyPage {
  if (bytes.length % ENTRY_SIZE !== 0) {
    throw new Error(`COPC: hierarchy page of ${bytes.length} bytes is not a multiple of ${ENTRY_SIZE}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const page: CopcHierarchyPage = { nodes: [], pages: [] };
  for (let at = 0; at < bytes.length; at += ENTRY_SIZE) {
    const key: VoxelKey = {
      d: view.getInt32(at, true),
      x: view.getInt32(at + 4, true),
      y: view.getInt32(at + 8, true),
      z: view.getInt32(at + 12, true),
    };
    const offset = view.getUint32(at + 16, true) + view.getUint32(at + 20, true) * 0x100000000;
    const byteSize = view.getInt32(at + 24, true);
    const pointCount = view.getInt32(at + 28, true);
    if (key.d < 0 || key.d > MAX_COPC_LEVEL) throw new Error(`COPC: hierarchy key level ${key.d} out of range`);
    const cells = 2 ** key.d;
    for (const c of [key.x, key.y, key.z]) {
      if (c < 0 || c >= cells) throw new Error(`COPC: hierarchy key ${voxelKeyId(key)} has a cell outside [0, ${cells})`);
    }
    if (pointCount === -1) {
      if (byteSize <= 0 || byteSize % ENTRY_SIZE !== 0) {
        throw new Error(`COPC: child page ${voxelKeyId(key)} has invalid size ${byteSize}`);
      }
      checkSpan(`child page ${voxelKeyId(key)}`, offset, byteSize, fileSize);
      page.pages.push({ key, offset, byteSize });
    } else if (pointCount === 0) {
      page.nodes.push({ key, offset: 0, byteSize: 0, pointCount: 0 });
    } else if (pointCount > 0) {
      if (pointCount > MAX_COPC_NODE_POINTS) {
        throw new Error(`COPC: node ${voxelKeyId(key)} declares ${pointCount} points (limit ${MAX_COPC_NODE_POINTS})`);
      }
      if (byteSize <= 0) throw new Error(`COPC: node ${voxelKeyId(key)} has ${pointCount} points but ${byteSize} bytes`);
      checkSpan(`node ${voxelKeyId(key)}`, offset, byteSize, fileSize);
      page.nodes.push({ key, offset, byteSize, pointCount });
    } else {
      throw new Error(`COPC: hierarchy entry ${voxelKeyId(key)} has invalid point count ${pointCount}`);
    }
  }
  return page;
}

export type CopcChildState = 'node' | 'page' | 'absent';

/** The eight children of `key`. */
export function copcChildKeys(key: VoxelKey): VoxelKey[] {
  const out: VoxelKey[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({ d: key.d + 1, x: key.x * 2 + (i & 1), y: key.y * 2 + ((i >> 1) & 1), z: key.z * 2 + ((i >> 2) & 1) });
  }
  return out;
}

/**
 * The hierarchy known so far: nodes from loaded pages, plus pointers to
 * pages not yet loaded. Pages load on demand, so a huge file's hierarchy is
 * only read where the camera looks.
 */
export class CopcHierarchy {
  readonly nodes = new Map<string, CopcNodeEntry>();
  /** Unloaded child pages, keyed by the id of their subtree root. */
  readonly pendingPages = new Map<string, CopcPageRef>();
  private readonly seenPageOffsets = new Set<number>();
  private pageBytes = 0;
  private pageCount = 0;

  constructor(readonly limits: CopcHierarchyLimits = DEFAULT_COPC_HIERARCHY_LIMITS) {}

  get loadedPageCount(): number {
    return this.pageCount;
  }

  /** Page bytes still allowed by `limits.maxPageBytes`. */
  get remainingPageBytes(): number {
    return Math.max(0, this.limits.maxPageBytes - this.pageBytes);
  }

  /**
   * Throw unless `ref` fits the page and byte budgets. Call BEFORE reading a
   * page: a hostile pointer can name a page as large as the file, and a
   * budget checked only after parsing has already paid for it.
   */
  assertCanLoad(ref: { byteSize: number }): void {
    if (this.pageCount + 1 > this.limits.maxPages) {
      throw new Error(`COPC: hierarchy exceeds ${this.limits.maxPages} pages`);
    }
    if (ref.byteSize > this.remainingPageBytes) {
      throw new Error(`COPC: hierarchy exceeds ${this.limits.maxPageBytes} page bytes`);
    }
  }

  /**
   * Admit the page read from `ref`: the root page first, then only pages
   * that are pending. Throws when a budget is exceeded or a node key
   * repeats; pointers to already-seen pages are dropped.
   */
  addPage(ref: { offset: number; byteSize: number; key?: VoxelKey }, page: CopcHierarchyPage): void {
    if (this.pageCount > 0 && !this.isPending(ref)) {
      throw new Error(`COPC: page at ${ref.offset} is not a pending hierarchy page`);
    }
    this.pageCount++;
    this.pageBytes += ref.byteSize;
    if (this.pageCount > this.limits.maxPages) {
      throw new Error(`COPC: hierarchy exceeds ${this.limits.maxPages} pages`);
    }
    if (this.pageBytes > this.limits.maxPageBytes) {
      throw new Error(`COPC: hierarchy exceeds ${this.limits.maxPageBytes} page bytes`);
    }
    this.seenPageOffsets.add(ref.offset);
    if (ref.key) this.pendingPages.delete(voxelKeyId(ref.key));
    if (this.nodes.size + page.nodes.length > this.limits.maxNodes) {
      throw new Error(`COPC: hierarchy exceeds ${this.limits.maxNodes} nodes`);
    }
    for (const node of page.nodes) {
      const id = voxelKeyId(node.key);
      if (this.nodes.has(id)) throw new Error(`COPC: hierarchy lists node ${id} twice`);
      this.nodes.set(id, node);
    }
    for (const child of page.pages) {
      // The visited set is the cycle guard: a pointer back to any page we
      // have read or queued is dropped, never followed.
      if (this.seenPageOffsets.has(child.offset)) continue;
      const id = voxelKeyId(child.key);
      // Two pointers for one subtree root: overwriting would silently drop
      // the first page's subtree, so treat it like a repeated node.
      if (this.pendingPages.has(id)) throw new Error(`COPC: hierarchy lists child page ${id} twice`);
      this.seenPageOffsets.add(child.offset);
      this.pendingPages.set(id, child);
    }
  }

  private isPending(ref: { offset: number; key?: VoxelKey }): boolean {
    if (!ref.key) return false;
    return this.pendingPages.get(voxelKeyId(ref.key))?.offset === ref.offset;
  }

  /** Whether `key` is a known node, the root of an unloaded page, or neither. */
  stateOf(key: VoxelKey): CopcChildState {
    const id = voxelKeyId(key);
    if (this.nodes.has(id)) return 'node';
    if (this.pendingPages.has(id)) return 'page';
    return 'absent';
  }
}

/** Reads one page's bytes and parses it; the reader owns the I/O. */
export type CopcPageFetcher = (ref: CopcPageRef, signal?: AbortSignal) => Promise<CopcHierarchyPage>;

/**
 * Load every pending page, iteratively (breadth-first, `concurrency` reads
 * in flight), optionally only those whose subtree root is at most
 * `maxLevel` deep. The visited set and the hierarchy's budgets bound the
 * work; there is no recursion.
 */
export async function loadPendingCopcPages(
  hierarchy: CopcHierarchy,
  fetchPage: CopcPageFetcher,
  options: { maxLevel?: number; signal?: AbortSignal; concurrency?: number } = {},
): Promise<void> {
  const maxLevel = options.maxLevel ?? Infinity;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 6));
  while (true) {
    options.signal?.throwIfAborted();
    const batch = [...hierarchy.pendingPages.values()].filter((ref) => ref.key.d <= maxLevel).slice(0, concurrency);
    if (batch.length === 0) return;
    // Budget the whole batch before any read starts.
    batch.reduce((bytes, ref) => {
      hierarchy.assertCanLoad({ byteSize: bytes + ref.byteSize });
      return bytes + ref.byteSize;
    }, 0);
    const pages = await Promise.all(batch.map((ref) => fetchPage(ref, options.signal)));
    batch.forEach((ref, i) => hierarchy.addPage(ref, pages[i]));
  }
}
