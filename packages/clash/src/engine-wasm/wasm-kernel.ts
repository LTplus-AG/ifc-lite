/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ClashSession } from '@ifc-lite/wasm';
import type { AABB, ClashElement, ClashRule, ClashStatus, Mat4, Vec3 } from '../types.js';
import type { ClashKernel, NarrowRecord, RuleDetection } from '../engine-ts/kernel.js';

const STATUS: ClashStatus[] = ['hard', 'clearance', 'touch'];

/** Transform a point by a column-major 4x4 matrix. */
function applyMat4(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/**
 * WASM geometry kernel: ingests element geometry into a Rust `ClashSession`
 * (flat arenas) and runs each rule's broad + narrow phase in Rust. Produces the
 * same `NarrowRecord`s as `TsKernel` — the orchestrator above is identical, so
 * the two engines are differentially comparable.
 *
 * Any per-element `transform` is baked into the world-space arena here, because
 * the Rust kernel consumes world-space geometry directly (no transform path).
 */
export class WasmKernel implements ClashKernel {
  constructor(private readonly session: ClashSession) {}

  prepare(elements: ClashElement[]): void {
    const positions: number[] = [];
    const posRanges: number[] = [];
    const indices: number[] = [];
    const idxRanges: number[] = [];
    const aabbs: number[] = [];

    for (const el of elements) {
      const posOffset = positions.length;
      const t = el.transform;
      if (t) {
        for (let i = 0; i + 2 < el.positions.length; i += 3) {
          const [x, y, z] = applyMat4(t, el.positions[i], el.positions[i + 1], el.positions[i + 2]);
          positions.push(x, y, z);
        }
      } else {
        for (let i = 0; i < el.positions.length; i += 1) {
          positions.push(el.positions[i]);
        }
      }
      posRanges.push(posOffset, el.positions.length);

      const idxOffset = indices.length;
      for (let i = 0; i < el.indices.length; i += 1) {
        indices.push(el.indices[i]);
      }
      idxRanges.push(idxOffset, el.indices.length);

      aabbs.push(
        el.bounds.min[0], el.bounds.min[1], el.bounds.min[2],
        el.bounds.max[0], el.bounds.max[1], el.bounds.max[2],
      );
    }

    this.session.ingest(
      Float32Array.from(positions),
      Uint32Array.from(posRanges),
      Uint32Array.from(indices),
      Uint32Array.from(idxRanges),
      Float32Array.from(aabbs),
    );
  }

  detectRule(
    _elements: ClashElement[],
    groupAIdx: number[],
    groupBIdx: number[] | null,
    rule: ClashRule,
    tolerance: number,
    _maxPairs: number,
    signal?: AbortSignal,
  ): RuleDetection {
    // The WASM backend runs every candidate pair in Rust, so it does NOT enforce
    // the run-global maxCandidatePairs cap — that cap is a TS-engine guardrail.
    if (signal?.aborted) {
      throw new DOMException('Clash run aborted', 'AbortError');
    }
    const mode = rule.mode === 'clearance' ? 1 : 0;
    const clearance = rule.clearance ?? 0;
    const reportTouch = rule.reportTouch ?? false;
    const groupA = Uint32Array.from(groupAIdx);
    const groupB = groupBIdx ? Uint32Array.from(groupBIdx) : new Uint32Array(0);

    const res = this.session.runRule(groupA, groupB, mode, tolerance, clearance, reportTouch);
    const records: NarrowRecord[] = [];
    try {
      // Each getter returns a fresh copy; read once into locals.
      const a = res.a;
      const b = res.b;
      const status = res.status;
      const distance = res.distance;
      const points = res.points;
      const bounds = res.bounds;
      for (let k = 0; k < a.length; k += 1) {
        const bnds: AABB = {
          min: [bounds[k * 6], bounds[k * 6 + 1], bounds[k * 6 + 2]],
          max: [bounds[k * 6 + 3], bounds[k * 6 + 4], bounds[k * 6 + 5]],
        };
        records.push({
          a: a[k],
          b: b[k],
          status: STATUS[status[k]] ?? 'hard',
          distance: distance[k],
          point: [points[k * 3], points[k * 3 + 1], points[k * 3 + 2]],
          bounds: bnds,
        });
      }
    } finally {
      // Free the wasm-side result even if the mapping above throws.
      res.free();
    }
    return { records, candidatesProcessed: 0, candidatesDropped: 0 };
  }

  dispose(): void {
    this.session.free();
  }
}
