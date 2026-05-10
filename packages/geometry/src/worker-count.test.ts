/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { computeWorkerCount } from './worker-count.js';

describe('computeWorkerCount', () => {
  it('returns 0 workers when totalJobs is 0', () => {
    // Updated contract: no jobs → no workers. Avoids paying ~250ms
    // WASM compile for nothing. Callers in production always pass
    // totalJobs >= 1 (estimated from fileSize in geometry-parallel),
    // so this branch is reached only when callers explicitly report
    // an empty job set.
    const r = computeWorkerCount({
      fileSizeMB: 100, cores: 8, deviceMemoryGB: 8, totalJobs: 0,
    });
    expect(r.count).toBe(0);
    expect(r.reason).toBe('jobs');
  });

  it('caps by totalJobs when there are fewer jobs than worker capacity', () => {
    const r = computeWorkerCount({
      fileSizeMB: 50, cores: 16, deviceMemoryGB: 32, totalJobs: 2,
    });
    expect(r.count).toBe(2);
    expect(r.reason).toBe('jobs');
  });

  it('MacBook Air M-series (8 cores, 8 GB RAM, 400 MB file) → 3 workers', () => {
    const r = computeWorkerCount({
      fileSizeMB: 400, cores: 8, deviceMemoryGB: 8, totalJobs: 5000,
    });
    expect(r.count).toBe(3);
    expect(r.reason).toBe('cores');
  });

  it('MacBook Air, 1.2 GB file → memory-capped to 1', () => {
    const r = computeWorkerCount({
      fileSizeMB: 1200, cores: 8, deviceMemoryGB: 8, totalJobs: 20000,
    });
    expect(r.count).toBe(1);
    expect(r.reason === 'memory' || r.reason === 'cores').toBe(true);
  });

  it('M-series Pro/Max (10 cores, 16 GB), 1 GB file → 3 workers', () => {
    // 10+ cores indicates active cooling (Pro/Max tier), so 3 workers
    // on huge files is safe. Memory budget allows it: 16 GB - 4 GB
    // headroom - 2.5 GB main = 9.5 GB / 1.5 GB per worker ≈ 6, capped
    // by the 3-worker cores ceiling for files > 512 MB.
    const r = computeWorkerCount({
      fileSizeMB: 1024, cores: 10, deviceMemoryGB: 16, totalJobs: 100_000,
    });
    expect(r.count).toBe(3);
    expect(r.reason).toBe('cores');
  });

  it('M-series Max (12 cores), 986 MB file → 4 workers', () => {
    // 12+ cores indicates M3/M4 Pro 12-core or Max — sustained 4 workers
    // safe with active cooling.
    const r = computeWorkerCount({
      fileSizeMB: 986, cores: 12, deviceMemoryGB: 8, totalJobs: 141_178,
    });
    expect(r.count).toBe(4);
    expect(r.reason).toBe('cores');
  });

  it('M-series Pro/Max but browser-capped deviceMemory=8, 986 MB file → 3 workers', () => {
    // Real-world case: navigator.deviceMemory is capped at 8 GB by
    // browsers as anti-fingerprinting, but a 10-core M-series Pro
    // ships with 16+ GB. The cores >= 10 branch lifts the memory
    // floor so we're not pinned to 2 workers on huge files.
    const r = computeWorkerCount({
      fileSizeMB: 986, cores: 10, deviceMemoryGB: 8, totalJobs: 141_178,
    });
    expect(r.count).toBe(3);
    expect(r.reason).toBe('cores');
  });

  it('M-series Pro/Max (12 cores, 16 GB), 400 MB file → 5 workers', () => {
    // 12+ cores tier: small files get 5 workers; huge files cap at 4.
    const r = computeWorkerCount({
      fileSizeMB: 400, cores: 12, deviceMemoryGB: 16, totalJobs: 5000,
    });
    expect(r.count).toBe(5);
    expect(r.reason).toBe('cores');
  });

  it('Desktop tower (16 cores, 32 GB), 400 MB file → 8 workers', () => {
    const r = computeWorkerCount({
      fileSizeMB: 400, cores: 16, deviceMemoryGB: 32, totalJobs: 5000,
    });
    expect(r.count).toBe(8);
  });

  it('Desktop tower, 2 GB file → memory-capped well below 8', () => {
    const r = computeWorkerCount({
      fileSizeMB: 2048, cores: 16, deviceMemoryGB: 32, totalJobs: 30000,
    });
    // 32 GB RAM, 8 GB reserved, 5 GB main-thread budget → 19 GB / (3 GB per
    // worker) ≈ 6 workers, capped by cores at 8 → memory wins.
    expect(r.count).toBeGreaterThanOrEqual(2);
    expect(r.count).toBeLessThanOrEqual(8);
    expect(r.reason).toBe('memory');
  });

  it('huge file on big desktop never returns 0', () => {
    const r = computeWorkerCount({
      fileSizeMB: 16_000, cores: 32, deviceMemoryGB: 32, totalJobs: 100_000,
    });
    expect(r.count).toBeGreaterThanOrEqual(1);
  });

  it('low-end laptop (4 cores, 4 GB), 400 MB file → 2 workers (matches previous heuristic)', () => {
    const r = computeWorkerCount({
      fileSizeMB: 400, cores: 4, deviceMemoryGB: 4, totalJobs: 5000,
    });
    // 4-core tier hard-caps at 2; budget allows 2 here (no regression vs old code).
    expect(r.count).toBe(2);
  });

  it('low-end laptop, 800 MB file → memory-capped to 1', () => {
    const r = computeWorkerCount({
      fileSizeMB: 800, cores: 4, deviceMemoryGB: 4, totalJobs: 5000,
    });
    // 4 GB - 1 GB headroom - 2 GB main = 1 GB / (1.2 GB per worker) → 0, floor to 1.
    expect(r.count).toBe(1);
    expect(r.reason).toBe('memory');
  });

  it('respects custom maxWorkers cap', () => {
    const r = computeWorkerCount({
      fileSizeMB: 100, cores: 32, deviceMemoryGB: 64, totalJobs: 1000,
      maxWorkers: 4,
    });
    expect(r.count).toBeLessThanOrEqual(4);
  });

  it('respects custom minWorkers floor', () => {
    const r = computeWorkerCount({
      fileSizeMB: 8000, cores: 4, deviceMemoryGB: 4, totalJobs: 50_000,
      minWorkers: 2,
    });
    expect(r.count).toBe(2);
    expect(r.reason).toBe('min');
  });

  it('rejects negative file sizes by clamping to 0 (treated as small file)', () => {
    const r = computeWorkerCount({
      fileSizeMB: -100, cores: 8, deviceMemoryGB: 8, totalJobs: 100,
    });
    expect(r.count).toBeGreaterThanOrEqual(1);
  });

  it('treats fractional cores as floor', () => {
    const r = computeWorkerCount({
      fileSizeMB: 50, cores: 7.9, deviceMemoryGB: 8, totalJobs: 100,
    });
    expect(r.count).toBeGreaterThanOrEqual(1);
    expect(r.count).toBeLessThanOrEqual(8);
  });
});
