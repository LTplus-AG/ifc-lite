/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the registered perf flags (`flags.ts`) actually ran with: the values
 * read-once flags were applied with, and the arms a session reports to field
 * telemetry.
 */

import { PERF_FLAGS, readPerfFlag, type PerfFlagDefault, type PerfFlagId } from './flags.js';

// Out-of-core ingest's arm is what a primary load's pool reported (outOfCoreConfig.ts); until one has, the default,
// never the user's PostHog ramp value.
const appliedFlags = new Map<PerfFlagId, unknown>([['outOfCore', false]]);

/**
 * Record the value a read-once flag was applied with (renderer init), so the
 * telemetry arm reports what ran, not a later re-read: a PostHog ramp can
 * load after init, and an umbrella flag can decide a path without the ramp.
 */
export function recordAppliedPerfFlag(id: PerfFlagId, value: unknown): void {
  if (value === undefined) appliedFlags.delete(id); else appliedFlags.set(id, value); // undefined: read the flag again
}

const MAX_STATE_LENGTH = 64;

function compactState(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > MAX_STATE_LENGTH ? `${text.slice(0, MAX_STATE_LENGTH - 1)}…` : text;
}

/**
 * Boolean flags accept `1`/`0` (and their URL spellings) as on/off, so compare
 * those as the boolean they mean: `?perf.quantized=1` is the default, not an arm.
 */
function effectiveState(value: unknown, fallback: PerfFlagDefault): unknown {
  if (typeof fallback !== 'boolean') return value;
  if (value === 1 || value === '1' || value === true) return true;
  if (value === 0 || value === '0' || value === false) return false;
  return value;
}

/**
 * Every flag whose current state differs from its default, as a compact
 * `{ id: value }` record (values stringified, capped at 64 chars). Meant to be
 * attached to field telemetry (#6961) so verdicts can be split by arm; an
 * empty record means the session ran every default.
 */
export function activePerfFlags(): Record<string, string> {
  const active: Record<string, string> = {};
  for (const flag of PERF_FLAGS) {
    const value = appliedFlags.has(flag.id) ? appliedFlags.get(flag.id) : readPerfFlag(flag.id);
    if (value === undefined || value === null) continue;
    const state = compactState(effectiveState(value, flag.default));
    if (state !== compactState(flag.default)) active[flag.id] = state;
  }
  return active;
}
