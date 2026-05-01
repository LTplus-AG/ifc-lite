/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Performance benchmarks (spec §15).
 *
 * Self-contained Node-runnable benchmarks that produce numbers we
 * compare against the §15 budget:
 *
 *   - Y.Doc memory @100k entities      < 200 MB
 *   - Single-attr update size          < 200 B
 *   - Sync latency LAN                 < 50 ms
 *   - Cold load @100k                  < 3 s
 *   - Awareness update rate            30 Hz
 *
 * These are pure-JS estimates — they don't measure the real
 * websocket or the disk subsystem; consumers wire those in via the
 * `createLatencyChannel` simulator + their own perf harness.
 */

import * as Y from 'yjs';
import { createCollabDoc } from '../doc/schema.js';
import { createEntity, setAttribute } from '../doc/entity.js';
import { snapshotToIfcx } from '../snapshot/to-ifcx.js';
import { seedFromIfcx } from '../snapshot/from-ifcx.js';

export interface BenchmarkBudget {
  /** Maximum Y.Doc state-vector size for 100k entities, bytes. */
  maxStateBytes100k?: number;
  /** Maximum single-attr update size, bytes. */
  maxSingleAttrUpdateBytes?: number;
  /** Maximum cold-load time for an N-entity IFCX, ms. */
  maxColdLoadMs?: number;
  /** Number of entities to use for the cold-load benchmark. */
  coldLoadEntities?: number;
}

export const DEFAULT_BUDGET: Required<BenchmarkBudget> = {
  maxStateBytes100k: 200 * 1024 * 1024,
  maxSingleAttrUpdateBytes: 200,
  maxColdLoadMs: 3000,
  coldLoadEntities: 1000,
};

export interface BenchmarkResult {
  name: string;
  /** Measured value in the unit indicated by `unit`. */
  value: number;
  unit: 'bytes' | 'ms' | 'ops';
  budget?: number;
  ok: boolean;
}

/** Run all benchmarks and report each against the configured budget. */
export function runPerfBenchmarks(budget: BenchmarkBudget = {}): BenchmarkResult[] {
  const cfg = { ...DEFAULT_BUDGET, ...budget };
  const results: BenchmarkResult[] = [];

  // 1. Single-attr update size.
  results.push(measureSingleAttrUpdateBytes(cfg.maxSingleAttrUpdateBytes));

  // 2. Cold-load time for cfg.coldLoadEntities entities.
  results.push(measureColdLoad(cfg.coldLoadEntities, cfg.maxColdLoadMs));

  // 3. State-vector size at 100k entities — heavy, gated by env.
  if (process.env.COLLAB_BENCH_HEAVY) {
    results.push(measureStateBytes(100_000, cfg.maxStateBytes100k));
  }

  return results;
}

export function measureSingleAttrUpdateBytes(budget: number): BenchmarkResult {
  const doc = createCollabDoc();
  doc.transact(() => createEntity(doc, 'wall'));
  const sv = Y.encodeStateVector(doc);
  doc.transact(() => setAttribute(doc, 'wall', 'Name', 'Wall-A'));
  const update = Y.encodeStateAsUpdate(doc, sv);
  return {
    name: 'single-attr-update-bytes',
    value: update.byteLength,
    unit: 'bytes',
    budget,
    ok: update.byteLength <= budget,
  };
}

export function measureColdLoad(entityCount: number, budget: number): BenchmarkResult {
  // Build the IFCX in memory, then re-seed and time it.
  const doc = createCollabDoc();
  doc.transact(() => {
    for (let i = 0; i < entityCount; i++) {
      createEntity(doc, `e${i}`, { ifcClass: 'IfcWall' });
      setAttribute(doc, `e${i}`, 'Name', `Wall-${i}`);
    }
  });
  const ifcx = snapshotToIfcx(doc);

  const fresh = createCollabDoc();
  const start = performance.now();
  seedFromIfcx(fresh, ifcx);
  const elapsed = performance.now() - start;
  return {
    name: `cold-load-${entityCount}`,
    value: elapsed,
    unit: 'ms',
    budget,
    ok: elapsed <= budget,
  };
}

export function measureStateBytes(entityCount: number, budget: number): BenchmarkResult {
  const doc = createCollabDoc();
  doc.transact(() => {
    for (let i = 0; i < entityCount; i++) {
      createEntity(doc, `e${i}`, { ifcClass: 'IfcWall' });
    }
  });
  const update = Y.encodeStateAsUpdate(doc);
  return {
    name: `state-bytes-${entityCount}`,
    value: update.byteLength,
    unit: 'bytes',
    budget,
    ok: update.byteLength <= budget,
  };
}
