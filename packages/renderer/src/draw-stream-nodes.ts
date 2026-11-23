/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Spatial nodes of the draw stream and their links into the HLOD tree (`draw-stream.ts`). */
import type { BatchedMesh } from './types.js';
import { nodeKey, type HlodTree } from './draw-stream-hlod.js';
import { cellOf, growAabb, type StreamBatchState, type StreamNode, type Vec3 } from './draw-stream-types.js';

/** Group stream members into one node per `cell`-sized chunk cell (members with bounds only). */
export function buildStreamNodes(members: readonly BatchedMesh[], cell: number): StreamNode[] {
  const byCell = new Map<string, StreamNode>();
  for (let i = 0; i < members.length; i++) {
    const b = members[i]!; const bb = b.bounds!;
    const c = cellOf(bb.min, bb.max, cell);
    const k = `${c[0]},${c[1]},${c[2]}`;
    let node = byCell.get(k);
    if (!node) {
      node = { coords: c, min: [...bb.min], max: [...bb.max], members: [], tris0: 0, tris1: 0, entries: 0, bundles: [null, null, null, null, null, null, null, null], ortho: [] };
      byCell.set(k, node);
    }
    growAabb(node, bb.min, bb.max);
    node.members.push(i); node.entries += b.expressIds.length;
    node.tris0 += b.indexCount / 3; node.tris1 += (b.lod1IndexBuffer && b.lod1IndexCount ? b.lod1IndexCount : b.indexCount) / 3;
  }
  const nodes = [...byCell.values()];
  // f32 members first, then quantized: one pipeline switch per node at most.
  for (const n of nodes) n.members.sort((a, b) => Number(!!members[a]!.quantized) - Number(!!members[b]!.quantized));
  return nodes;
}

export interface HlodLinks {
  /** Leaves under each level-1 HLOD node, by its key; a leaf spanning several level-1 cells is under each. */
  leavesByParent: Map<string, StreamNode[]>;
  /** Leaves no HLOD node covers: always visited directly. */
  uncovered: StreamNode[];
  /** HLOD node keys that must never draw their proxy: over a legacy-path, colour-painted or shared leaf. */
  dirty: Set<string>;
  /** Too many level-1 cells to mark: no proxy draws at all (every leaf is visited directly). */
  allDirty: boolean;
}

/** Level-1 cells one AABB may touch before HLOD is given up for the frame set (chunking off, huge pieces). */
const MAX_SPAN_CELLS = 64;

/** Every level-1 cell (edge `2 * cell`) the AABB touches, or null past `MAX_SPAN_CELLS`. */
function spannedCells(min: readonly number[], max: readonly number[], cell: number): Vec3[] | null {
  const lo = cellOf(min, min, 2 * cell), hi = cellOf(max, max, 2 * cell);
  if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > MAX_SPAN_CELLS) return null;
  const out: Vec3[] = [];
  for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) out.push([x, y, z]);
  return out;
}

/**
 * Link every leaf to each level-1 HLOD node its bounds touch (growing node
 * bounds to cover it), and mark dirty every node touched by a legacy-path or
 * colour-painted batch or by a leaf shared between nodes. Proxies are built
 * from mesh pieces by piece centre, which always lies inside its batch's
 * bounds, so marking by bounds (not centre) keeps a hidden or painted piece
 * out of every proxy, and a node never refines into a region whose leaf it
 * does not hold.
 */
export function linkHlodLeaves(h: HlodTree | null, nodes: StreamNode[], legacy: readonly BatchedMesh[], members: readonly BatchedMesh[],
  states: readonly StreamBatchState[], cell: number): HlodLinks {
  const links: HlodLinks = { leavesByParent: new Map(), uncovered: [], dirty: new Set(), allDirty: false };
  if (!h) { links.uncovered = nodes; return links; }
  const mark = (c: Vec3): void => {
    for (let level = 1; level < h.levels.length; level++) {
      const s = level - 1;
      links.dirty.add(nodeKey(level, [c[0] >> s, c[1] >> s, c[2] >> s]));
    }
  };
  const markBounds = (min: readonly number[], max: readonly number[]): void => {
    const cells = spannedCells(min, max, cell);
    if (cells) for (const c of cells) mark(c); else links.allDirty = true;
  };
  for (const b of legacy) if (b.bounds) markBounds(b.bounds.min, b.bounds.max);
  for (let i = 0; i < members.length; i++) if (states[i]!.overrideBits !== 0) { const bb = members[i]!.bounds!; markBounds(bb.min, bb.max); }
  for (const leaf of nodes) {
    const cells = spannedCells(leaf.min, leaf.max, cell);
    if (!cells) { links.allDirty = true; links.uncovered.push(leaf); continue; }
    let linked = 0;
    for (const pc of cells) {
      const parent = h.levels[1]?.get(nodeKey(1, pc));
      if (!parent) continue;
      linked++;
      const list = links.leavesByParent.get(parent.key);
      if (list) list.push(leaf); else links.leavesByParent.set(parent.key, [leaf]);
      for (let level = 1, c = pc; level < h.levels.length; level++, c = [c[0] >> 1, c[1] >> 1, c[2] >> 1]) {
        const n = h.levels[level]?.get(nodeKey(level, c)); if (!n) break;
        growAabb(n, leaf.min, leaf.max);
      }
    }
    if (linked === 0) links.uncovered.push(leaf);
    if (cells.length > 1) for (const c of cells) mark(c);
  }
  return links;
}
