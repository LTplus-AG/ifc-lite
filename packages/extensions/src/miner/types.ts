/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pattern-miner types.
 *
 * The miner reads the action log (§06.2) and surfaces frequent
 * action sequences as candidate tool-suggestions. All processing is
 * local; nothing leaves the device.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §3.
 */

import type { ActionIntent } from '../log/types.js';

/** A sequence of action intents. */
export type IntentSequence = readonly ActionIntent[];

/** A mined pattern — an intent sequence that recurred enough to surface. */
export interface MinedPattern {
  /** The intent sequence in order. */
  sequence: ActionIntent[];
  /** Number of times this sequence appears across all sessions. */
  occurrences: number;
  /** Number of distinct "sessions" (gap-separated groups) the pattern appeared in. */
  sessionsTouched: number;
  /** Timestamp (ISO) of the most recent occurrence. */
  lastSeenAt: string;
  /** Score from `score()`. Higher is more recommendable. */
  score: number;
}

export interface SequenceMinerOptions {
  /** Minimum length of patterns to surface. Default 2. */
  minLength?: number;
  /** Maximum length to mine. Default 5. */
  maxLength?: number;
  /** Minimum total occurrences across the log. Default 3. */
  minOccurrences?: number;
  /** Minimum number of distinct sessions. Default 2. */
  minSessions?: number;
  /**
   * Session boundary in ms. Events more than this apart count as
   * separate sessions. Default 30 min.
   */
  sessionGapMs?: number;
}

export interface ScoringOptions {
  /** Multiplier on raw occurrences. Default 1. */
  frequencyWeight?: number;
  /** Multiplier on recency (most recent = 1.0, older decays). Default 0.5. */
  recencyWeight?: number;
  /** Multiplier on session-count diversity. Default 0.3. */
  sessionsWeight?: number;
  /** Half-life of recency decay, in days. Default 14. */
  recencyHalfLifeDays?: number;
  /** Optional "now" for deterministic tests. */
  now?: Date;
}
