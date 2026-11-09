/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Audit P6: the gate's own contract, independent of `IfcLiteBridge` (whose
 * failure path also invalidates, which would mask a gate that never forgets a
 * failed attempt).
 */

import { describe, expect, it } from 'vitest';
import { BridgeInitGate } from './bridge-init-gate.js';

describe('BridgeInitGate (audit P6)', () => {
  it('P6: forgets a failed attempt on its own, so the next run() retries', async () => {
    const gate = new BridgeInitGate();
    let starts = 0;
    await expect(gate.run(async () => { starts += 1; throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(gate.run(async () => { starts += 1; })).resolves.toBeUndefined();
    expect(starts).toBe(2);
    expect(gate.isReady()).toBe(true);
  });

  it('P6: a superseded attempt settling late does not drop the attempt that replaced it', async () => {
    const gate = new BridgeInitGate();
    let releaseStale!: () => void;
    let releaseFresh!: () => void;
    let starts = 0;
    const stale = gate.run(() => { starts += 1; return new Promise<void>((r) => { releaseStale = r; }); });
    gate.invalidate();
    const fresh = gate.run(() => { starts += 1; return new Promise<void>((r) => { releaseFresh = r; }); });
    releaseStale();
    await expect(stale).rejects.toThrow(/superseded by dispose/);
    const joined = gate.run(async () => { starts += 1; });
    releaseFresh();
    await Promise.all([fresh, joined]);
    expect(starts).toBe(2);
  });
});
