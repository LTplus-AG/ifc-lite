/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { frozenStallPhase, GateTracker, preWorkerPhaseBoundMs, preWorkerPhaseFailureDiagnostics } from './stall-phase.js';

/**
 * Issue #4902: production "Geometry stream stalled... Last rendered meshes: 0"
 * reports cannot be told apart by which pre-worker phase was stuck. These pin
 * the pure logic `geometry-parallel.ts` wires up: {@link GateTracker}'s phase
 * precedence, the bound rule, and the diagnostics fragment shape.
 */
describe('GateTracker.getStallPhase (#4902)', () => {
  it('starts at prepass when the sharded scan never ran', () => {
    expect(new GateTracker().getStallPhase()).toBe('prepass');
  });

  it('reports shard-scan while the sharded entity-index scan is outstanding', () => {
    const t = new GateTracker();
    t.markShardScanStarted();
    expect(t.getStallPhase()).toBe('shard-scan');
  });

  it('moves to styles-gate once the pre-pass and the shard scan are both done', () => {
    const t = new GateTracker();
    t.markShardScanStarted();
    t.markShardScanDone();
    t.markPrepassDone();
    expect(t.getStallPhase()).toBe('styles-gate');
  });

  it('moves to entity-index-gate once styles land but the index has not', () => {
    const t = new GateTracker();
    t.markPrepassDone();
    t.markStylesReceived();
    expect(t.getStallPhase()).toBe('entity-index-gate');
  });

  it('reports workers once every pre-worker gate has opened', () => {
    const t = new GateTracker();
    t.markPrepassDone();
    t.markStylesReceived();
    t.markEntityIndexReceived();
    expect(t.getStallPhase()).toBe('workers');
  });

  it('attributes a stall to the EARLIEST open gate — a stuck shard scan blocks everything after it', () => {
    const t = new GateTracker();
    t.markShardScanStarted();
    // Nothing downstream of the shard scan can have opened yet in practice,
    // but even if it somehow had, the shard scan is still the root cause.
    t.markStylesReceived();
    t.markEntityIndexReceived();
    expect(t.getStallPhase()).toBe('shard-scan');
  });
});

describe('frozenStallPhase (#4979 review)', () => {
  it('returns the exact phase it was given, every time it is called', () => {
    const reader = frozenStallPhase('entity-index-gate');
    expect(reader()).toBe('entity-index-gate');
    expect(reader()).toBe('entity-index-gate');
  });

  it('is a plain closure over its argument only — no GateTracker involved', () => {
    // The point of a frozen reader (vs. `() => gateTracker.getStallPhase()`)
    // is that it does not need one at all: two independent snapshots of the
    // SAME phase are unrelated functions, not two views onto shared state.
    const a = frozenStallPhase('workers');
    const b = frozenStallPhase('workers');
    expect(a).not.toBe(b);
    expect(a()).toBe(b());
  });
});

describe('preWorkerPhaseBoundMs (#4902)', () => {
  it('has a floor for a zero/unknown file size', () => {
    expect(preWorkerPhaseBoundMs(0)).toBe(15_000);
  });

  it('scales with file size, at half the browser first-batch watchdog rate', () => {
    expect(preWorkerPhaseBoundMs(100)).toBe(15_000 + 100 * 30);
  });

  it('never returns below the floor for a negative input', () => {
    expect(preWorkerPhaseBoundMs(-50)).toBe(15_000);
  });
});

describe('preWorkerPhaseFailureDiagnostics (#4902)', () => {
  it('carries exactly one typed failure and no fabricated CSG activity', () => {
    const d = preWorkerPhaseFailureDiagnostics('shard-scan-timeout');
    expect(d.failuresByReason).toEqual([{ reason: 'shard-scan-timeout', count: 1 }]);
    expect(d.totalCsgFailures).toBe(0);
    expect(d.classification.total).toBe(0);
    expect(d.worstHosts).toEqual([]);
  });
});
