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
    // Yielding is what makes `signal` more than a check of an already-aborted
    // signal. Nearly every abort a caller can raise arrives from the event loop
    // — a run deadline (`setTimeout`), a cancel button, a host tearing its
    // sandbox down — and a loop that never returns to the event loop never lets
    // that code run, so `signal.aborted` stays false until the run has finished
    // anyway. Measured before this was decoupled: a 200 ms timer against a
    // 426 ms run aborted nothing at all without `onProgress`, and aborted at
    // 322 ms with it. So a caller that supplies a signal gets the yields too,
    // not just a caller that wanted progress reporting.
    const canInterrupt = onProgress !== undefined || signal !== undefined;

    for (const [i, j] of pairs) {
      if (processed >= maxPairs) {
        candidatesDropped = total - processed;
        break;
      }
      // Every 256 pairs: check cancellation, and if we've held the thread for
      // more than a frame's worth of time, report progress and yield so the UI
      // can repaint and stay responsive on large models.
      //
      // 256 rather than the 1024 this used to be, because the interval is what
      // bounds how much work a cancelled run still does, and a candidate pair
      // between two real building elements is not cheap — 1024 of them is a
      // visible stretch of CPU to spend after the caller has given up. The
      // check itself is a property read plus a clock read against ~256 BVH
      // traversals, so the finer cadence costs nothing measurable.
      if ((processed & 0xff) === 0) {
        if (signal?.aborted) {
          throw new DOMException('Clash run aborted', 'AbortError');
        }
        if (canInterrupt && now() - lastYield > YIELD_MS) {
          onProgress?.(processed, total);
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
