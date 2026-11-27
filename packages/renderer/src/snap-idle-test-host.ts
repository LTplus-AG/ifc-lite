/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IdleHost, IdleSlice } from './snap-idle-host.js';

/** Idle slices run by hand: nothing happens until `tick` / `drain`. `onWait` advances a fake clock for delayed requests. */
export class ManualIdleHost implements IdleHost {
  private queue: { id: number; cb: (s: IdleSlice) => void; afterMs: number }[] = [];
  private next = 1;
  onWait: (ms: number) => void = () => {};
  request(cb: (s: IdleSlice) => void, afterMs = 0): unknown {
    const id = this.next++;
    this.queue.push({ id, cb, afterMs });
    return id;
  }
  cancel(h: unknown): void { this.queue = this.queue.filter((q) => q.id !== h); }
  get pending(): number { return this.queue.length; }
  /** Run the oldest queued slice with `budgetMs` of idle time; false when none was queued. */
  tick(budgetMs = 1e9): boolean {
    const q = this.queue.shift();
    if (!q) return false;
    if (q.afterMs > 0) this.onWait(q.afterMs);
    q.cb({ timeRemaining: () => budgetMs, didTimeout: false });
    return true;
  }
  drain(maxSlices = 100000): number {
    let n = 0;
    while (n < maxSlices && this.tick()) n++;
    return n;
  }
}
