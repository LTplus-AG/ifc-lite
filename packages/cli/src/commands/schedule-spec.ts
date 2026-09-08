/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `--save`/`--spec` reusable schedule definitions for `ifc-lite schedule`.
 *
 * A spec is a small JSON file holding exactly the flag strings the CLI itself
 * accepts — `--type`, `--columns`, `--where`, `--sort`, `--group-by`,
 * `--subtotals`, `--format` — plus an optional `preset` field naming a
 * `--preset` to start from. It is a plain file at whatever path the caller
 * gives `--spec`/`--save`, not a config-directory convention: `--save` writes
 * one, `--spec` reads one back.
 *
 * Precedence when both a spec and an explicit flag are given (`schedule.ts`):
 * explicit CLI flag > spec field > preset field (whether `--preset` on the
 * command line or `preset` inside the spec) — the same "most specific wins"
 * rule `--preset` already uses against explicit flags.
 *
 * A spec naming an unresolvable `preset`, or missing/malformed in a way that
 * would otherwise silently resolve to an empty schedule, is a `fatal(...)`:
 * failing loudly beats emitting a table with no rows or columns.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fatal } from '../output.js';
import { logger } from '../logger.js';
import { parseWhereFilter } from './where-filter.js';

/** The reusable definition persisted by `--save` and consumed by `--spec`. */
export interface ScheduleSpec {
  preset?: string;
  type?: string;
  columns?: string;
  where?: string;
  sort?: string;
  groupBy?: string;
  subtotals?: string;
  format?: string;
}

const SPEC_FIELDS: (keyof ScheduleSpec)[] = [
  'preset', 'type', 'columns', 'where', 'sort', 'groupBy', 'subtotals', 'format',
];

/**
 * Load a `--spec` file. Fatal (not a thrown exception the top-level handler
 * reformats) on every way a spec can fail to be a usable schedule definition:
 * the file doesn't exist or isn't readable, its content isn't valid JSON,
 * isn't a JSON object, or has a declared field that isn't a string — each
 * would otherwise surface only once `schedule.ts` tries to use the bad value
 * (or, for a non-object/wrong-type field, might silently coerce into an empty
 * `--columns`/`--type`, producing an empty schedule with no error at all).
 */
export async function loadScheduleSpec(path: string): Promise<ScheduleSpec> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err) {
    fatal(`--spec "${path}" could not be read: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    fatal(`--spec "${path}" is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fatal(`--spec "${path}" must be a JSON object with schedule fields (type, columns, where, sort, groupBy, subtotals, format, preset), got ${Array.isArray(parsed) ? 'an array' : typeof parsed}.`);
  }

  const obj = parsed as Record<string, unknown>;

  // An unrecognised key (a mistyped "group-by" instead of "groupBy", say) used
  // to be silently ignored by the loop below, which only ever reads the
  // fields it already knows about — the mistyped key had no effect and the
  // command exited 0 with whatever the OTHER, correctly-spelled fields
  // produced (an ungrouped schedule, for a mistyped "groupBy"), never
  // surfacing that the field was dropped. Reject it up front instead.
  const unknownKeys = Object.keys(obj).filter(k => !(SPEC_FIELDS as string[]).includes(k));
  if (unknownKeys.length > 0) {
    fatal(`--spec "${path}" has unrecognised field(s): ${unknownKeys.join(', ')}. Valid fields: ${SPEC_FIELDS.join(', ')}.`);
  }

  const spec: ScheduleSpec = {};
  for (const field of SPEC_FIELDS) {
    if (!(field in obj)) continue;
    const value = obj[field];
    if (typeof value !== 'string') {
      fatal(`--spec "${path}": field "${field}" must be a string, got ${Array.isArray(value) ? 'an array' : typeof value}.`);
    }
    spec[field] = value;
  }

  if (spec.preset === undefined && spec.type === undefined) {
    fatal(`--spec "${path}" declares neither "preset" nor "type" — nothing to schedule. Expected at least one, plus "columns" unless a preset supplies it.`);
  }

  // Validate `where` the same way an explicit --where flag is (schedule.ts
  // calls the identical parseWhereFilter once it applies the filter) —
  // eagerly here, rather than deferring the same fatal(...) until the run
  // gets around to using it (by which point --save, if also given, may
  // already have written a spec built from this same broken value).
  if (spec.where !== undefined) {
    parseWhereFilter(spec.where);
  }

  return spec;
}

/**
 * Write the schedule definition actually used by this invocation (after
 * `--preset` defaults are folded in, so a saved spec is self-contained and
 * `--spec`-loadable without also needing the original `--preset`) to `path`.
 * Undefined fields are omitted rather than written as `null`.
 */
export async function saveScheduleSpec(path: string, spec: ScheduleSpec): Promise<void> {
  const out: ScheduleSpec = {};
  for (const field of SPEC_FIELDS) {
    if (spec[field] !== undefined) out[field] = spec[field];
  }
  try {
    await writeFile(path, JSON.stringify(out, null, 2) + '\n');
  } catch (err) {
    fatal(`--save "${path}" could not be written: ${(err as Error).message}`);
  }
  logger.info(`Schedule spec written to ${path}`);
}
