/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How many bridge calls the tab runs, and for how long (#9523).
 *
 * The peer on 127.0.0.1 is a program the viewer cannot verify. A buggy or
 * hostile one must not be able to freeze the tab (so that Disconnect never
 * lands and the user's unsaved edits are at risk), so calls are admitted
 * here: a few run at once, a short queue waits, the rest are answered at
 * once with an error. Each running call has a tab-side time limit, arguments
 * are size-bounded before any dispatch, the next queued call starts only
 * after yielding to the event loop, and a peer that floods is disconnected.
 */

export const CALL_LIMITS = {
  /** Calls dispatched at the same time. */
  maxRunning: 4,
  /** Calls waiting for a slot; more are refused at once. */
  maxQueued: 16,
  /** A running call is aborted and answered TIMEOUT after this long (the bridge itself waits 120 s). */
  callTimeoutMs: 60_000,
  /** UTF-8 bytes of one call's arguments as JSON. Tool arguments are ids, filters and small IDS documents. */
  maxArgumentBytes: 512 * 1024,
  /** More than `floodMaxCalls` calls within `floodWindowMs` disconnects the peer. */
  floodWindowMs: 10_000,
  floodMaxCalls: 200,
} as const;

export type CallLimits = { [K in keyof typeof CALL_LIMITS]: number };

export type Admission = 'run' | 'queue' | 'busy' | 'too-large' | 'flood';

/** The admission bookkeeping, without sockets or timers, so it is testable on its own. */
export class CallAdmission<T> {
  private running = 0;
  private readonly queue: { id: string; item: T }[] = [];
  private readonly arrivals: number[] = [];

  constructor(private readonly limits: CallLimits, private readonly now: () => number) {}

  get runningCount(): number { return this.running; }
  get queuedCount(): number { return this.queue.length; }

  /** Decide what happens to a newly arrived call. `run` takes a slot; `queue` stores `item`. */
  admit(id: string, item: T, argumentBytes: number): Admission {
    const t = this.now();
    this.arrivals.push(t);
    while (this.arrivals.length > 0 && t - this.arrivals[0] > this.limits.floodWindowMs) this.arrivals.shift();
    if (this.arrivals.length > this.limits.floodMaxCalls) return 'flood';
    if (argumentBytes > this.limits.maxArgumentBytes) return 'too-large';
    if (this.running < this.limits.maxRunning) {
      this.running++;
      return 'run';
    }
    if (this.queue.length < this.limits.maxQueued) {
      this.queue.push({ id, item });
      return 'queue';
    }
    return 'busy';
  }

  /** A queued call was cancelled before it started. */
  drop(id: string): boolean {
    const at = this.queue.findIndex((entry) => entry.id === id);
    if (at < 0) return false;
    this.queue.splice(at, 1);
    return true;
  }

  /** A running call ended: hand its slot to the next queued call, if any. */
  release(): T | null {
    const next = this.queue.shift();
    if (next) return next.item;
    this.running = Math.max(0, this.running - 1);
    return null;
  }

  clear(): void {
    this.queue.length = 0;
    this.running = 0;
  }
}
