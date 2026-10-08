/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property tests for `selectLod` on seeded synthetic octrees (#6869).
 *
 * Each property runs over many (octree, camera, budget) triples from a fixed
 * seed. The culling oracle is independent of the implementation: it projects
 * a node's eight corners to clip space and calls the node "certainly
 * outside" when all of them fail the same clip inequality, which is a
 * different computation from the plane test `selectLod` uses.
 */

import { describe, expect, it } from 'vitest';
import type { PointCloudBBox } from '../types.js';
import { defaultMaxNodes, selectLod, waterFill, type LodCamera, type LodNode, type LodSelection } from './select.js';

/** Numerical Recipes LCG in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface TestNode extends LodNode {
  parent: TestNode | null;
  children: TestNode[] | null;
}

/** An additive octree over [0, 256]^3: random occupancy, counts and unloaded subtrees. */
function octree(seed: number, maxDepth = 6, occupancy = 0.55): TestNode {
  const r = rng(seed);
  const make = (d: number, x: number, y: number, z: number, parent: TestNode | null): TestNode => {
    const side = 256 / 2 ** d;
    const bounds: PointCloudBBox = { min: [x * side, y * side, z * side], max: [(x + 1) * side, (y + 1) * side, (z + 1) * side] };
    const node: TestNode = { id: `${d}-${x}-${y}-${z}`, bounds, pointCount: 500 + Math.floor(r() * 60_000), children: null, parent };
    if (d < maxDepth && (occupancy === 1 || r() > 0.06)) {
      const kids: TestNode[] = [];
      for (let i = 0; i < 8; i++) {
        if (r() < occupancy) kids.push(make(d + 1, x * 2 + (i & 1), y * 2 + ((i >> 1) & 1), z * 2 + ((i >> 2) & 1), node));
      }
      node.children = kids;
    }
    return node;
  };
  return make(0, 0, 0, 0, null);
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Column-major multiply. */
function mul(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

/** A WebGPU camera: right-handed look-at, depth in [0, 1], forward or reverse Z. */
function camera(eye: V3, target: V3, opts: { fovY?: number; reverseZ?: boolean; ortho?: number } = {}): LodCamera {
  const f = norm(sub(target, eye));
  const s = norm(cross(f, [0, 0, 1]));
  const u = cross(s, f);
  const view = [s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0, -dot(s, eye), -dot(u, eye), dot(f, eye), 1];
  const near = 0.5;
  const far = 2000;
  const aspect = 1.6;
  let proj: number[];
  let projScaleY: number;
  if (opts.ortho) {
    const h = opts.ortho;
    projScaleY = 2 / h;
    proj = [2 / (h * aspect), 0, 0, 0, 0, projScaleY, 0, 0, 0, 0, -1 / (far - near), 0, 0, 0, -near / (far - near), 1];
  } else {
    projScaleY = 1 / Math.tan((opts.fovY ?? Math.PI / 3) / 2);
    const [a, b] = opts.reverseZ ? [near / (far - near), (far * near) / (far - near)] : [-far / (far - near), (-far * near) / (far - near)];
    proj = [projScaleY / aspect, 0, 0, 0, 0, projScaleY, 0, 0, 0, 0, a, -1, 0, 0, b, 0];
  }
  return { viewProj: mul(proj, view), position: eye, viewportHeight: 900, projScaleY, orthographic: Boolean(opts.ortho) };
}

function randomCamera(r: () => number): LodCamera {
  const eye: V3 = [r() * 600 - 170, r() * 600 - 170, r() * 400 - 50];
  const target: V3 = [r() * 256, r() * 256, r() * 256];
  const roll = r();
  if (roll < 0.15) return camera(eye, target, { ortho: 50 + r() * 400 });
  return camera(eye, target, { reverseZ: roll > 0.55, fovY: 0.4 + r() * 1.2 });
}

/** Independent oracle: all 8 corners fail the same clip-space inequality. */
function certainlyOutside(b: PointCloudBBox, m: ArrayLike<number>): boolean {
  const clips: number[][] = [];
  for (let i = 0; i < 8; i++) {
    const p = [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2], 1];
    const c = [0, 0, 0, 0];
    for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) c[row] += m[k * 4 + row] * p[k];
    clips.push(c);
  }
  const tests = [
    (c: number[]) => c[0] < -c[3], (c: number[]) => c[0] > c[3],
    (c: number[]) => c[1] < -c[3], (c: number[]) => c[1] > c[3],
    (c: number[]) => c[2] < 0, (c: number[]) => c[2] > c[3],
  ];
  return tests.some((t) => clips.every(t));
}

function all(root: TestNode): TestNode[] {
  const out: TestNode[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop() as TestNode;
    out.push(n);
    for (const c of n.children ?? []) stack.push(c);
  }
  return out;
}

const BUDGETS = [2_000, 50_000, 300_000, 1_000_000, 5_000_000];
const CASES = 120;

function forEachCase(fn: (root: TestNode, cam: LodCamera, budget: number, sel: LodSelection) => void): void {
  const r = rng(6869);
  for (let i = 0; i < CASES; i++) {
    const root = octree(1000 + i);
    const cam = randomCamera(r);
    const budget = BUDGETS[i % BUDGETS.length];
    fn(root, cam, budget, selectLod(root, cam, { pointBudget: budget }));
  }
}

// #6916: each property retains 120 seeded octrees; allow bounded CI CPU contention.
describe('selectLod properties (#6869)', { timeout: 30_000 }, () => {
  it('never exceeds the point budget or the node cap, and never over-asks a node', () => {
    let nonTrivial = 0;
    forEachCase((_root, _cam, budget, sel) => {
      expect(sel.totalPoints).toBeLessThanOrEqual(budget);
      expect(sel.nodes.length).toBeLessThanOrEqual(defaultMaxNodes(budget));
      expect(sel.nodes.reduce((a, n) => a + n.points, 0)).toBe(sel.totalPoints);
      for (const s of sel.nodes) {
        expect(s.points).toBeLessThanOrEqual(s.node.pointCount);
        expect(Math.ceil(s.node.pointCount / s.stride)).toBeLessThanOrEqual(s.points);
      }
      if (sel.nodes.length > 3) nonTrivial++;
    });
    expect(nonTrivial).toBeGreaterThan(CASES / 3); // the cameras actually exercise refinement
  });

  it('selects parents before children, and refines only parents above the pixel threshold', () => {
    forEachCase((root, _cam, _budget, sel) => {
      const index = new Map(sel.nodes.map((s, i) => [s.node.id, i]));
      for (const [i, s] of sel.nodes.entries()) {
        const parent = (s.node as TestNode).parent;
        if (s.node === root) continue;
        expect(parent).not.toBeNull();
        const at = index.get((parent as TestNode).id) as number;
        expect(at).toBeLessThan(i);
        expect(sel.nodes[at].screenSpan).toBeGreaterThan(96);
      }
    });
  });

  it('a higher pixel threshold never selects more nodes', () => {
    forEachCase((root, cam, budget, sel) => {
      const coarse = selectLod(root, cam, { pointBudget: budget, pixelThreshold: 400 });
      expect(coarse.nodes.length).toBeLessThanOrEqual(sel.nodes.length);
    });
  });

  it('never selects a node that lies outside the view', () => {
    let culledSomewhere = 0;
    forEachCase((root, cam, _budget, sel) => {
      for (const s of sel.nodes) expect(certainlyOutside(s.node.bounds, cam.viewProj)).toBe(false);
      if (all(root).some((n) => certainlyOutside(n.bounds, cam.viewProj))) culledSomewhere++;
    });
    expect(culledSomewhere).toBeGreaterThan(CASES / 2);
  });

  it('is monotone in the budget: more budget keeps every node and never shows fewer points', () => {
    const r = rng(42);
    for (let i = 0; i < 60; i++) {
      const root = octree(5000 + i);
      const cam = randomCamera(r);
      let prev: LodSelection | null = null;
      for (const budget of [1_000, 10_000, 64_000, 128_000, 512_000, 4_000_000]) {
        const sel = selectLod(root, cam, { pointBudget: budget });
        if (prev) {
          const ids = new Set(sel.nodes.map((s) => s.node.id));
          for (const s of prev.nodes) expect(ids.has(s.node.id)).toBe(true);
          expect(sel.totalPoints).toBeGreaterThanOrEqual(prev.totalPoints);
        }
        prev = sel;
      }
    }
  });

  it('is deterministic and independent of child order', () => {
    forEachCase((root, cam, budget, sel) => {
      const again = selectLod(root, cam, { pointBudget: budget });
      expect(again.nodes.map((s) => [s.node.id, s.points, s.stride])).toEqual(sel.nodes.map((s) => [s.node.id, s.points, s.stride]));
      for (const n of all(root)) n.children?.reverse();
      const flipped = selectLod(root, cam, { pointBudget: budget });
      expect(flipped.nodes.map((s) => [s.node.id, s.points])).toEqual(sel.nodes.map((s) => [s.node.id, s.points]));
    });
  });

  it('refines every large node unless the cap stopped it; unloaded subtrees are reported', () => {
    // With finite near/far planes the clip-corner oracle and the plane test
    // agree exactly, so "not certainly outside" means "visible" here.
    let refinedChecks = 0;
    forEachCase((_root, cam, _budget, sel) => {
      if (sel.capped) return;
      const chosen = new Set(sel.nodes.map((s) => s.node.id));
      const wanting = new Set(sel.needsChildren.map((n) => n.id));
      for (const s of sel.nodes) {
        if (!(s.screenSpan > 96)) continue;
        if (s.node.children === null) {
          expect(wanting.has(s.node.id)).toBe(true);
          continue;
        }
        for (const child of s.node.children) {
          if (certainlyOutside(child.bounds, cam.viewProj)) continue;
          expect(chosen.has(child.id)).toBe(true);
          refinedChecks++;
        }
      }
    });
    expect(refinedChecks).toBeGreaterThan(100);
  });

  it('a camera looking away selects nothing; a camera inside the root refines', () => {
    const root = octree(7);
    const away = selectLod(root, camera([-400, 128, 128], [-800, 128, 128]), { pointBudget: 1_000_000 });
    expect(away.nodes).toEqual([]);
    const inside = selectLod(root, camera([100, 100, 100], [200, 180, 120]), { pointBudget: 1_000_000 });
    expect(inside.nodes[0].node.id).toBe('0-0-0-0');
    expect(inside.nodes[0].screenSpan).toBe(Infinity);
    expect(inside.nodes.length).toBeGreaterThan(8);
  });

  it('nearer nodes refine deeper than far ones', () => {
    // A complete octree, so depth differences come from the camera alone.
    const root = octree(11, 5, 1);
    const sel = selectLod(root, camera([5, 5, 30], [250, 250, 20], { fovY: 1.2 }), { pointBudget: 2_000_000 });
    const depthOf = (id: string) => Number(id.split('-')[0]);
    const near = sel.nodes.filter((s) => s.node.bounds.max[0] <= 64 && s.node.bounds.max[1] <= 64);
    const far = sel.nodes.filter((s) => s.node.bounds.min[0] >= 192 && s.node.bounds.min[1] >= 192);
    const maxDepth = (list: typeof sel.nodes) => Math.max(0, ...list.map((s) => depthOf(s.node.id)));
    expect(maxDepth(near)).toBeGreaterThan(maxDepth(far));
  });
});

describe('waterFill', () => {
  it('gives everything when it fits', () => {
    expect(waterFill([5, 10, 3], 100)).toEqual([5, 10, 3]);
  });

  it('is max-min fair: small nodes are filled, the rest share one level', () => {
    expect(waterFill([10, 1_000, 50, 1_000], 600)).toEqual([10, 270, 50, 270]);
  });

  it('spends the whole budget and never exceeds a cap (seeded sweep)', () => {
    const r = rng(9);
    for (let t = 0; t < 500; t++) {
      const counts = Array.from({ length: 1 + Math.floor(r() * 40) }, () => Math.floor(r() * 5_000));
      const budget = Math.floor(r() * 60_000);
      const out = waterFill(counts, budget);
      const sum = out.reduce((a, b) => a + b, 0);
      expect(sum).toBe(Math.min(budget, counts.reduce((a, b) => a + b, 0)));
      const level = Math.max(...out.filter((v, i) => v < counts[i]), -1);
      out.forEach((v, i) => {
        expect(v).toBeLessThanOrEqual(counts[i]);
        if (v < counts[i]) expect(level - v).toBeLessThanOrEqual(1);
        else if (level >= 0) expect(v).toBeLessThanOrEqual(level + 1);
      });
    }
  });
});
