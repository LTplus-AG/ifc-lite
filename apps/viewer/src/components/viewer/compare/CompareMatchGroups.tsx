/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two content-matching sections of the compare results list (issue #1891),
 * kept out of `CompareResultsList` so both stay under the module-size house
 * rule (AGENTS.md).
 *
 * These rows do not come from `diff.entries` at all - they come from
 * `diff.contentMatches`:
 *
 * - **Matched** (`renamed` / `moved` / `reshaped`): the engine retired these
 *   elements' `added`/`deleted` entries. Without this section their counts drop
 *   out of the panel with no row saying where they went.
 * - **Needs review** (`duplicated` / `deduplicated` / `ambiguous`): the engine
 *   retired nothing, so these elements are ALSO listed above under Added /
 *   Deleted in their own colours. This section badges the grouping the engine
 *   found without claiming a resolution it declined to make.
 */

import { Link2, TriangleAlert, MousePointerClick } from 'lucide-react';
import { cn } from '@/lib/utils';
import { COMPARE_COLORS, rgbaCss, type RGBA } from '@/lib/compare/overlay';
import { MATCH_KIND_HINT, MATCH_KIND_LABEL } from '@/lib/compare/contentMatches';
import { MAX_ROWS_PER_GROUP, type CompareMatchRow } from './changeRow';

/** Amber, matching the panel's existing warning text colour (`#e0af68`). */
const REVIEW_COLOR: RGBA = [0.878, 0.686, 0.408, 1];

/** Right-hand summary for a row: the kind, plus the group shape when the match
 *  is not a simple pair, plus the move distance when the engine measured one. */
function matchRowSummary(row: CompareMatchRow): string {
  const parts = [MATCH_KIND_LABEL[row.kind]];
  if (row.baseCount !== 1 || row.headCount !== 1) parts.push(`${row.baseCount}:${row.headCount}`);
  if (row.distance !== undefined && row.distance > 0) parts.push(`${row.distance.toFixed(3)} m`);
  return parts.join(' · ');
}

interface MatchSectionProps {
  rows: CompareMatchRow[];
  selectedKey: string | null;
  onFocus: (row: CompareMatchRow) => void;
  onFocusGroup: (rows: CompareMatchRow[]) => void;
}

function MatchSection({
  rows,
  selectedKey,
  onFocus,
  onFocusGroup,
  label,
  title,
  color,
  Icon,
}: MatchSectionProps & { label: string; title: string; color: RGBA; Icon: typeof Link2 }) {
  if (rows.length === 0) return null;
  // Same display cap as the Added/Changed/Deleted buckets. Content matching is
  // on by default and a from-scratch re-export can produce one match record per
  // element, so without this the default-on path is the one that floods the DOM.
  // Header count and `onFocusGroup` keep the FULL set - only the buttons are
  // capped, and the remainder is reported rather than silently dropped.
  const shown = rows.length > MAX_ROWS_PER_GROUP ? rows.slice(0, MAX_ROWS_PER_GROUP) : rows;
  const truncated = rows.length - shown.length;
  return (
    <div>
      <button
        type="button"
        onClick={() => onFocusGroup(rows)}
        title={title}
        className="group w-full flex items-center gap-1.5 px-1 py-1 text-xs font-medium rounded hover:bg-muted transition-colors"
      >
        <Icon className="h-3.5 w-3.5" style={{ color: rgbaCss(color) }} />
        <span>{label}</span>
        <span className="text-muted-foreground">({rows.length})</span>
        <MousePointerClick className="h-3 w-3 ml-auto opacity-0 group-hover:opacity-60 transition-opacity" />
      </button>
      <div className="space-y-0.5">
        {shown.map((row) => (
          <button
            key={row.key}
            onClick={() => onFocus(row)}
            title={MATCH_KIND_HINT[row.kind]}
            className={cn(
              'w-full text-left rounded px-2 py-1 flex items-center gap-2 hover:bg-muted transition-colors min-w-0',
              selectedKey === row.key && 'bg-muted',
            )}
          >
            <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: rgbaCss(color) }} />
            <span className="min-w-0 flex-1 truncate text-xs">{row.name || row.ifcType}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{matchRowSummary(row)}</span>
          </button>
        ))}
        {truncated > 0 && (
          <p className="px-2 py-1 text-[10px] text-muted-foreground">
            +{truncated} more not shown
          </p>
        )}
      </div>
    </div>
  );
}

export function CompareMatchGroups({ rows, selectedKey, onFocus, onFocusGroup }: MatchSectionProps) {
  const matched = rows.filter((row) => row.retiring);
  const review = rows.filter((row) => !row.retiring);
  return (
    <>
      <MatchSection
        rows={matched}
        selectedKey={selectedKey}
        onFocus={onFocus}
        onFocusGroup={onFocusGroup}
        label="Matched"
        title="Select all content-matched elements in 3D"
        color={COMPARE_COLORS.matched}
        Icon={Link2}
      />
      <MatchSection
        rows={review}
        selectedKey={selectedKey}
        onFocus={onFocus}
        onFocusGroup={onFocusGroup}
        label="Needs review"
        title="Select every candidate in the unresolved match groups"
        color={REVIEW_COLOR}
        Icon={TriangleAlert}
      />
    </>
  );
}
