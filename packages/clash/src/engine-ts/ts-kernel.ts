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

  detectRule(
    elements: ClashElement[],
    groupAIdx: number[],
    groupBIdx: number[] | null,
    rule: import('../types.js').ClashRule,
    tolerance: number,
    maxPairs: number,
    signal?: AbortSignal,
  ): RuleDetection {
    const groupA = groupAIdx.map((i) => elements[i]);
    const groupB = groupBIdx ? groupBIdx.map((i) => elements[i]) : null;
    const resolveB = groupB ?? groupA;
    const resolveBIdx = groupBIdx ?? groupAIdx;
    const margin = Math.max(tolerance, rule.clearance ?? 0);

    const pairs = candidatePairs(groupA, groupB, margin);
    const records: NarrowRecord[] = [];
    let processed = 0;
    let candidatesDropped = 0;

    for (const [i, j] of pairs) {
      if (processed >= maxPairs) {
        candidatesDropped = pairs.length - processed;
        break;
      }
      // Honor cancellation mid-rule for large candidate sets.
      if (signal?.aborted && (processed & 0x3ff) === 0) {
        throw new DOMException('Clash run aborted', 'AbortError');
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

    return { records, candidatesProcessed: processed, candidatesDropped };
  }
}
