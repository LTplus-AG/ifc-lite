/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bookkeeping of GPU-driven instancing (`gpu-instance-pool.ts`) that needs no
 * GPU: draw groups (templates with byte-identical geometry share one indirect
 * draw) and the override colour palette the occurrence state indexes.
 *
 * Draw groups (hash, then a full compare of positions, normals and indices)
 * make the same window from forty worker batches one draw instead of forty,
 * raising effective instancing across batch calls without touching Rust.
 */
import { POOL_PALETTE_MAX } from './gpu-instance-cull.js';

export interface PoolGeometry {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export interface PoolGroup {
  /** Template slots sharing this geometry, with their own buffers. */
  members: { slot: number; vertexBuffer: GPUBuffer; indexBuffer: GPUBuffer; positions: Float32Array; normals: Float32Array; indices: Uint32Array; count: number }[];
  indexCount: number;
  /** First occurrence of the group's compacted region, and its size (`layout`). */
  base: number;
  capacity: number;
}

/** Hash a template's geometry (positions, normals and indices bit patterns: the vertex buffer draws all of them). */
function hashGeometry(positions: Float32Array, normals: Float32Array, indices: Uint32Array): number {
  let h = 0x811c9dc5;
  for (const f of [positions, normals]) {
    const p = new Uint32Array(f.buffer, f.byteOffset, f.length);
    for (let i = 0; i < p.length; i++) h = Math.imul(h ^ p[i]!, 0x01000193);
  }
  for (let i = 0; i < indices.length; i++) h = Math.imul(h ^ indices[i]!, 0x01000193);
  return (h ^ (positions.length * 31 + indices.length)) >>> 0;
}

/** Element-wise equality; Float32Arrays compare bit patterns (so -0/NaN match exactly). */
function sameArray(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  if (a instanceof Float32Array && b instanceof Float32Array) {
    const ua = new Uint32Array(a.buffer, a.byteOffset, a.length), ub = new Uint32Array(b.buffer, b.byteOffset, b.length);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  }
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Draw groups: the same window from forty worker batches is one draw instead of forty. */
export class DrawGroups {
  private readonly groups: PoolGroup[] = [];
  private readonly byHash = new Map<number, number[]>();

  get length(): number { return this.groups.length; }
  at(g: number): PoolGroup | undefined { return this.groups[g]; }

  /** Add template `slot` (`count` occurrences) to the group of identical geometry, creating it if new; returns the group. */
  join(slot: number, geometry: PoolGeometry, count: number): number {
    const hash = hashGeometry(geometry.positions, geometry.normals, geometry.indices);
    let group = -1;
    for (const g of this.byHash.get(hash) ?? []) {
      const candidate = this.groups[g]!;
      const ref = candidate.members[0];
      if (ref && candidate.indexCount === geometry.indexCount && sameArray(ref.indices, geometry.indices) && sameArray(ref.positions, geometry.positions) && sameArray(ref.normals, geometry.normals)) {
        group = g;
        break;
      }
    }
    if (group < 0) {
      group = this.groups.length;
      this.groups.push({ members: [], indexCount: geometry.indexCount, base: 0, capacity: 0 });
      const list = this.byHash.get(hash);
      if (list) list.push(group); else this.byHash.set(hash, [group]);
    }
    this.groups[group]!.members.push({ slot, vertexBuffer: geometry.vertexBuffer, indexBuffer: geometry.indexBuffer, positions: geometry.positions, normals: geometry.normals, indices: geometry.indices, count });
    return group;
  }

  leave(group: number, slot: number): void {
    const g = this.groups[group];
    if (g) g.members = g.members.filter((m) => m.slot !== slot);
  }

  /**
   * Lay out one compacted region per group (prefix sum of its live members'
   * counts) and return the `drawIndexedIndirect` args, `argsWords` per group,
   * with the index count filled and the instance count zero.
   */
  layout(argsWords: number): Uint32Array {
    let base = 0;
    for (const g of this.groups) {
      g.capacity = 0;
      for (const m of g.members) g.capacity += m.count;
      g.base = base;
      base += g.capacity;
    }
    const args = new Uint32Array(Math.max(1, this.groups.length) * argsWords);
    for (let g = 0; g < this.groups.length; g++) args[g * argsWords] = this.groups[g]!.indexCount;
    return args;
  }

  clear(): void { this.groups.length = 0; this.byHash.clear(); }
}

/** Override colours, rgba per entry; entry 0 means "the record's own colour". */
export class ColourPalette {
  readonly colours: number[] = [0, 0, 0, 0];
  /** Set when an entry was added since the last upload. */
  dirty = true;
  private readonly index = new Map<string, number>();
  private lastRef: Float32Array | null = null;
  private lastIndex = 0;

  /** Palette index of colour `c`, adding it when new; -1 when the palette is full (see `compact`). */
  indexOf(c: Float32Array): number {
    if (c === this.lastRef) return this.lastIndex;
    const key = `${c[0]},${c[1]},${c[2]},${c[3]}`;
    let idx = this.index.get(key);
    if (idx === undefined) {
      idx = this.colours.length / 4;
      if (idx > POOL_PALETTE_MAX) return -1;
      this.colours.push(c[0]!, c[1]!, c[2]!, c[3]!);
      this.index.set(key, idx);
      this.dirty = true;
    }
    this.lastRef = c;
    this.lastIndex = idx;
    return idx;
  }

  /** Keep only entries in `used` (0 always stays), renumbered densely; returns old -> new index. */
  compact(used: ReadonlySet<number>): Map<number, number> {
    const remap = new Map<number, number>();
    const kept: number[] = [0, 0, 0, 0];
    this.index.clear(); this.lastRef = null;
    for (let old = 1; old < this.colours.length / 4; old++) {
      if (!used.has(old)) continue;
      const at = kept.length / 4;
      const c = this.colours.slice(old * 4, old * 4 + 4);
      kept.push(c[0]!, c[1]!, c[2]!, c[3]!); remap.set(old, at); this.index.set(`${c[0]},${c[1]},${c[2]},${c[3]}`, at);
    }
    this.colours.length = kept.length;
    for (let i = 0; i < kept.length; i++) this.colours[i] = kept[i]!;
    this.dirty = true;
    return remap;
  }

  /** Compact to the entries `states` (index in the bits above `shift`) still reference, rewriting them through `write`. */
  compactStates(states: Uint32Array, shift: number, write: (i: number, value: number) => void): void {
    const used = new Set<number>();
    for (const v of states) used.add(v >>> shift);
    const remap = this.compact(used);
    const low = (1 << shift) - 1;
    for (let i = 0; i < states.length; i++) {
      const old = states[i]! >>> shift;
      if (old) write(i, ((states[i]! & low) | ((remap.get(old) ?? 0) << shift)) >>> 0);
    }
  }

  /** Set when an entry may have lost its last user (a recolour, a removed template): compaction may free space. */
  freed = true;

  /**
   * Index for colour `c` given the occurrence `states` (index in the bits
   * above `shift`, DEAD words passed as `dead`): a full palette is compacted
   * to the entries live states reference, at most once per `freed`; a palette
   * full of live colours yields 0 (the record colour), warned once.
   */
  resolve(c: Float32Array, states: Uint32Array, shift: number, dead: number, write: (i: number, value: number) => void): number {
    let idx = this.indexOf(c);
    if (idx >= 0) return idx;
    if (!this.freed) return 0;
    this.freed = false;
    // Dead words never draw; their stale index is reset when the range is reused.
    this.compactStates(states.map((v) => (v & dead ? v & ((1 << shift) - 1) : v)), shift, write);
    idx = this.indexOf(c);
    if (idx >= 0) return idx;
    console.warn('[GpuInstancePool] colour palette full of live colours; further overrides fall back to the record colour');
    return 0;
  }
}

/** Contiguous occurrence ranges of removed templates, handed out again first-fit. */
export class FreeRanges {
  private readonly ranges: { base: number; count: number }[] = [];
  release(base: number, count: number): void { this.ranges.push({ base, count }); }
  /** First of `count` reused occurrences, or -1 when no released range fits. */
  take(count: number): number {
    const i = this.ranges.findIndex((r) => r.count >= count);
    if (i < 0) return -1;
    const r = this.ranges[i]!, base = r.base;
    if (r.count === count) this.ranges.splice(i, 1); else { r.base += count; r.count -= count; }
    return base;
  }
}
