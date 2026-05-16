/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Idle scheduler for the pattern miner.
 *
 * The miner runs on idle to surface tool suggestions without
 * competing with the user's active work. This module owns the
 * timing: when to run, how often, when to back off.
 *
 * Strategy:
 *   - Wait for `idleAfterMs` of inactivity (no `append` on the
 *     action log) before scheduling a mine.
 *   - Run at most once per `minIntervalMs` regardless of activity.
 *   - On detect, hand the result off to a callback.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §3.3.
 */

import type { ActionEvent } from '../log/types.js';
import { mineSequences } from './sequence.js';
import { scorePatterns } from './score.js';
import type { MinedPattern, ScoringOptions, SequenceMinerOptions } from './types.js';

export interface IdleSchedulerOptions {
  /** Idle time before a mine fires. Default 60 s. */
  idleAfterMs?: number;
  /** Hard floor between mines regardless of idle. Default 5 min. */
  minIntervalMs?: number;
  /** How many top patterns to emit per fire. Default 5. */
  topN?: number;
  /** Miner options. */
  miner?: SequenceMinerOptions;
  /** Scoring options. */
  scoring?: ScoringOptions;
  /**
   * Optional schedule function — replaces setTimeout. Tests pass a
   * fake. Returns a cancel function.
   */
  setTimer?: (callback: () => void, ms: number) => () => void;
  /** Optional clock for tests. */
  now?: () => number;
}

export interface MineEvent {
  patterns: MinedPattern[];
  /** Total events considered. */
  eventCount: number;
  /** ISO timestamp of the mine. */
  at: string;
}

/**
 * Build an idle scheduler. The returned object owns the timing; the
 * caller hands it events as they arrive (typically by subscribing to
 * the ActionLog) and is notified through `subscribe`.
 */
export class IdleMineScheduler {
  private events: ActionEvent[] = [];
  private cancel?: () => void;
  private lastFireAt = 0;
  private listeners = new Set<(event: MineEvent) => void>();
  private readonly opts: Required<Pick<IdleSchedulerOptions, 'idleAfterMs' | 'minIntervalMs' | 'topN'>>;
  private readonly miner: SequenceMinerOptions;
  private readonly scoring: ScoringOptions;
  private readonly setTimer: NonNullable<IdleSchedulerOptions['setTimer']>;
  private readonly now: () => number;

  constructor(opts: IdleSchedulerOptions = {}) {
    this.opts = {
      idleAfterMs: opts.idleAfterMs ?? 60_000,
      minIntervalMs: opts.minIntervalMs ?? 5 * 60_000,
      topN: opts.topN ?? 5,
    };
    this.miner = opts.miner ?? {};
    this.scoring = opts.scoring ?? {};
    this.setTimer = opts.setTimer ?? defaultSetTimer;
    this.now = opts.now ?? defaultNow;
  }

  /** Push a new event onto the buffer and (re)arm the idle timer. */
  push(event: ActionEvent): void {
    this.events.push(event);
    this.rearm();
  }

  /** Replace the event buffer wholesale — useful when reading from storage. */
  setEvents(events: readonly ActionEvent[]): void {
    this.events = [...events];
  }

  /** Subscribe to mine results. Returns an unsubscribe. */
  subscribe(listener: (event: MineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Force-run a mine right now, bypassing the idle delay (but not the floor). */
  fireNow(): MineEvent {
    return this.runMine();
  }

  /** Cancel any pending timer. Idempotent. */
  dispose(): void {
    if (this.cancel) {
      this.cancel();
      this.cancel = undefined;
    }
    this.listeners.clear();
  }

  private rearm(): void {
    if (this.cancel) {
      this.cancel();
      this.cancel = undefined;
    }
    this.cancel = this.setTimer(() => {
      const now = this.now();
      if (now - this.lastFireAt < this.opts.minIntervalMs) {
        // Floor not yet elapsed; reschedule until it is.
        const wait = this.opts.minIntervalMs - (now - this.lastFireAt);
        this.cancel = this.setTimer(() => this.runMine(), wait);
        return;
      }
      this.runMine();
    }, this.opts.idleAfterMs);
  }

  private runMine(): MineEvent {
    const patterns = mineSequences(this.events, this.miner);
    const scored = scorePatterns(patterns, this.scoring).slice(0, this.opts.topN);
    const event: MineEvent = {
      patterns: scored,
      eventCount: this.events.length,
      at: new Date(this.now()).toISOString(),
    };
    this.lastFireAt = this.now();
    for (const listener of this.listeners) listener(event);
    return event;
  }
}

function defaultSetTimer(callback: () => void, ms: number): () => void {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
}

function defaultNow(): number {
  return Date.now();
}
