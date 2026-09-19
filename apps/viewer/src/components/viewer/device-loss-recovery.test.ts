/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { DeviceRecoveryResult } from '@ifc-lite/renderer';
import { startDeviceLossRecovery } from './device-loss-recovery.js';

describe('device-loss recovery coordinator (#4885)', () => {
  it('reports an immediate recovery once', async () => {
    let calls = 0, recovered = 0, failed = 0;
    const run = startDeviceLossRecovery(
      { recoverDevice: async () => { calls++; return { ok: true, omissions: [] }; } },
      { recovered: () => { recovered++; }, failed: () => { failed++; } },
    );
    assert.deepStrictEqual(await run.promise, { ok: true, omissions: [] });
    assert.strictEqual(calls, 1);
    assert.strictEqual(recovered, 1);
    assert.strictEqual(failed, 0);
  });

  it('retries a replacement-device failure once after 500ms', async () => {
    const results: DeviceRecoveryResult[] = [
      { ok: false, reason: 'device-init-failed' },
      { ok: true, omissions: ['point-clouds'] },
    ];
    const delays: number[] = [];
    let recovered = 0;
    const run = startDeviceLossRecovery(
      { recoverDevice: async () => results.shift()! },
      { recovered: () => { recovered++; }, failed: () => assert.fail('must recover') },
      async (ms) => { delays.push(ms); },
    );
    assert.deepStrictEqual(await run.promise, { ok: true, omissions: ['point-clouds'] });
    assert.deepStrictEqual(delays, [500]);
    assert.strictEqual(recovered, 1);
  });

  it('does not retry an unsupported CPU scene', async () => {
    let calls = 0, failed = 0;
    const run = startDeviceLossRecovery(
      { recoverDevice: async () => { calls++; return { ok: false, reason: 'cpu-geometry-released' }; } },
      { recovered: () => assert.fail('must fail'), failed: () => { failed++; } },
      async () => assert.fail('must not delay'),
    );
    await run.promise;
    assert.strictEqual(calls, 1);
    assert.strictEqual(failed, 1);
  });

  it('suppresses callbacks after the viewport unmounts', async () => {
    let finish!: (result: DeviceRecoveryResult) => void, callbacks = 0;
    const run = startDeviceLossRecovery(
      { recoverDevice: () => new Promise((resolve) => { finish = resolve; }) },
      { recovered: () => { callbacks++; }, failed: () => { callbacks++; } },
    );
    run.cancel();
    finish({ ok: true, omissions: [] });
    await run.promise;
    assert.strictEqual(callbacks, 0);
  });

  it('contains an unexpected recovery rejection and reports a typed failure', async () => {
    let calls = 0, failed = 0;
    const run = startDeviceLossRecovery(
      { recoverDevice: async () => { calls++; throw new Error('browser rejected'); } },
      { recovered: () => assert.fail('must fail'), failed: () => { failed++; } },
      async () => undefined,
    );

    const result = await run.promise;
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.reason, 'device-init-failed');
      assert.match(String(result.error), /browser rejected/);
    }
    assert.strictEqual(failed, 1);
  });
});
