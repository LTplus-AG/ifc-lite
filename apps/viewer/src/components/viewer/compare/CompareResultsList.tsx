/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compare results list + count badges (issue #924), extracted from ComparePanel
 * to keep it under the module-size house rule (AGENTS.md).
 */

import { Plus, Minus, PencilLine, MousePointerClick } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { COMPARE_COLORS, rgbaCss, type RGBA } from '@/lib/compare/overlay';
import { groupHeaderCount, type ProductTypeSplit } from '@/lib/compare/productTypeCounts';
import type { DiffState } from '@ifc-lite/diff';
import type { CompareResult } from '@/store/slices/compareSlice';
import { hasReportableChanges, type CompareMatchRow, type CompareRow } from './changeRow';
import { CompareMatchGroups } from './CompareMatchGroups';

export interface CompareBucket {
  rows: CompareRow[];
  truncated: number;
}

/** States listed in the panel (unchanged only affects 3D ghosting). */
export const LISTED_STATES: { state: Exclude<DiffState, 'unchanged'>; label: string; color: RGBA; Icon: typeof Plus }[] = [
  { state: 'modified', label: 'Changed', color: COMPARE_COLORS.modified, Icon: PencilLine },
  { state: 'added', label: 'Added', color: COMPARE_COLORS.added, Icon: Plus },
  { state: 'deleted', label: 'Deleted', color: COMPARE_COLORS.deleted, Icon: Minus },
];

/**
 * `hint`, when given, is a secondary line under the label — e.g. "+4 type
 * objects" — for the count's non-product remainder (issue: the headline
 * counts grid totals products AND type objects together, and a certification
 * exercise's expected answer is products-only; see `productTypeCounts.ts`).
 * Omit it (don't pass `''`) rather than pass an empty string when there is
 * nothing to add — a badge with no type-object changes must render exactly as
 * it did before this distinction existed.
 */
export function CountBadge({
  label,
  value,
  color,
  hint,
}: {
  label: string;
  value: number;
  color: RGBA;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-sm font-semibold tabular-nums" style={{ color: rgbaCss([color[0], color[1], color[2], 1]) }}>
        {value.toLocaleString()}
      </span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {hint && <span className="text-[9px] text-muted-foreground/70">{hint}</span>}
    </div>
  );
}

interface CompareResultsListProps {
  result: CompareResult | null;
  groups: Map<DiffState, CompareBucket>;
  counts: CompareResult['diff']['counts'] | undefined;
  /** Products / type-objects split of the FULL entry list. The section
   *  headers render from this rather than from `rows + truncated`, so they
   *  can never disagree with the products-only count badges above them. */
  split: ProductTypeSplit | null;
  /** Content-match rows (#1891) - these live OUTSIDE `diff.entries`. */
  matchRows: CompareMatchRow[];
  selectedKey: string | null;
  onFocus: (row: CompareRow) => void;
  /** Select every element in a state bucket at once (section-header click). */
  onFocusGroup: (state: DiffState) => void;
  onFocusMatch: (row: CompareMatchRow) => void;
  onFocusMatchGroup: (rows: CompareMatchRow[]) => void;
}

export function CompareResultsList({
  result,
  groups,
  counts,
  split,
  matchRows,
  selectedKey,
  onFocus,
  onFocusGroup,
  onFocusMatch,
  onFocusMatchGroup,
}: CompareResultsListProps) {
  return (
    <ScrollArea className="flex-1 min-h-0" {...tourAnchor(TOUR_ANCHORS.compareResults)}>
      {!result ? (
        <div className="p-4 text-sm text-muted-foreground">
          Run a comparison to see added, changed, and deleted elements.
        </div>
      ) : (
        <div className="p-2 space-y-3">
          {LISTED_STATES.map(({ state, label, color, Icon }) => {
            const bucket = groups.get(state);
            if (!bucket || bucket.rows.length === 0) return null;
            return (
              <div key={state}>
                <button
                  type="button"
                  onClick={() => onFocusGroup(state)}
                  title={`Select all ${label.toLowerCase()} in 3D`}
                  className="group w-full flex items-center gap-1.5 px-1 py-1 text-xs font-medium rounded hover:bg-muted transition-colors"
                >
                  <Icon className="h-3.5 w-3.5" style={{ color: rgbaCss(color) }} />
                  <span>{label}</span>
                  {/* Products-first, matching the count badges above: the raw
                      `rows + truncated` total conflates products and type
                      objects, and two totals for one quantity in one panel is
                      the confusion the split exists to remove. */}
                  <span className="text-muted-foreground">
                    ({split ? groupHeaderCount(split, state) : bucket.rows.length + bucket.truncated})
                  </span>
                  <MousePointerClick className="h-3 w-3 ml-auto opacity-0 group-hover:opacity-60 transition-opacity" />
                </button>
                <div className="space-y-0.5">
                  {bucket.rows.map((row) => (
                    <button
                      key={row.key}
                      onClick={() => onFocus(row)}
                      className={cn(
                        'w-full text-left rounded px-2 py-1 flex items-center gap-2 hover:bg-muted transition-colors min-w-0',
                        selectedKey === row.key && 'bg-muted',
                      )}
                    >
                      <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: rgbaCss(color) }} />
                      <span className="min-w-0 flex-1 truncate text-xs">{row.name || row.ifcType}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {state === 'modified' && row.changeKinds.length > 0
                          ? row.changeKinds.join(' · ')
                          : row.ifcType.replace(/^Ifc/, '')}
                      </span>
                    </button>
                  ))}
                  {bucket.truncated > 0 && (
                    <p className="px-2 py-1 text-[10px] text-muted-foreground">
                      +{bucket.truncated} more not shown
                    </p>
                  )}
                </div>
              </div>
            );
          })}
          <CompareMatchGroups
            rows={matchRows}
            selectedKey={selectedKey}
            onFocus={onFocusMatch}
            onFocusGroup={onFocusMatchGroup}
          />
          {/* Exact negation of the panel's "Download report" bar, through the
              same predicate - offering a report over "the models match" (or the
              reverse) is precisely what two independent derivations produced. */}
          {counts && !hasReportableChanges(counts, matchRows) && (
            <div className="p-3 text-sm text-muted-foreground">
              No differences in scope “{result.scope}”. The models match.
            </div>
          )}
        </div>
      )}
    </ScrollArea>
  );
}
