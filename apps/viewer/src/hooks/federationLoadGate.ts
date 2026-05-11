/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Process-wide gate for federation `addModel` calls.
 *
 * Two concurrent sequences (e.g. user drag-drops a second batch before the
 * first has finished) used to multiply worker count and OOM the tab on
 * large files. The geometry processor already caps workers per load by
 * memory budget (`packages/geometry/src/worker-count.ts`) — but two loads
 * each at the cap still exceed the budget together.
 *
 * This gate enforces a simple invariant: the *sum* of all in-flight loads
 * fits under the same memory budget the worker count uses. When it
 * doesn't, the new load waits in a FIFO queue until an in-flight load
 * releases. Single-file drops never wait — only concurrent ones do.
 *
 * Pure-JS module, no React. Importable from anywhere; the singleton state
 * lives on the module.
 */

interface PendingAcquire {
  fileSizeMB: number;
  resolve: () => void;
}

interface ActiveLoad {
  id: number;
  fileSizeMB: number;
}

let nextId = 1;
const active: Map<number, ActiveLoad> = new Map();
const queue: PendingAcquire[] = [];

/**
 * Memory cost estimate per concurrent load, in MB. Mirrors the worker-count
 * formula at a coarser grain: input buffer (1×) + per-worker WASM
 * (1.5×, with worker cap already applied) + accumulating meshes (1.5×) ≈ 4×.
 */
const COST_PER_FILE_MULTIPLIER = 4;

function getDeviceMemoryGB(): number {
  if (typeof navigator === 'undefined') return 8;
  const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  return typeof dm === 'number' && dm > 0 ? dm : 8;
}

function getAvailableBudgetMB(): number {
  const totalRAMmb = getDeviceMemoryGB() * 1024;
  // Same headroom logic as worker-count.ts.
  const reservedHeadroomMB = Math.max(1024, totalRAMmb * 0.25);
  return Math.max(512, totalRAMmb - reservedHeadroomMB);
}

function activeCostMB(): number {
  let sum = 0;
  for (const load of active.values()) {
    sum += load.fileSizeMB * COST_PER_FILE_MULTIPLIER;
  }
  return sum;
}

function tryAdmit(): void {
  while (queue.length > 0) {
    const head = queue[0];
    const wouldCost = head.fileSizeMB * COST_PER_FILE_MULTIPLIER;
    const available = getAvailableBudgetMB() - activeCostMB();
    // Always admit when nothing is active (single file should never wait).
    if (active.size === 0 || wouldCost <= available) {
      queue.shift();
      head.resolve();
      // Loop continues — we may be able to admit several queued small loads
      // after a single large load releases.
      continue;
    }
    break;
  }
}

/**
 * Acquire a slot for a load of the given estimated size. Resolves
 * immediately when budget allows; otherwise queues FIFO and resolves when
 * an active load releases. Returns the slot id to pass to `release`.
 */
export async function acquireFederationLoadSlot(fileSizeMB: number): Promise<number> {
  const id = nextId++;
  const cost = Math.max(0, fileSizeMB) * COST_PER_FILE_MULTIPLIER;
  const available = getAvailableBudgetMB() - activeCostMB();

  if (active.size === 0 || cost <= available) {
    active.set(id, { id, fileSizeMB });
    return id;
  }

  await new Promise<void>((resolve) => {
    queue.push({ fileSizeMB, resolve });
  });
  active.set(id, { id, fileSizeMB });
  return id;
}

/**
 * Release a previously-acquired slot. Wakes the next queued load(s) that
 * fit in the freed budget.
 */
export function releaseFederationLoadSlot(id: number): void {
  active.delete(id);
  tryAdmit();
}

/** Internal — for tests only. Resets state. */
export function __resetFederationLoadGate(): void {
  active.clear();
  queue.length = 0;
  nextId = 1;
}

/** Internal — for tests/diagnostics. */
export function __getFederationLoadGateStats(): { activeCount: number; queuedCount: number; activeCostMB: number } {
  return {
    activeCount: active.size,
    queuedCount: queue.length,
    activeCostMB: activeCostMB(),
  };
}
