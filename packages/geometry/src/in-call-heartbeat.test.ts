/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createInCallHeartbeat } from './in-call-heartbeat.js';
import { DEFAULT_HUNG_JOB_TIMEOUT_MS, WorkerJobLedger } from './hung-job-recovery.js';

describe('in-call geometry heartbeat', () => {
  it('posts only while a geometry batch call is running', async () => {
    let posted = 0;
    const heartbeat = createInCallHeartbeat(() => posted++);
    heartbeat.callback(); // e.g. a pre-pass WASM call: not a geometry batch
    expect(posted).toBe(0);
    await heartbeat.run(async () => {
      heartbeat.callback();
      heartbeat.callback();
    });
    expect(posted).toBe(2);
    heartbeat.callback();
    expect(posted).toBe(2);
  });

  it('stops posting after a call that throws', async () => {
    let posted = 0;
    const heartbeat = createInCallHeartbeat(() => posted++);
    await expect(heartbeat.run(async () => {
      throw new Error('trap');
    })).rejects.toThrow('trap');
    heartbeat.callback();
    expect(posted).toBe(0);
  });

  // The field failure this exists for: one element that needs minutes is not a
  // hung call. With heartbeats reaching the host ledger every second, the pool
  // never replaces the worker and never skips the element, so the element's
  // geometry no longer depends on how fast the user's CPU is.
  it('keeps a long single-element call out of hung-call recovery while it reports progress', async () => {
    const ledger = new WorkerJobLedger(1, 0);
    const seq = ledger.recordDispatch(0, new Uint32Array([42, 0, 10]), 1);
    ledger.onCallStart(0, seq, 0, 1, 0);
    let now = 0;
    const heartbeat = createInCallHeartbeat(() => ledger.onHeard(0, now));
    await heartbeat.run(async () => {
      for (now = 1_000; now <= 10 * DEFAULT_HUNG_JOB_TIMEOUT_MS; now += 1_000) {
        heartbeat.callback();
        expect(ledger.findHung(now, DEFAULT_HUNG_JOB_TIMEOUT_MS)).toEqual([]);
      }
    });
    // Once the reports stop, the unchanged recovery still bounds a real hang.
    const silentFrom = now;
    expect(ledger.findHung(silentFrom + 2 * DEFAULT_HUNG_JOB_TIMEOUT_MS, DEFAULT_HUNG_JOB_TIMEOUT_MS)).toEqual([0]);
  });
});
