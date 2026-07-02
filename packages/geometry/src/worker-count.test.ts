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

  it('M-series Pro/Max (10 cores, 16 GB), 1 GB file → 3 workers (bandwidth ceiling)', () => {
    // 10+ cores indicates active cooling (Pro/Max tier), but a `?geomWorkers`
    // A/B sweep on a 722 MB georef model showed geometry wall-time is bound by
    // memory bandwidth, not cores: 3→4→5 workers gave NO geometry speedup and
    // progressively starved the co-running parser. So the >512 MB cap stays 3
    // (the memory budget would allow ~6, but more workers only inflate peak
    // memory and bus contention here).
    const r = computeWorkerCount({
      fileSizeMB: 1024, cores: 10, deviceMemoryGB: 16, totalJobs: 100_000,
    });
    expect(r.count).toBe(3);
    expect(r.reason).toBe('cores');
  });

  it('M-series Max (12 cores), 986 MB file → 4 workers', () => {
    // 12+ cores indicates M3/M4 Pro 12-core or Max — sustained 4 workers
    // safe with active cooling; same bandwidth ceiling holds above that.
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
    // floor so we're not pinned to 2 workers on huge files; the 3-worker
    // bandwidth-ceiling cap binds.
    const r = computeWorkerCount({
      fileSizeMB: 986, cores: 10, deviceMemoryGB: 8, totalJobs: 141_178,
    });
    expect(r.count).toBe(3);
    expect(r.reason).toBe('cores');
  });

  it('fanless 8-core (8 GB), 722 MB file → 2 workers', () => {
    // The fanless MBA tier holds at 2 for >512 MB (throttles hard at 4+).
    const r = computeWorkerCount({
      fileSizeMB: 722, cores: 8, deviceMemoryGB: 8, totalJobs: 70_000,
    });
    expect(r.count).toBe(2);
    expect(r.reason).toBe('cores');
  });

  it('override forces an explicit worker count, bypassing the cores tier', () => {
    // Same 10-core/722 MB host the heuristic caps at 3 — the A/B knob can dial
    // it up (memory budget here allows ~9) or down, for per-host measurement.
    const up = computeWorkerCount({
      fileSizeMB: 722, cores: 10, deviceMemoryGB: 16, totalJobs: 70_000,
      workerCountOverride: 7,
    });
    expect(up.count).toBe(7);
    const down = computeWorkerCount({
      fileSizeMB: 722, cores: 10, deviceMemoryGB: 16, totalJobs: 70_000,
      workerCountOverride: 2,
    });
    expect(down.count).toBe(2);
  });

  it('override is still clamped by the memory budget (cannot OOM)', () => {
    // 8 GB fanless host, 722 MB file: memoryCap ≈ 4. An override of 12 is
    // clipped to the memory bound, not honoured blindly.
    const r = computeWorkerCount({
      fileSizeMB: 722, cores: 8, deviceMemoryGB: 8, totalJobs: 70_000,
      workerCountOverride: 12,
    });
    expect(r.count).toBeLessThanOrEqual(4);
    expect(r.reason).toBe('memory');
  });

  it('override is also clamped by totalJobs and maxWorkers', () => {
    const fewJobs = computeWorkerCount({
      fileSizeMB: 50, cores: 16, deviceMemoryGB: 32, totalJobs: 3,
      workerCountOverride: 8,
    });
    expect(fewJobs.count).toBe(3);
    expect(fewJobs.reason).toBe('jobs');
    const capped = computeWorkerCount({
      fileSizeMB: 50, cores: 16, deviceMemoryGB: 32, totalJobs: 1000,
      workerCountOverride: 10, maxWorkers: 6,
    });
    expect(capped.count).toBe(6);
    expect(capped.reason).toBe('max');
  });

  it('undefined override leaves the heuristic untouched', () => {
    const withUndef = computeWorkerCount({
      fileSizeMB: 1024, cores: 10, deviceMemoryGB: 16, totalJobs: 100_000,
      workerCountOverride: undefined,
    });
    expect(withUndef.count).toBe(3);
    expect(withUndef.reason).toBe('cores');
  });

  it('small compute-bound file (20 MB, 10 cores) → near-full cores (cores-2)', () => {
    // 170_KM-class: a small, transient, COMPUTE-bound load (boolean-clipped
    // steel) — not the sustained bandwidth-bound big-file regime the per-core
    // caps guard. On a 10-core active-cooled machine it gets cores-2 = 8 workers
    // (was capped at 4, leaving 6 cores idle on CSG-bound geometry). Memory is
    // a non-issue at 20 MB so the memoryCap doesn't bind. (Within the narrowed
    // <= SMALL_FILE_MB (24) fast-path band; per-worker re-decode cost is low here.)
    const r = computeWorkerCount({
      fileSizeMB: 20, cores: 10, deviceMemoryGB: 16, totalJobs: 25_000,
    });
    expect(r.count).toBe(8);
    expect(r.reason).toBe('cores');
  });

  it('medium heavy-tail file (34 MB, 10 cores) → per-core cap (4), not the small-file bump', () => {
    // Above SMALL_FILE_MB (24): a 10-core browser worker-count sweep showed the
    // old 8-64 MB cores-2 band ran SLOWER than 4 workers on decode-/heavy-tail-
    // bound models (34 MB: 7.2s@8 → 5.7s@4; 54 MB: 14.4s@8 → ~11s@4) at ~2x peak
    // memory, because each worker re-decodes the file into its own WASM heap. So
    // 24-64 MB now falls through to the per-core bandwidth cap (4 on 10-core).
    const r = computeWorkerCount({
      fileSizeMB: 34, cores: 10, deviceMemoryGB: 16, totalJobs: 6_000,
    });
    expect(r.count).toBe(4);
    expect(r.reason).toBe('cores');
  });

  it('larger decode-bound file (54 MB, 10 cores) → per-core cap (4), not cores-2', () => {
    // Guard against re-widening the small-file band over 24 MB: 54 MB is a classic
    // decode-bound model (few big elements) where 8 workers thrash memory (882 MB
    // peak) and run slower than 4. Must stay 4 on a 10-core host.
    const r = computeWorkerCount({
      fileSizeMB: 54, cores: 10, deviceMemoryGB: 16, totalJobs: 5_632,
    });
    expect(r.count).toBe(4);
    expect(r.reason).toBe('cores');
  });

  it('tiny file (4 MB, 10 cores) stays on the conservative cap (4), not the bump', () => {
    // Below MIN_PARALLEL_MB (8): a small/simple model loads fast on a few
    // workers; the caller spawns from a file-size proxy before real job counts
    // exist, so we must not pre-spawn workers that would sit idle. (#1258 P2)
    const r = computeWorkerCount({
      fileSizeMB: 4, cores: 10, deviceMemoryGB: 16, totalJobs: 400,
    });
    expect(r.count).toBe(4);
    expect(r.reason).toBe('cores');
  });

  it('big file on the same 10-core host still holds the bandwidth cap (3)', () => {
    // The small-file fast path must NOT lift the >512 MB bandwidth ceiling.
    const r = computeWorkerCount({
      fileSizeMB: 722, cores: 10, deviceMemoryGB: 16, totalJobs: 70_000,
    });
    expect(r.count).toBe(3);
    expect(r.reason).toBe('cores');
  });

  it('small file on an 8-core fanless host keeps the conservative cap (no thermal risk taken)', () => {
    // The small-file path is gated to 10+ cores (active cooling); fanless
    // 8-core stays on its existing tier.
    const r = computeWorkerCount({
      fileSizeMB: 20, cores: 8, deviceMemoryGB: 8, totalJobs: 25_000,
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
