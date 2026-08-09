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
// The full predecessor grammar: an id (letters/digits/underscore/hyphen),
// an optional link code, an optional signed lag with an optional decimal
// part and unit suffix.
//
// The id group is lazy, so a token ending in a code always splits — the
// grammar alone cannot tell a task literally named "TASKFS" from task "TASK"
// with an FS link. `knownIds` in `parseCsvPredecessors` is what resolves that.
const PREDECESSOR_PATTERN = /^([A-Za-z0-9_-]+?)\s*(FS|SS|FF|SF)?\s*([+-]\s*\d+(?:[.,]\d+)?\s*[a-zA-Z]*)?$/i;

interface LagDetail {
  sign: '+' | '-';
  /** Raw digits, still possibly comma-decimal (e.g. "1,5") -- unconverted. */
  magnitude: string;
  /** Raw unit suffix, not yet lower-cased; `''` when the entry has none. */
  unit: string;
}

/**
 * Parses the `lagRaw` group captured by `PREDECESSOR_PATTERN` (e.g. `+3
 * days`, `-1,5`) into its sign/magnitude/unit pieces, or `undefined` if it
 * isn't actually lag-shaped. The single source of truth for that inner
 * regex: both `hasGenuineLag` and the main parsing loop need the same
 * parse of the same string, and used to run the same regex twice by hand --
 * see the comment below where the loop consumes the result.
 */
function parseLagDetail(lagRaw: string): LagDetail | undefined {
  const lagMatch = /^([+-])\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Z]*)$/.exec(lagRaw.replace(/\s+/g, ' ').trim());
  if (!lagMatch) return undefined;
  return { sign: lagMatch[1] as '+' | '-', magnitude: lagMatch[2], unit: lagMatch[3] };
}

/**
 * Whether an already-parsed lag is *genuine*: the grammar alone
 * (`PREDECESSOR_PATTERN`) can't tell a lag from the tail of a hyphenated id
 * -- `-001` parses as a sign+digits lag whether it's really "TASK" plus a
 * lag or just part of "TASK-001". A link code or an explicit unit is what
 * disambiguates it; without either, the digits are id, not lag.
 */
function isGenuineLag(detail: LagDetail | undefined, hasCode: boolean): boolean {
  return detail !== undefined && (hasCode || detail.unit !== '');
}

/**
 * Whether `match` is a predecessor entry with a genuine lag (see
 * `isGenuineLag`). Used to decide whether a decimal-comma merge candidate
 * is real (below); the main parsing loop parses its own `lagRaw` via
 * `parseLagDetail` directly instead of calling this, so each entry's lag is
 * only ever parsed once.
 */
function hasGenuineLag(match: RegExpExecArray): boolean {
  const [, , code, lagRaw] = match;
  if (!lagRaw) return false;
  return isGenuineLag(parseLagDetail(lagRaw), Boolean(code));
}

/**
 * Parses a predecessors cell into dependency edges.
 *
 * `knownIds` is every task id in the file being imported, and is required
 * rather than optional because without it the suffix split below is a guess:
 * a caller that forgets it would silently reintroduce the "TASKFS" mis-bind.
 * Pass an empty set to exercise the grammar on its own.
 */
export function parseCsvPredecessors(
  raw: string,
  warnings: ScheduleImportWarning[],
  line: number,
  knownIds: ReadonlySet<string>,
): ImportedDependency[] {
  const text = raw.trim();
  if (!text) return [];
  const deps: ImportedDependency[] = [];
  // A `,` is the entry-list separator ("12,14,7"), but `parsePercentCell`
  // (csv.ts) already reads a lone comma as the decimal point in a European
  // locale cell -- the same file can just as well write a fractional lag as
  // "12FS+1,5 days". Splitting on `[,;]` first (rather than protecting the
  // comma beforehand) is what keeps a hyphenated id like "TASK-001" from
  // colliding with the lag-sign grammar: `predecessorSourceId` matches
  // `[A-Za-z0-9_-]+`, so a pre-split protection regex anchored on
  // `[+-]\s*\d+` cannot tell "TASK-001,5" (two entries) from "12FS+1,5 days"
  // (one entry, decimal lag) -- both end in `-<digits>,<digits>`.
  //
  // Instead: split first, then re-merge two adjacent fragments only when
  // the first ends in a bare lag sign+integer (a decimal point's whole
  // part) AND the merged text is itself a valid predecessor token. That
  // validity check is what rejects "TASK-001,5" (merging back into
  // "TASK-001,5" is not a valid token: nothing after the id can begin with
  // a bare comma) while still accepting "12FS+1,5 days".
  const rawTokens = text.split(/[,;]/);
  const entries: string[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const current = rawTokens[i].trim();
    if (!current) continue;
    const next = rawTokens[i + 1];
    if (next !== undefined && /[+-]\s*\d+$/.test(current)) {
      const merged = `${current},${next.trim()}`;
      const mergedMatch = PREDECESSOR_PATTERN.exec(merged);
      if (mergedMatch && hasGenuineLag(mergedMatch)) {
        entries.push(merged);
        i++;
        continue;
      }
    }
    entries.push(current);
  }
  for (const entry of entries) {
    const match = PREDECESSOR_PATTERN.exec(entry);
    if (!match) {
      warnings.push({ code: 'unparsable-predecessor', message: `Could not read predecessor "${entry}".`, line });
      continue;
    }
    const [, matchedId, code, lagRaw] = match;
    // Longest-match first: the grammar always reads a trailing FS/SS/FF/SF as
    // a link code, but an id can legitimately end in one. When id+code names a
    // task actually in the file, that is the id and the link is the default
    // FS; the suffix split is only what is left when it does not. The
    // `startsWith` check keeps this off "TASK FS", where the whitespace says
    // the two really are separate -- an id can never contain a space.
    const joined = code ? matchedId + code : matchedId;
    const idEndsInCode = Boolean(code) && knownIds.has(joined) && entry.startsWith(joined);
    const linkCode = idEndsInCode ? undefined : code;
    let predecessorSourceId = idEndsInCode ? joined : matchedId;
    let lagSeconds: number | undefined;
    // `lagDetail` is parsed once, up front, and reused for both the
    // genuine-lag check and the conversion below -- `isGenuineLag` and
    // `parseLagDetail` share the same inner regex (see `parseLagDetail`'s
    // doc comment) precisely so this can't drift into two copies again.
    const lagDetail = lagRaw ? parseLagDetail(lagRaw) : undefined;
    // A codeless, unitless "lag" is indistinguishable from the tail of a
    // hyphenated id, so treat the whole entry as the id rather than
    // inventing a lag from digits that are part of it.
    if (lagRaw && !isGenuineLag(lagDetail, Boolean(linkCode))) {
      predecessorSourceId = entry;
    } else if (lagDetail) {
      const unitSeconds = unitToSeconds(lagDetail.unit.toLowerCase());
      if (unitSeconds === undefined) {
        // Unknown lag unit (typo, or a unit this importer doesn't model,
        // e.g. "yrs"): the link itself is still real information — drop
        // only the lag rather than the whole dependency — but say so
        // rather than silently treating it as days.
        warnings.push({
          code: 'unparsable-predecessor',
          message: `Predecessor "${entry}": unrecognised lag unit "${lagDetail.unit}", link kept, lag dropped.`,
          line,
        });
      } else {
        const magnitude = Number(lagDetail.magnitude.replace(',', '.')) * unitSeconds;
        lagSeconds = lagDetail.sign === '-' ? -magnitude : magnitude;
      }
    }
    deps.push({
      predecessorSourceId,
      type: linkCode ? LINK_CODES[linkCode.toUpperCase()] : 'FINISH_START',
      lagSeconds: lagSeconds === 0 ? undefined : lagSeconds,
    });
  }
  return deps;
}
