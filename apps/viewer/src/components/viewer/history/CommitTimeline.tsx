/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scrollable list of commits.
 *
 * Virtualized past {@link VIRTUALIZE_ABOVE} rows only. A model with twelve
 * commits — which is most of them — renders as plain DOM, so the list keeps
 * native find-in-page and keyboard scrolling; a model with a thousand gets
 * the virtualizer, and the 60 fps budget with it.
 */

import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import type { CommitRowModel } from '@/lib/history/commitGraph';
import { CommitRow, type CommitRowAction } from './CommitRow';

/** Below this the list is plain DOM; at or above it the virtualizer takes over. */
const VIRTUALIZE_ABOVE = 200;

/** Matches the row's own padding + two text lines; the virtualizer measures the rest. */
const ESTIMATED_ROW_HEIGHT = 58;

export interface CommitTimelineProps {
  readonly rows: readonly CommitRowModel[];
  readonly canOpen: boolean;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onAction: (action: CommitRowAction, row: CommitRowModel) => void;
  readonly onLoadMore: () => void;
}

export function CommitTimeline({ rows, canOpen, hasMore, loadingMore, onAction, onLoadMore }: CommitTimelineProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualize = rows.length >= VIRTUALIZE_ABOVE;

  const virtualizer = useVirtualizer({
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => rows[index].commit.id,
  });

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div role="list" aria-label={t('history.timeline.label')}>
        {virtualize ? (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <CommitRow row={rows[item.index]} canOpen={canOpen} onAction={onAction} />
              </div>
            ))}
          </div>
        ) : (
          rows.map((row) => (
            <CommitRow key={row.commit.id} row={row} canOpen={canOpen} onAction={onAction} />
          ))
        )}
      </div>
      {hasMore && (
        <div className="p-2 text-center">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onLoadMore} disabled={loadingMore}>
            {t('history.timeline.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
