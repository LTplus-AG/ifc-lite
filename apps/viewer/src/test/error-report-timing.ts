/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { act } from 'react';
import { cleanup } from './render.js';

// Yield to I/O and let act drain React updates and promise continuations.
// This does not advance component timers or stand in for an HTTP/digest signal.
export async function settleReportWork(): Promise<void> {
  await act(async () => { await nextTurn(); });
}

export function reportClock(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    // Unmount while clearTimeout still belongs to the controlled clock.
    try { cleanup(); }
    finally { t.mock.timers.reset(); }
  });
  return {
    async advance(ms: number): Promise<void> {
      await act(async () => {
        t.mock.timers.tick(ms);
        await nextTurn();
      });
    },
  };
}
