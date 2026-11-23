/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Per-frame node culling, HLOD proxy selection and the optional draw budget of the draw stream. */
import type { HlodNode, HlodTree } from './draw-stream-hlod.js';
import type { HlodLinks } from './draw-stream-nodes.js';
import { aabbDist2, pxPerMetre, type StreamFrameInputs, type StreamFrameStats, type StreamItem, type StreamNode } from './draw-stream-types.js';

function dist2(min: readonly number[], max: readonly number[], eye: { x: number; y: number; z: number }): number {
  const cx = (min[0]! + max[0]!) / 2 - eye.x, cy = (min[1]! + max[1]!) / 2 - eye.y, cz = (min[2]! + max[2]!) / 2 - eye.z;
  return cx * cx + cy * cy + cz * cz;
}

/**
 * The nodes to draw this frame: frustum- and contribution-culled leaves, and
 * where a clean HLOD node's error projects below `hlodPx`, its proxy instead
 * of the subtree.
 */
export function collectStreamItems(f: StreamFrameInputs, nodes: readonly StreamNode[], h: HlodTree | null, links: HlodLinks, hlodPx: number): StreamItem[] {
  const items: StreamItem[] = [];
  const visitLeaf = (node: StreamNode): void => {
    if (!f.visible(node.min, node.max)) return;
    const px = f.projectedPx(node.min, node.max);
    if (f.contribPx > 0 && px < f.contribPx) return;
    items.push({ leaf: node, lod1: f.lodPx > 0 && px < f.lodPx, d: dist2(node.min, node.max, f.eye), px });
  };
  if (!h || !h.roots.length) {
    for (const leaf of nodes) visitLeaf(leaf);
    return items;
  }
  const visit = (n: HlodNode): void => {
    if (n.state === 'empty' && n.children.length === 0 && !links.leavesByParent.has(n.key)) return;
    if (!f.visible(n.min, n.max)) return;
    if (n.state === 'ready' && !links.dirty.has(n.key)) {
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
