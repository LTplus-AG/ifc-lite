/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sequence pattern mining over the action log.
 *
 * Lightweight n-gram approach: slide a window of every length in
 * `[minLength, maxLength]` over each session and count occurrences.
 * Filters by occurrence + distinct-session thresholds.
 *
 * The full PrefixSpan algorithm gives more flexibility (gappy patterns,
 * itemsets) but for the v1 product gap "load → lens → export" the
 * contiguous n-gram is faster, easier to reason about, and produces
 * patterns users intuitively recognise.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §3.
 */

import type { ActionEvent, ActionIntent } from '../log/types.js';
import type { MinedPattern, SequenceMinerOptions } from './types.js';

const DEFAULTS: Required<SequenceMinerOptions> = {
  minLength: 2,
  maxLength: 5,
  minOccurrences: 3,
  minSessions: 2,
  sessionGapMs: 30 * 60 * 1000,
};

/**
 * Mine frequent intent sequences from a list of action events. Events
 * are split into sessions by `sessionGapMs`; the sliding-window count
 * runs within each session.
 */
export function mineSequences(
  events: readonly ActionEvent[],
  opts: SequenceMinerOptions = {},
): MinedPattern[] {
  const o = { ...DEFAULTS, ...opts };
  if (events.length === 0) return [];
  if (o.minLength < 1) throw new Error('minLength must be >= 1');
  if (o.maxLength < o.minLength) throw new Error('maxLength must be >= minLength');

  const sessions = splitSessions(events, o.sessionGapMs);
  const counters = new Map<string, {
    sequence: ActionIntent[];
    occurrences: number;
    sessions: Set<number>;
    lastSeenAt: string;
  }>();

  for (let sIdx = 0; sIdx < sessions.length; sIdx += 1) {
    const session = sessions[sIdx];
    const intents = session.map((e) => e.intent);
    for (let len = o.minLength; len <= o.maxLength; len += 1) {
      if (len > intents.length) break;
      for (let start = 0; start + len <= intents.length; start += 1) {
        const slice = intents.slice(start, start + len);
        const key = slice.join('>');
        const lastEvent = session[start + len - 1];
        const existing = counters.get(key);
        if (existing) {
          existing.occurrences += 1;
          existing.sessions.add(sIdx);
          if (lastEvent.ts > existing.lastSeenAt) existing.lastSeenAt = lastEvent.ts;
        } else {
          counters.set(key, {
            sequence: slice,
            occurrences: 1,
            sessions: new Set([sIdx]),
            lastSeenAt: lastEvent.ts,
          });
        }
      }
    }
  }

  const out: MinedPattern[] = [];
  for (const entry of counters.values()) {
    if (entry.occurrences < o.minOccurrences) continue;
    if (entry.sessions.size < o.minSessions) continue;
    out.push({
      sequence: entry.sequence,
      occurrences: entry.occurrences,
      sessionsTouched: entry.sessions.size,
      lastSeenAt: entry.lastSeenAt,
      score: 0, // populated by score()
    });
  }
  return out;
}

/**
 * Split an event list into per-session arrays. Events more than
 * `sessionGapMs` apart start a new session.
 */
export function splitSessions(
  events: readonly ActionEvent[],
  sessionGapMs: number,
): ActionEvent[][] {
  if (events.length === 0) return [];
  const sessions: ActionEvent[][] = [[events[0]]];
  for (let i = 1; i < events.length; i += 1) {
    const prev = events[i - 1];
    const curr = events[i];
    const gap = Date.parse(curr.ts) - Date.parse(prev.ts);
    if (gap > sessionGapMs) {
      sessions.push([curr]);
    } else {
      sessions[sessions.length - 1].push(curr);
    }
  }
  return sessions;
}
