/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { enqueueSourceLoad } from './loadQueue.js';

describe('enqueueSourceLoad', () => {
  it('runs tasks strictly one after another, in order', async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = enqueueSourceLoad(async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      return 1;
    });
    const second = enqueueSourceLoad(async () => {
      events.push('second:start');
      return 2;
    });

    // Give the second task every chance to start early if serialization broke.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(events, ['first:start']);

    releaseFirst();
    assert.strictEqual(await first, 1);
    assert.strictEqual(await second, 2);
    assert.deepStrictEqual(events, ['first:start', 'first:end', 'second:start']);
  });

  it('propagates a task failure to its caller without poisoning the chain', async () => {
    const failing = enqueueSourceLoad(async () => {
      throw new Error('boom');
    });
    await assert.rejects(failing, /boom/);

    // The queue must keep running: a later task still executes and resolves.
    const after = await enqueueSourceLoad(async () => 'still alive');
    assert.strictEqual(after, 'still alive');
  });
});
