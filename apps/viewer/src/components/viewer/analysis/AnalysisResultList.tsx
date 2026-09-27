/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The virtualised analysis result list (#5834), extracted from the IDS entity
 * list (#5830) and the Clash result list (#1277), which each carried their own
 * copy of the same `useVirtualizer` wiring. Every row is measured after it
 * renders, so rows that expand (an IDS entity's details, a Clash detail row)
 * keep the rows below them in place.
 *
 * No cap: a result of any size is listed in full, only the visible window is
 * mounted. `children` render inside the scroll container above the rows,
 * where a panel puts its "nothing matches" states.
 *
 * Row activation is the panel's: what a row selects, how it frames and which
 * focus mode it applies live in the panel's hook (`focusEntity`, `focusClash`,
 * `focusRefs`), so the one row-click rule is enforced there and tested per
 * panel, not re-implemented here.
 */

import { useRef, type HTMLAttributes, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';

interface AnalysisResultListProps<T> extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  /** First-paint height guess; the measured height wins once a row renders. */
  estimateSize: (item: T, index: number) => number;
  renderRow: (item: T, index: number) => ReactNode;
  overscan?: number;
  rowClassName?: string;
  children?: ReactNode;
}

export function AnalysisResultList<T>({
  items, getKey, estimateSize, renderRow, overscan = 8, rowClassName, className, children, ...rest
}: AnalysisResultListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateSize(items[index], index),
    getItemKey: (index) => getKey(items[index], index),
    overscan,
  });

  return (
    <div ref={scrollRef} className={cn('overflow-auto', className)} {...rest}>
      {children}
      {items.length > 0 && (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((row) => (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className={cn('absolute left-0 top-0 w-full', rowClassName)}
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {renderRow(items[row.index], row.index)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
