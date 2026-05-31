/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ClashElement } from '../types.js';
import { candidatePairs } from './broad.js';
import { testPair } from './narrow.js';
import { TriMesh } from './tri-mesh.js';
import type { ClashKernel, NarrowRecord, RuleDetection } from './kernel.js';

/**
 * Pure-TypeScript geometry kernel: spatial BVH broad phase + exact
 * triangle-triangle narrow phase. Also the reference oracle the Rust/WASM kernel
 * is differentially tested against.
 */
export class TsKernel implements ClashKernel {
  private readonly triCache = new WeakMap<ClashElement, TriMesh>();

  prepare(): void {
    // Triangle BVHs are built lazily per element on first use, and cached for
    // the lifetime of this kernel so an element shared across rules pays once.
  }

  private triFor(el: ClashElement): TriMesh {
    let mesh = this.triCache.get(el);
    if (!mesh) {
      mesh = new TriMesh(el.positions, el.indices, el.transform);
      this.triCache.set(el, mesh);
    }
    return mesh;
  }

  async detectRule(
    elements: ClashElement[],
    groupAIdx: number[],
    groupBIdx: number[] | null,
    rule: import('../types.js').ClashRule,
    tolerance: number,
    maxPairs: number,
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ): Promise<RuleDetection> {
    const groupA = groupAIdx.map((i) => elements[i]);
    const groupB = groupBIdx ? groupBIdx.map((i) => elements[i]) : null;
    const resolveB = groupB ?? groupA;
    const resolveBIdx = groupBIdx ?? groupAIdx;
    const margin = Math.max(tolerance, rule.clearance ?? 0);

    const pairs = candidatePairs(groupA, groupB, margin);
    const total = pairs.length;
    const records: NarrowRecord[] = [];
    let processed = 0;
    let candidatesDropped = 0;
    onProgress?.(0, total);
    let lastYield = now();

    for (const [i, j] of pairs) {
      if (processed >= maxPairs) {
        candidatesDropped = total - processed;
        break;
      }
      // Every 1024 pairs: check cancellation, and if we've held the thread for
      // more than a frame's worth of time, report progress and yield so the UI
      // can repaint and stay responsive on large models.
      if ((processed & 0x3ff) === 0) {
        if (signal?.aborted) {
          throw new DOMException('Clash run aborted', 'AbortError');
        }
        if (onProgress && now() - lastYield > YIELD_MS) {
          onProgress(processed, total);
          await yieldToEventLoop();
          lastYield = now();
        }
      }
      processed += 1;
      const elA = groupA[i];
      const elB = resolveB[j];
      const res = testPair(elA, this.triFor(elA), elB, this.triFor(elB), rule, tolerance);
      if (!res) continue;
      records.push({
        a: groupAIdx[i],
        b: resolveBIdx[j],
        status: res.status,
        distance: res.distance,
        point: res.point,
        bounds: res.bounds,
      });
    }

    onProgress?.(processed, total);
    return { records, candidatesProcessed: processed, candidatesDropped };
  }
}

/** Hold the main thread no longer than this between yields (≈ a few frames). */
const YIELD_MS = 50;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Yield to the event loop so the host can flush React renders / repaint. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
