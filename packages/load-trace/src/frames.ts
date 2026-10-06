/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TraceSpan } from './types.js';

/**
 * Main-thread health (#6957): `long-animation-frame` (LoAF) and `longtask`
 * entries, kept in a bounded log and summarised per load window. Both entry
 * types are feature-detected; an engine without them reports `supported:
 * false` and empty stats rather than zeros that look like a healthy load.
 */

export type FrameEntryType = 'loaf' | 'longtask';

export interface FrameEntry {
  type: FrameEntryType;
  start: number;
  duration: number;
  /** LoAF `blockingDuration`; for a long task, the part over 50 ms. */
  blocking: number;
}

export interface FrameMonitor {
  readonly supported: Readonly<Record<FrameEntryType, boolean>>;
  /** Every retained entry, after flushing the observers' undelivered records. */
  entries(): readonly FrameEntry[];
  stop(): void;
}

export interface FrameStats {
  count: number;
  /** Entries longer than 50 ms (every LoAF is, by definition). */
  over50: number;
  totalMs: number;
  blockingMs: number;
  longestMs: number;
}

export interface SpanFrameStats { count: number; blockingMs: number; durationMs: number }

export interface FrameSummary {
  supported: Record<FrameEntryType, boolean>;
  loaf: FrameStats;
  longtask: FrameStats;
  /**
   * LoAF blocking time by the innermost main-thread span open at the frame's
   * start (`load` when none is). Long tasks fall back here when LoAF is absent.
   */
  bySpan: Record<string, SpanFrameStats>;
}

const LONG_TASK_MS = 50;

interface ObserverEntry { startTime: number; duration: number; blockingDuration?: number }
interface ObserverLike {
  observe(options: { type: string; buffered?: boolean }): void;
  takeRecords(): Array<ObserverEntry>;
  disconnect(): void;
}
export interface ObserverCtor {
  new (cb: (list: { getEntries(): ObserverEntry[] }) => void): ObserverLike;
  readonly supportedEntryTypes?: readonly string[];
}

const ENTRY_TYPES: ReadonlyArray<[FrameEntryType, string]> = [['loaf', 'long-animation-frame'], ['longtask', 'longtask']];

/** Start observing both entry types; `max` bounds the log (oldest dropped). */
export function startFrameMonitor(
  Observer: ObserverCtor | undefined = (globalThis as { PerformanceObserver?: ObserverCtor }).PerformanceObserver,
  max = 20_000,
): FrameMonitor {
  const log: FrameEntry[] = [];
  const observers: Array<[FrameEntryType, ObserverLike]> = [];
  const supported: Record<FrameEntryType, boolean> = { loaf: false, longtask: false };
  const push = (type: FrameEntryType, list: ObserverEntry[]) => {
    for (const e of list) {
      const blocking = type === 'loaf' ? (e.blockingDuration ?? 0) : Math.max(0, e.duration - LONG_TASK_MS);
      log.push({ type, start: e.startTime, duration: e.duration, blocking });
    }
    if (log.length > max) log.splice(0, log.length - max);
  };
  for (const [type, entryType] of ENTRY_TYPES) {
    if (!Observer?.supportedEntryTypes?.includes(entryType)) continue;
    try {
      const observer = new Observer((list) => push(type, list.getEntries()));
      observer.observe({ type: entryType, buffered: true });
      observers.push([type, observer]);
      supported[type] = true;
    } catch (err) {
      console.warn(`[load-trace] could not observe ${entryType}; it is reported as unsupported`, err);
    }
  }
  return {
    supported,
    entries() {
      for (const [type, o] of observers) push(type, o.takeRecords());
      return log;
    },
    stop() { for (const [, o] of observers) o.disconnect(); },
  };
}

const emptyStats = (): FrameStats => ({ count: 0, over50: 0, totalMs: 0, blockingMs: 0, longestMs: 0 });
const round = (ms: number) => Math.round(ms * 10) / 10;

/** Summarise the entries that START inside `[start, end)`, attributing each to a span of `spans`. */
export function summarizeFrames(
  entries: readonly FrameEntry[],
  supported: Readonly<Record<FrameEntryType, boolean>>,
  start: number,
  end: number,
  spans: readonly TraceSpan[],
): FrameSummary {
  const stats = { loaf: emptyStats(), longtask: emptyStats() };
  const bySpan: Record<string, SpanFrameStats> = {};
  const attributeType: FrameEntryType = supported.loaf ? 'loaf' : 'longtask';
  const owners = spans.filter((s) => s.thread === 'main' && !s.milestone);
  for (const e of entries) {
    if (e.start < start || e.start >= end) continue;
    const s = stats[e.type];
    s.count++;
    if (e.duration > LONG_TASK_MS) s.over50++;
    s.totalMs += e.duration;
    s.blockingMs += e.blocking;
    s.longestMs = Math.max(s.longestMs, e.duration);
    if (e.type !== attributeType) continue;
    // Innermost = the latest-starting span still open at the frame's start.
    let owner: TraceSpan | undefined;
    for (const span of owners) {
      if (span.start <= e.start && (span.end === null || span.end > e.start) && (!owner || span.start >= owner.start)) owner = span;
    }
    const slot = (bySpan[owner?.name ?? 'load'] ??= { count: 0, blockingMs: 0, durationMs: 0 });
    slot.count++;
    slot.blockingMs += e.blocking;
    slot.durationMs += e.duration;
  }
  for (const s of [stats.loaf, stats.longtask]) {
    s.totalMs = round(s.totalMs); s.blockingMs = round(s.blockingMs); s.longestMs = round(s.longestMs);
  }
  for (const slot of Object.values(bySpan)) { slot.blockingMs = round(slot.blockingMs); slot.durationMs = round(slot.durationMs); }
  return { supported: { ...supported }, ...stats, bySpan };
}
