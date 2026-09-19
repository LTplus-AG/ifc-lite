/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RuleSummary` — the Run bar's "N rules · AND · limit 500" badge.
 *
 * Pulled out of `SearchModal.filter.tsx` (allowlisted at 859 lines,
 * `scripts/module-size-allowlist.txt`) rather than grown in place: the
 * ratchet forbids a listed file growing, and the `groups: FilterGroup[]`
 * rework (#4904) needs this component to also report a multi-group union
 * ("N groups (OR)" in place of a single AND/OR badge).
 */

export function RuleSummary({
  ruleCount,
  groupCount,
  combinator,
  limit,
}: {
  ruleCount: number;
  /** `searchFilter.groups.length` — >1 means the run is an OR union (#4904). */
  groupCount: number;
  /** The FIRST group's combinator. Only shown when there is one group;
   *  a multi-group union shows "N groups (OR)" instead, since each group
   *  can carry its own AND/OR independently. */
  combinator: 'AND' | 'OR';
  limit: number;
}) {
  if (ruleCount === 0) {
    return (
      <span className="text-muted-foreground italic">No rules — add one to run.</span>
    );
  }
  return (
    <span className="text-muted-foreground">
      <span className="font-mono text-foreground">{ruleCount}</span>{' '}
      rule{ruleCount === 1 ? '' : 's'}
      <span className="mx-1">·</span>
      {groupCount > 1 ? (
        <>
          <span className="font-mono text-foreground">{groupCount}</span> groups{' '}
          <span className="font-mono">(OR)</span>
        </>
      ) : (
        <span className="font-mono">{combinator}</span>
      )}
      <span className="mx-1">·</span>
      limit{' '}
      <span className="font-mono text-foreground">
        {limit > 0 ? limit.toLocaleString() : '∞'}
      </span>
    </span>
  );
}
