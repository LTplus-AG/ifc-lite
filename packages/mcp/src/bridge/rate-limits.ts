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

/** Milliseconds from a monotonic clock: wall-clock jumps must not shorten or stretch an interval. */
export const monotonicNow = (): number => performance.now();

/**
 * Rate limit on pairing-code comparisons. With no recent failure a code is
 * compared at once. After a failure, the COMPARISON of every handshake (right
 * or wrong code) is deferred by the current delay, which starts at `baseMs`
 * and doubles per failure up to `maxMs`; the count resets after `resetAfterMs`
 * without a failure, or on a success. The caller keeps the handshake's
 * unpaired slot occupied until its comparison runs, even if the peer closes
 * first, and counts a peer that closed before its comparison as a failure.
 *
 * Worst case: `slots` comparisons per delay. With 4 slots and the 5 s cap that
 * is 0.8 guesses per second against a 100-bit code, so a local process
 * without the code cannot pair. It CAN prevent pairing for as long as it keeps
 * attacking: early-closing attempts hold every slot for up to `maxMs` each, so
 * the real tab gets 429 (and, if it gets a slot, its code is compared up to
 * `maxMs` late). That is local denial of service, inside the trust boundary (a
 * local process could equally take the port); a web page cannot do it, since
 * the Origin check runs before a slot is allocated. The bridge logs and
 * reports it (`bridge_status.pairingPressure`) so the user can tell why.
 */
export class PairingGate {
  private failures = 0;
  private lastFailureAt = -Infinity;

  constructor(
    private readonly baseMs = 250,
    private readonly maxMs = 5_000,
    private readonly resetAfterMs = 60_000,
    private readonly now: () => number = monotonicNow,
  ) {}

  /** How long to defer the comparison of an attempt arriving now. */
  delay(): number {
    if (this.failures > 0 && this.now() - this.lastFailureAt > this.resetAfterMs) this.failures = 0;
    if (this.failures === 0) return 0;
    return Math.min(this.baseMs * 2 ** (this.failures - 1), this.maxMs);
  }

  fail(): void {
    if (this.now() - this.lastFailureAt > this.resetAfterMs) this.failures = 0;
    this.failures++;
    this.lastFailureAt = this.now();
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

  constructor(private readonly fn: () => void, private readonly intervalMs: number, private readonly now: () => number = monotonicNow) {}

  fire(): void {
    if (this.timer) return;
    const wait = this.last + this.intervalMs - this.now();
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
    this.last = this.now();
    this.fn();
  }
}
