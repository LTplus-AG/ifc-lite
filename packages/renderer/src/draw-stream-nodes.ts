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
      node = { coords: c, min: [...bb.min], max: [...bb.max], members: [], tris0: 0, tris1: 0, entries: 0, bundles: [null, null, null, null, null, null, null, null], ortho: [null, null, null, null] };
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
  /** Leaves under each level-1 HLOD node, by its key. */
  leavesByParent: Map<string, StreamNode[]>;
  /** Leaves no HLOD node covers: always visited directly. */
  uncovered: StreamNode[];
  /** HLOD node keys over a legacy-path or colour-painted batch: these never draw their proxy. */
  dirty: Set<string>;
}

/**
 * Map leaf cells to their level-1 HLOD parent (growing parent bounds to
 * cover them) and mark every node holding a legacy-path or colour-painted
 * batch dirty.
 */
export function linkHlodLeaves(h: HlodTree | null, nodes: StreamNode[], legacy: readonly BatchedMesh[], members: readonly BatchedMesh[],
  states: readonly StreamBatchState[], cell: number): HlodLinks {
  const links: HlodLinks = { leavesByParent: new Map(), uncovered: [], dirty: new Set() };
  if (!h) { links.uncovered = nodes; return links; }
  const mark = (c: Vec3): void => {
    for (let level = 1; level < h.levels.length; level++) {
      const s = level - 1;
      links.dirty.add(nodeKey(level, [c[0] >> s, c[1] >> s, c[2] >> s]));
    }
  };
  for (const b of legacy) if (b.bounds) mark(cellOf(b.bounds.min, b.bounds.max, 2 * cell));
  for (let i = 0; i < members.length; i++) if (states[i]!.overrideBits !== 0) { const bb = members[i]!.bounds!; mark(cellOf(bb.min, bb.max, 2 * cell)); }
  for (const leaf of nodes) {
    const pc: Vec3 = [leaf.coords[0] >> 1, leaf.coords[1] >> 1, leaf.coords[2] >> 1];
    const parent = h.levels[1]?.get(nodeKey(1, pc));
    if (!parent) { links.uncovered.push(leaf); continue; }
    const list = links.leavesByParent.get(parent.key);
    if (list) list.push(leaf); else links.leavesByParent.set(parent.key, [leaf]);
    for (let level = 1, c = pc; level < h.levels.length; level++, c = [c[0] >> 1, c[1] >> 1, c[2] >> 1]) {
      const n = h.levels[level]?.get(nodeKey(level, c)); if (!n) break;
      growAabb(n, leaf.min, leaf.max);
    }
  }
  return links;
}
