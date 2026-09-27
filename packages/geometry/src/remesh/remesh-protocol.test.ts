/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { serialQueue } from './remesh-protocol.js';

describe('remesh worker message queue (#6232)', () => {
  it('keeps handling messages in order after a handler rejects', async () => {
    const handled: number[] = [];
    const errors: unknown[] = [];
    let release!: () => void;
    const firstDone = new Promise<void>((resolve) => { release = resolve; });
    const enqueue = serialQueue<number>(async (n) => {
      if (n === 1) await firstDone;
      if (n === 2) throw new Error('escaped');
      handled.push(n);
    }, (error) => errors.push(error));

    enqueue(1);
    enqueue(2);
    enqueue(3);
    expect(handled).toEqual([]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handled).toEqual([1, 3]);
    expect(errors).toHaveLength(1);
  });
});
