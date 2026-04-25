/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Result rendering for the Filter modal — virtualised table, error
 * box, and the run-summary line. Pure presentation; the orchestrator
 * passes the result snapshot.
 */

import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Combinator } from '@/lib/search/filter-rules';

const RESULT_ROW_HEIGHT = 28;

export function RuleSummary({
  ruleCount,
  combinator,
  limit,
}: {
  ruleCount: number;
  combinator: Combinator;
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
      <span className="font-mono">{combinator}</span>
      <span className="mx-1">·</span>
      limit{' '}
      <span className="font-mono text-foreground">
        {limit > 0 ? limit.toLocaleString() : '∞'}
      </span>
    </span>
  );
}

export function FilterErrorBox({ raw }: { raw: string }) {
  return (
    <div className="border-b bg-red-50/50 px-4 py-3 dark:bg-red-950/20">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
        <div className="min-w-0 flex-1 text-xs">
          <div className="font-semibold text-red-900 dark:text-red-200">Filter failed</div>
          <div className="mt-1 break-words text-red-800 dark:text-red-300">{raw}</div>
        </div>
      </div>
    </div>
  );
}

export interface FilterResultTableProps {
  result: { columns: string[]; rows: unknown[][] } | null;
  selectionKeyIndex: number;
  onRowClick: (row: unknown[]) => void;
}

export function FilterResultTable({ result, selectionKeyIndex, onRowClick }: FilterResultTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: result?.rows.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => RESULT_ROW_HEIGHT,
    overscan: 20,
  });

  if (!result) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        Add rules and click Run.
      </div>
    );
  }

  if (result.rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        0 matches — broaden the rules, lower the limit, or try OR.
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex items-center border-b bg-zinc-50/50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground dark:bg-zinc-900/30">
        {result.columns.map((c) => (
          <div key={c} className="flex-1 truncate px-2 font-mono">
            {c}
          </div>
        ))}
      </div>
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vRow) => {
            const row = result.rows[vRow.index];
            const clickable = selectionKeyIndex >= 0;
            return (
              <div
                key={vRow.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: vRow.size,
                  transform: `translateY(${vRow.start}px)`,
                }}
                className={cn(
                  'flex items-center border-b border-zinc-100 px-3 text-[11px] dark:border-zinc-900',
                  clickable && 'cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800',
                )}
                onClick={() => clickable && onRowClick(row)}
              >
                {result.columns.map((_, i) => (
                  <div key={i} className="flex-1 truncate px-2 font-mono">
                    {formatCell(row[i])}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
