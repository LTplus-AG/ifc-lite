/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `remeshOnApi` bookkeeping (#6232 WP1): job filtering, style-wire narrowing,
 * and releasing the pre-pass cache on every exit. The engine is a scripted
 * stand-in here; real meshing parity is `scripts/lib/wasm-remesh-contracts.mjs`.
 */

import { describe, expect, it } from 'vitest';
import type { MeshCollection } from '@ifc-lite/wasm';
import {
  applyRemeshConfig,
  filterJobsToTargets,
  filterStyleWire,
  remeshOnApi,
  type RemeshApi,
  type RemeshRequest,
} from './remesh-core.js';

function scriptedApi(jobs: number[], batch: () => MeshCollection): RemeshApi & { calls: string[]; batchJobs: Uint32Array[] } {
  const calls: string[] = [];
  const batchJobs: Uint32Array[] = [];
  return {
    calls,
    batchJobs,
    buildPrePassOnce: () => {
      calls.push('prepass');
      return {
        jobs: Uint32Array.from(jobs), totalJobs: jobs.length / 3, unitScale: 1, needsShift: false,
        voidKeys: new Uint32Array(), voidCounts: new Uint32Array(), voidValues: new Uint32Array(),
        styleIds: new Uint32Array(), styleColors: new Uint8Array(),
      };
    },
    processGeometryBatch: (_data, jobsFlat) => {
      calls.push('batch');
      batchJobs.push(jobsFlat);
      return batch();
    },
    clearPrePassCache: () => { calls.push('clear'); },
    setMergeLayers: (on) => { calls.push(`mergeLayers=${on}`); },
    setTessellationQuality: (level) => { calls.push(`quality=${level}`); },
    setSkipSmallCuts: (on) => { calls.push(`skipSmallCuts=${on}`); },
    setRectParamFastPath: (on) => { calls.push(`rectParam=${on}`); },
  };
}

const emptyCollection = (): MeshCollection => ({ length: 0, diagnostics: { totalCsgFailures: 2 }, free: () => {} }) as unknown as MeshCollection;

const REQUEST: RemeshRequest = {
  buffer: new Uint8Array(),
  targets: Uint32Array.of(7),
  frame: { x: 1, y: 2, z: 3, needsShift: true },
  styleIds: new Uint32Array(),
  styleColors: new Uint8Array(),
};

describe('remesh core (#6232)', () => {
  it('keeps only the target job triplets', () => {
    expect(Array.from(filterJobsToTargets(Uint32Array.of(5, 0, 10, 7, 10, 20, 9, 20, 30), Uint32Array.of(7, 9))))
      .toEqual([7, 10, 20, 9, 20, 30]);
  });

  it('narrows the style wire to the kept ids, colours travelling with their id', () => {
    const narrowed = filterStyleWire(Uint32Array.of(1, 2, 3), Uint8Array.of(1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3), new Set([3, 1]));
    expect(Array.from(narrowed.styleIds)).toEqual([1, 3]);
    expect(Array.from(narrowed.styleColors)).toEqual([1, 1, 1, 1, 3, 3, 3, 3]);
  });

  it('meshes only the targets and reports the batch CSG failures', () => {
    const api = scriptedApi([5, 0, 10, 7, 10, 20], emptyCollection);
    const result = remeshOnApi(api, REQUEST);
    expect(Array.from(api.batchJobs[0])).toEqual([7, 10, 20]);
    expect(result.csgFailures).toBe(2);
    expect(api.calls).toEqual(['prepass', 'batch', 'clear']);
  });

  it('releases the pre-pass cache when there is nothing to mesh and when meshing throws', () => {
    const none = scriptedApi([5, 0, 10], emptyCollection);
    expect(remeshOnApi(none, REQUEST).meshes).toEqual([]);
    expect(none.calls).toEqual(['prepass', 'clear']);

    const throwing = scriptedApi([7, 0, 10], () => { throw new Error('trap'); });
    expect(() => remeshOnApi(throwing, REQUEST)).toThrow('trap');
    expect(throwing.calls).toEqual(['prepass', 'batch', 'clear']);
  });

  it('applies every config field', () => {
    const api = scriptedApi([], emptyCollection);
    applyRemeshConfig(api, { mergeLayers: true, tessellationQuality: 'high', skipSmallCuts: true, rectParamFastPath: false });
    expect(api.calls).toEqual(['mergeLayers=true', 'quality=high', 'skipSmallCuts=true', 'rectParam=false']);
  });
});
