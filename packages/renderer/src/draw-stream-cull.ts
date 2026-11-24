/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Per-frame node culling, HLOD proxy selection and the optional draw budget of the draw stream. */
import type { HlodNode, HlodTree } from './draw-stream-hlod.js';
import type { HlodLinks } from './draw-stream-nodes.js';
import type { BatchedMesh } from './types.js';
import { aabbDist2, pxPerMetre, type StreamFrameInputs, type StreamFrameStats, type StreamItem, type StreamNode, MemberPick } from './draw-stream-types.js';

/** Reused per-member picks while a node is decided (copied out only when its members differ). */
let scratch = new Uint8Array(64);

/**
 * Each member's draw from its OWN projected size, exactly as the per-batch
 * loop decides a batch (contribution cull, then LOD1 below `lodPx`): a node
 * spans a whole chunk cell, so judging it by its own size drew small members
 * at full detail that the loop draws simplified or not at all (#11370
 * qualification: slab edges, glazing). Returns the members' common pick, or
 * one pick per member when they differ.
 */
export function memberPicks(f: StreamFrameInputs, node: StreamNode, members: readonly BatchedMesh[]): MemberPick | Uint8Array {
  if (!(f.contribPx > 0) && !(f.lodPx > 0)) return MemberPick.Lod0;
  // Every member at least `minRadius`, no farther than the node's far corner: when even that projects
  // above both thresholds, all members draw at LOD0 without projecting each (most near nodes).
  const far = Math.sqrt(farDist2(node.min, node.max, f.eye));
  if (node.minRadius * pxPerMetre(f.projection, far) * 0.999 >= Math.max(f.contribPx, f.lodPx)) return MemberPick.Lod0;
  const pickOf = (k: number): MemberPick => {
    const b = members[node.members[k]!]!, px = b.bounds ? f.projectedPx(b.bounds.min, b.bounds.max) : Infinity;
    if (f.contribPx > 0 && px < f.contribPx) return MemberPick.Cull;
    if (!(b.lod1IndexBuffer && b.lod1IndexCount)) return MemberPick.AnyLod;
    return f.lodPx > 0 && px < f.lodPx ? MemberPick.Lod1 : MemberPick.Lod0;
  };
  let common = -1, mixed = false, drawsAny = false;
  if (scratch.length < node.members.length) scratch = new Uint8Array(node.members.length * 2);
  for (let k = 0; k < node.members.length; k++) {
    const s = scratch[k] = pickOf(k);
    if (s === MemberPick.AnyLod) drawsAny = true; // agrees with either LOD, never with Cull
    else if (common < 0) common = s; else if (s !== common) mixed = true;
  }
  if (mixed || (common === MemberPick.Cull && drawsAny)) return scratch.slice(0, node.members.length); // copied only when mixed
  return common < 0 ? MemberPick.Lod0 : common as MemberPick;
}

function farDist2(min: readonly number[], max: readonly number[], p: { x: number; y: number; z: number }): number {
  const dx = Math.max(p.x - min[0]!, max[0]! - p.x), dy = Math.max(p.y - min[1]!, max[1]! - p.y), dz = Math.max(p.z - min[2]!, max[2]! - p.z);
  return dx * dx + dy * dy + dz * dz;
}

/** Draws and triangles of a mixed node this frame (culled members excluded). */
export function pickedLoad(node: StreamNode, picks: Uint8Array, members: readonly BatchedMesh[]): { draws: number; tris: number } {
  let draws = 0, tris = 0;
  for (let k = 0; k < picks.length; k++) {
    if (picks[k] === MemberPick.Cull) continue;
    const b = members[node.members[k]!]!; draws++;
    tris += (picks[k] === MemberPick.Lod1 ? b.lod1IndexCount! : b.indexCount) / 3;
  }
  return { draws, tris };
}

/** FNV-1a of a mixed node's picks, for its bundle-cache key. */
export function picksHash(picks: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < picks.length; k++) h = Math.imul(h ^ picks[k]!, 0x01000193);
  return h >>> 0;
}

/**
 * The nodes to draw this frame: frustum- and contribution-culled leaves, and
 * where a clean HLOD node's error projects below `hlodPx`, its proxy instead
 * of the subtree.
 */
export function collectStreamItems(f: StreamFrameInputs, nodes: readonly StreamNode[], h: HlodTree | null, links: HlodLinks, hlodPx: number,
  members: readonly BatchedMesh[]): StreamItem[] {
  const items: StreamItem[] = [];
  const visited = new Set<StreamNode>(); // a leaf spanning several HLOD nodes is reached once per node
  const visitLeaf = (node: StreamNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (!f.visible(node.min, node.max)) return;
    const pick = memberPicks(f, node, members);
    if (pick === MemberPick.Cull) return;
    items.push({ leaf: node, lod1: pick === MemberPick.Lod1, picks: typeof pick === 'number' ? undefined : pick, d: aabbDist2(node.min, node.max, f.eye), px: f.projectedPx(node.min, node.max) });
  };
  if (!h || !h.roots.length) {
    for (const leaf of nodes) visitLeaf(leaf);
    return items;
  }
  const visit = (n: HlodNode): void => {
    if (n.state === 'empty' && n.children.length === 0 && !links.leavesByParent.has(n.key)) return;
    if (!f.visible(n.min, n.max)) return;
    if (n.state === 'ready' && !links.allDirty && !links.dirty.has(n.key) && !h.outsideNodes.has(n.key)) {
      const d = Math.sqrt(aabbDist2(n.min, n.max, f.eye));
      if (d > 0 && n.error * pxPerMetre(f.projection, d) < hlodPx) { items.push({ proxy: n, d: d * d, px: f.projectedPx(n.min, n.max) }); return; }
    }
    if (n.level === 1) { for (const leaf of links.leavesByParent.get(n.key) ?? []) visitLeaf(leaf); return; }
    for (const c of n.children) visit(c);
  };
  for (const r of h.roots) visit(r);
  for (const leaf of links.uncovered) visitLeaf(leaf);
  return items;
}

/**
 * Adaptive draw budget while the camera moves: AIMD toward `targetMs` on the
 * measured frame interval, keeping the largest-on-screen nodes. At rest every
 * node draws. Off when `targetMs` is 0.
 */
export class StreamDrawBudget {
  private budget = 20000;
  private lastFrameAt = 0;

  apply(items: StreamItem[], targetMs: number, interacting: boolean, stats: StreamFrameStats): void {
    if (targetMs <= 0) return;
    const now = performance.now();
    const dt = now - this.lastFrameAt;
    if (interacting && this.lastFrameAt > 0 && dt < 500) {
      this.budget = dt > targetMs ? Math.max(500, this.budget * Math.max(0.5, targetMs / dt)) : this.budget + 500;
    }
    this.lastFrameAt = now;
    if (!interacting) return;
    const drawsOf = (it: StreamItem): number => (it.proxy ? it.proxy.draws.length : it.leaf.members.length);
    let total = 0; for (const it of items) total += drawsOf(it);
    if (total > this.budget) {
      items.sort((a, b) => b.px - a.px);
      let used = 0, keep = 0;
      for (; keep < items.length; keep++) { const n = drawsOf(items[keep]!); if (used + n > this.budget && keep > 0) break; used += n; }
      stats.budgetCut = items.length - keep;
      items.length = keep;
    }
    stats.budgetDraws = Math.round(this.budget);
  }
}
