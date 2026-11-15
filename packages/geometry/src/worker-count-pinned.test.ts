/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pins the worker planner's output over a device/file grid (#10264 review).
 * The pre-pass overlap gate (prepass-overlap-gate.ts) must not change any
 * plan: below 512 MiB the load path is unchanged, and at and above it the
 * pool only starts later. Values were generated from the planner on main at
 * 5db30f9a6b. A planner change that moves any cell is a separate decision and
 * re-pins this table on purpose. Covers the cells the review named: a
 * Holter-size file (169 / 177 MiB) on a device reporting 2 GB with 4 and 8
 * cores (2 workers), 500–511 MiB on 4 GB with 4 and 8 cores (2 workers), and
 * the 511 / 512 / 513 MiB edge.
 */

import { describe, expect, it } from 'vitest';
import { computeWorkerCount } from './worker-count.js';

const SIZES_MB = [20, 169, 177, 343, 500, 511, 512, 513, 600, 1145];

/** [deviceMemoryGB, cores, counts per SIZES_MB] */
const PINNED: ReadonlyArray<[number, number, string]> = [
  [1, 2, '1,1,1,1,1,1,1,1,1,1'],
  [1, 4, '1,1,1,1,1,1,1,1,1,1'],
  [1, 8, '1,1,1,1,1,1,1,1,1,1'],
  [1, 10, '8,4,4,4,4,4,4,3,3,3'],
  [1, 12, '8,5,5,5,5,5,5,4,4,4'],
  [1, 16, '8,8,8,8,8,8,8,4,4,4'],
  [2, 2, '1,1,1,1,1,1,1,1,1,1'],
  [2, 4, '2,2,2,1,1,1,1,1,1,1'],
  [2, 8, '2,2,2,1,1,1,1,1,1,1'],
  [2, 10, '8,4,4,4,4,4,4,3,3,3'],
  [2, 12, '8,5,5,5,5,5,5,4,4,4'],
  [2, 16, '8,8,8,8,8,8,8,4,4,4'],
  [4, 2, '1,1,1,1,1,1,1,1,1,1'],
  [4, 4, '2,2,2,2,2,2,2,2,1,1'],
  [4, 8, '2,2,2,2,2,2,2,2,1,1'],
  [4, 10, '8,4,4,4,4,4,4,3,3,3'],
  [4, 12, '8,5,5,5,5,5,5,4,4,4'],
  [4, 16, '8,8,8,8,8,8,8,4,4,4'],
  [8, 2, '1,1,1,1,1,1,1,1,1,1'],
  [8, 4, '2,2,2,2,2,2,2,2,2,1'],
  [8, 8, '3,3,3,3,3,3,3,2,2,1'],
  [8, 10, '8,4,4,4,4,4,4,3,3,3'],
  [8, 12, '8,5,5,5,5,5,5,4,4,4'],
  [8, 16, '8,8,8,8,8,8,8,4,4,4'],
];

describe('computeWorkerCount pinned grid (#10264: the overlap gate changes no plan)', () => {
  it.each(PINNED)('%i GB, %i cores', (deviceMemoryGB, cores, expected) => {
    const counts = SIZES_MB.map((fileSizeMB) => computeWorkerCount({
      fileSizeMB, cores, deviceMemoryGB, totalJobs: Math.ceil(fileSizeMB * 100),
    }).count);
    expect(counts.join(',')).toBe(expected);
  });
});
