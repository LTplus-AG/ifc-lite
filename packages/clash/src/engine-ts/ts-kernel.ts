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

  /**
   * @param yieldMs How long the narrow phase may hold the thread between yields.
   * The default is a few frames, which is what keeps a main-thread run painting.
   * A caller that needs the loop to reach the event loop on a fixed cadence
   * rather than a time-based one (the cancellation tests do) passes `0`.
   */
  constructor(private readonly yieldMs: number = YIELD_MS) {}

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

    // Before the broad phase, not after it: a signal that is already aborted
    // when the rule starts must not buy a full candidate-pair build first.
    // Redundant with the checkpoint at the loop's first iteration, so its only
    // signature is work not done, not a different outcome.
    if (signal?.aborted) throw abortError();

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
      // Every 256 pairs: check cancellation, and if we've held the thread for
      // more than a frame's worth of time, report progress and yield so the UI
      // can repaint and stay responsive on large models.
      //
      // 256 rather than the 1024 this used to be, because the interval is what
      // bounds how much work a cancelled run still does, and a candidate pair
      // between two real building elements is not cheap — 1024 of them is a
      // visible stretch of CPU to spend after the caller has given up. The
      // check itself is a property read plus a clock read against ~256 BVH
      // traversals, so the finer cadence costs nothing measurable (measured
      // interleaved A/B over 14,400 real pairs: within run-to-run noise).
      //
      // Ahead of the `maxPairs` exit below, so a cancelled run reports the
      // cancellation rather than a quietly truncated result — including the
      // degenerate `maxPairs === 0`, where the loop would otherwise break out
      // before ever looking at the signal.
      if ((processed & 0xff) === 0) {
        if (signal?.aborted) throw abortError();
        // `>=`, not `>`: `yieldMs: 0` means "yield at every checkpoint", and
        // with a strict comparison it would mean the opposite the moment the
        // clock did not advance between two checkpoints — which is the common
        // case under a coarse `performance.now()` (browsers clamp it, some to
        // whole milliseconds). At the default interval the two are the same
        // condition; at zero they are opposites.
        if (canInterrupt && now() - lastYield >= this.yieldMs) {
          onProgress?.(processed, total);
          await yieldToEventLoop();
          // Rechecked after the await, because the yield IS the window the
          // abort arrives in: a deadline timer or a UI handler runs during this
          // turn of the event loop and nowhere else. Checking only before it
          // would spend another 256 pairs on a run that had already been
          // cancelled, which is the waste this whole path exists to remove.
          if (signal?.aborted) throw abortError();
          lastYield = now();
        }
      }
      if (processed >= maxPairs) {
        candidatesDropped = total - processed;
        break;
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
        distanceKind: res.distanceKind,
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

/** The rejection a cancelled run produces, spelled the same at every checkpoint. */
function abortError(): DOMException {
  return new DOMException('Clash run aborted', 'AbortError');
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Yield to the event loop so the host can flush React renders / repaint. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
