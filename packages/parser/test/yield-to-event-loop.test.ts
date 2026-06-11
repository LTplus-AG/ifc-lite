/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { yieldToEventLoop } from '../src/yield-to-event-loop.js';

function countMessagePortHandles(): number {
  const handles = (
    process as unknown as { _getActiveHandles: () => unknown[] }
  )._getActiveHandles();
  return handles.filter(
    (h) => (h as { constructor?: { name?: string } })?.constructor?.name === 'MessagePort'
  ).length;
}

describe('yieldToEventLoop', () => {
  it('does not leak MessagePort handles (CLI exit-hang regression)', async () => {
    // Each yield used to leave a MessageChannel with an attached
    // onmessage listener open. In Node an open MessagePort holds a
    // libuv handle, so a parse with hundreds of yields kept the process
    // alive forever — the CLI printed its results and then hung.
    const before = countMessagePortHandles();

    for (let i = 0; i < 50; i++) {
      await yieldToEventLoop();
    }

    // Ports close inside the message handler, but Node finalises the
    // underlying handle asynchronously — at most the last channel may
    // still be mid-teardown here. Pre-fix, all 50 stayed open.
    expect(countMessagePortHandles()).toBeLessThanOrEqual(before + 1);

    // After a timer tick the teardown must have drained completely.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(countMessagePortHandles()).toBeLessThanOrEqual(before);
  });
});
