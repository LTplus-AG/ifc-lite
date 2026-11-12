/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bounds on what peers of `--bridge` (#9523) can make the bridge do over time.
 *
 * Any web page can loop connection attempts at the loopback port, and any
 * local process can send wrong pairing codes. Neither may flood stderr, burn
 * CPU on notifications, or make the user's pairing link stop working.
 */

/**
 * Coalesces repeated log lines of one kind: the first in a window is written,
 * the rest are counted, and one "N more ..." summary closes the window.
 */
export class CoalescedLog {
  private readonly windows = new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly log: (line: string) => void, private readonly windowMs = 10_000) {}

  note(kind: string, line: string): void {
    const open = this.windows.get(kind);
    if (open) {
      open.count++;
      return;
    }
    this.log(line);
    const timer = setTimeout(() => {
      const w = this.windows.get(kind);
      this.windows.delete(kind);
      if (w && w.count > 0) this.log(this.summary(kind, w.count));
    }, this.windowMs);
    timer.unref?.();
    this.windows.set(kind, { count: 0, timer });
  }

  /** Write pending summaries now and stop the timers. */
  flush(): void {
    for (const [kind, w] of this.windows) {
      clearTimeout(w.timer);
      if (w.count > 0) this.log(this.summary(kind, w.count));
    }
    this.windows.clear();
  }

  private summary(kind: string, count: number): string {
    const span = this.windowMs >= 1000 ? `${Math.round(this.windowMs / 1000)} s` : `${this.windowMs} ms`;
    return `${count} more ${kind} in the last ${span}`;
  }
}

/**
 * Back-off for wrong pairing codes. Each wrong code is answered only after a
 * delay that doubles with every recent failure (base, 2x base, ... up to max),
 * and the socket keeps its unpaired slot meanwhile, so the rate of guesses is
 * bounded by the slot cap over the delay. A correct code is never delayed, and
 * failures never rotate the code, so a guessing peer cannot invalidate the
 * user's link. The count resets on success or after `resetAfterMs` quiet.
 */
export class PairingBackoff {
  private failures = 0;
  private lastFailureAt = 0;

  constructor(
    private readonly baseMs = 250,
    private readonly maxMs = 5_000,
    private readonly resetAfterMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record a wrong code; returns how long to wait before answering it. */
  fail(): number {
    const t = this.now();
    if (t - this.lastFailureAt > this.resetAfterMs) this.failures = 0;
    this.failures++;
    this.lastFailureAt = t;
    return Math.min(this.baseMs * 2 ** (this.failures - 1), this.maxMs);
  }

  succeed(): void {
    this.failures = 0;
  }
}

/**
 * Leading-edge throttle with a trailing call: `fire` runs `fn` at once if it
 * last ran `intervalMs` ago, else once at the end of the interval.
 */
export class Throttle {
  private last = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly fn: () => void, private readonly intervalMs: number) {}

  fire(): void {
    if (this.timer) return;
    const wait = this.last + this.intervalMs - Date.now();
    if (wait <= 0) {
      this.run();
      return;
    }
    this.timer = setTimeout(() => this.run(), wait);
    this.timer.unref?.();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private run(): void {
    this.timer = null;
    this.last = Date.now();
    this.fn();
  }
}
