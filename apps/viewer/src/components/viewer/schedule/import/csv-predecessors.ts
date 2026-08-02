/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Predecessor-grammar parsing for the Gantt CSV importer (issue #1890).
 *
 * Split out of `csv.ts` (AGENTS.md: split modules over ~400 non-generated
 * lines) — this is the self-contained "MS Project shorthand → dependency
 * edges" concern (`12FS+3 days`, `14SS-1 day`, bare ids, `,`/`;` lists),
 * plus the duration/lag unit table it shares with `parseCsvDuration`.
 */

import type { SequenceTypeEnum } from '@ifc-lite/parser';
import type { ImportedDependency, ScheduleImportWarning } from './types.js';

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3_600;
export const SECONDS_PER_DAY = 86_400;

// Exact-match unit sets rather than `startsWith` prefixes: a `startsWith('d')`
// check would happily accept a typo like "3 dyas" as days, which is exactly
// the silent-guess failure this rework exists to close. `ed`/`eday`/`edays`
// (elapsed days) are folded into the same bucket as plain days per
// `parseCsvDuration`'s doc comment.
const DAY_UNITS = new Set(['d', 'day', 'days', 'ed', 'eday', 'edays']);
const WEEK_UNITS = new Set(['w', 'wk', 'wks', 'week', 'weeks']);
const HOUR_UNITS = new Set(['h', 'hr', 'hrs', 'hour', 'hours']);
const MINUTE_UNITS = new Set(['m', 'min', 'mins', 'minute', 'minutes']);
const MONTH_UNITS = new Set(['mo', 'mon', 'month', 'months']);

/**
 * Seconds-per-unit for a duration/lag suffix, or `undefined` when the unit
 * isn't one of ours. Exact membership rather than a prefix match is what
 * makes this correct twice over: `startsWith('m')` would have swallowed
 * "mon" into minutes, and — the bug this replaced — `startsWith('d')`
 * would have accepted the typo "dyas" as days instead of reporting it.
 *
 * The sets are disjoint, so the order of these checks carries no meaning;
 * it is grouped largest-unit-first only for readability.
 */
export function unitToSeconds(unit: string): number | undefined {
  if (unit === '' || DAY_UNITS.has(unit)) return SECONDS_PER_DAY;
  if (MONTH_UNITS.has(unit)) return 30 * SECONDS_PER_DAY;
  if (WEEK_UNITS.has(unit)) return 7 * SECONDS_PER_DAY;
  if (HOUR_UNITS.has(unit)) return SECONDS_PER_HOUR;
  if (MINUTE_UNITS.has(unit)) return SECONDS_PER_MINUTE;
  return undefined;
}

const LINK_CODES: Record<string, SequenceTypeEnum> = {
  FS: 'FINISH_START',
  SS: 'START_START',
  FF: 'FINISH_FINISH',
  SF: 'START_FINISH',
};

/**
 * `12FS+3 days, 14SS-1 day, 7` → dependency edges.
 *
 * The link-code group matches case-insensitively (`i` flag): `12fs+3d` and
 * `12Fs` are both real MS Project exports, and `code.toUpperCase()` below
 * only works if the regex actually captures the code in the first place —
 * without the flag, a lowercase code failed the alternation, backtracked
 * into the id group, and the whole predecessor was dropped as unknown.
 */
export function parseCsvPredecessors(
  raw: string,
  warnings: ScheduleImportWarning[],
  line: number,
): ImportedDependency[] {
  const text = raw.trim();
  if (!text) return [];
  const deps: ImportedDependency[] = [];
  for (const token of text.split(/[,;]/)) {
    const entry = token.trim();
    if (!entry) continue;
    const match = /^([A-Za-z0-9_-]+?)\s*(FS|SS|FF|SF)?\s*([+-]\s*\d+(?:[.,]\d+)?\s*[a-zA-Z]*)?$/i.exec(entry);
    if (!match) {
      warnings.push({ code: 'unparsable-predecessor', message: `Could not read predecessor "${entry}".`, line });
      continue;
    }
    const [, predecessorSourceId, code, lagRaw] = match;
    let lagSeconds: number | undefined;
    if (lagRaw) {
      const lagMatch = /^([+-])\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Z]*)$/.exec(lagRaw.replace(/\s+/g, ' ').trim());
      if (lagMatch) {
        const unitSeconds = unitToSeconds(lagMatch[3].toLowerCase());
        if (unitSeconds === undefined) {
          // Unknown lag unit (typo, or a unit this importer doesn't model,
          // e.g. "yrs"): the link itself is still real information — drop
          // only the lag rather than the whole dependency — but say so
          // rather than silently treating it as days.
          warnings.push({
            code: 'unparsable-predecessor',
            message: `Predecessor "${entry}": unrecognised lag unit "${lagMatch[3]}" — link kept, lag dropped.`,
            line,
          });
        } else {
          const magnitude = Number(lagMatch[2].replace(',', '.')) * unitSeconds;
          lagSeconds = lagMatch[1] === '-' ? -magnitude : magnitude;
        }
      }
    }
    deps.push({
      predecessorSourceId,
      type: code ? LINK_CODES[code.toUpperCase()] : 'FINISH_START',
      lagSeconds: lagSeconds === 0 ? undefined : lagSeconds,
    });
  }
  return deps;
}
