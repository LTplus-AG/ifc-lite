/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Status / control strip above the results table. Shows the active grouping
 * and sum columns as removable chips, plus expand/collapse and live totals —
 * the connective tissue between the table and the list definition.
 */

import { Group, Sigma, X, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ListGroupingBarProps {
  /** Active grouping columns, outermost first (multi-criteria, issue #1790). */
  groups: { id: string; label: string }[];
  sums: { id: string; label: string }[];
  groupCount: number;
  count: number;
  allExpanded: boolean;
  onRemoveGroup: (id: string) => void;
  onRemoveSum: (id: string) => void;
  onToggleExpandAll: () => void;
}

function Chip({ icon, children, onRemove, removeLabel = 'Remove' }: { icon: React.ReactNode; children: React.ReactNode; onRemove: () => void; removeLabel?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-0.5 pl-2 pr-1 text-[11px] font-medium text-foreground">
      {icon}
      <span className="max-w-[12rem] truncate">{children}</span>
      <button
        onClick={onRemove}
        className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-primary/20 hover:text-foreground"
        aria-label={removeLabel}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

export function ListGroupingBar({
  groups, sums, groupCount, count, allExpanded,
  onRemoveGroup, onRemoveSum, onToggleExpandAll,
}: ListGroupingBarProps) {
  const grouped = groups.length > 0;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/30 px-3 py-1.5 text-xs">
      {grouped && (
        <button
          onClick={onToggleExpandAll}
          className="mr-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          title={allExpanded ? 'Collapse all groups' : 'Expand all groups'}
        >
          {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
        </button>
      )}

      {grouped
        ? groups.map((g, i) => (
            <Chip key={g.id} icon={<Group className="h-3 w-3 text-primary" />} onRemove={() => onRemoveGroup(g.id)} removeLabel={`Remove grouping by ${g.label}`}>
              {i === 0 ? `Grouped by ${g.label}` : `then ${g.label}`}
            </Chip>
          ))
        : <span className="text-muted-foreground">No grouping — use a column&apos;s <span className="font-medium text-foreground">⋮</span> menu to group or sum</span>}

      {sums.map((s) => (
        <Chip key={s.id} icon={<Sigma className="h-3 w-3 text-primary" />} onRemove={() => onRemoveSum(s.id)} removeLabel={`Remove sum of ${s.label}`}>{s.label}</Chip>
      ))}

      <span className={cn('ml-auto whitespace-nowrap font-medium text-muted-foreground')}>
        {grouped && <>{groupCount.toLocaleString()} group{groupCount === 1 ? '' : 's'} · </>}
        {count.toLocaleString()} element{count === 1 ? '' : 's'}
      </span>
    </div>
  );
}
