/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The storeys to scale (#9013): a section strip, one floor line per storey
 * at its elevation, its floor-to-floor height between them. While an edit is
 * previewed, the floors it moves show where they were (dashed) as well as
 * where they go. Each floor is a button that makes it the storey to draw on;
 * the strip is a shortcut beside the list, not the only way to do anything.
 */

import type { StoreyLevelPlan, StoreySummary } from '@ifc-lite/create';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatElevation, formatHeight } from '@/lib/storeys/storey-length';

interface StoreySectionStripProps {
  /** Highest first. */
  rows: readonly StoreySummary[];
  activeId: number | null;
  plan: StoreyLevelPlan | null;
  onActivate: (storeyId: number) => void;
}

/** Strip height per metre, clamped so a tall tower still fits and a basement still reads. */
const PX_PER_M = 14;
const MIN_GAP_PX = 18;
const TOP_PX = 22;

export function StoreySectionStrip({ rows, activeId, plan, onActivate }: StoreySectionStripProps) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  const top = rows[0];
  const ys = new Map<number, number>();
  let y = TOP_PX;
  rows.forEach((row, index) => {
    if (index > 0) y += Math.max(MIN_GAP_PX, (rows[index - 1].elevation - row.elevation) * PX_PER_M);
    ys.set(row.expressId, y);
  });
  const height = y + 12;
  const moved = new Map((plan?.storeys ?? []).map((move) => [move.expressId, move]));
  const ghostY = (storeyId: number) => {
    const move = moved.get(storeyId);
    const at = ys.get(storeyId);
    if (!move || at === undefined) return null;
    // The preview already moved the row; its old floor sits back by the delta, to the same scale.
    return at + (move.to - move.from) * PX_PER_M;
  };

  return (
    <figure aria-label={t('storeyManager.strip.label')} data-storey-strip className="relative w-full select-none" style={{ height }}>
      <div aria-hidden className="absolute bottom-1.5 left-2 top-1 w-px bg-border" />
      {rows.map((row) => {
        const at = ys.get(row.expressId)!;
        const ghost = ghostY(row.expressId);
        const active = row.expressId === activeId;
        return (
          <div key={row.expressId}>
            {ghost !== null && Math.abs(ghost - at) > 1 && (
              <div aria-hidden data-storey-strip-ghost className="absolute left-2 right-1 border-t border-dashed border-overlay-accent/70" style={{ top: ghost }} />
            )}
            <Button
              type="button"
              variant="ghost"
              data-storey-strip-level={row.expressId}
              aria-label={t('storeyManager.strip.level', { storey: row.Name, elevation: formatElevation(row.elevation) })}
              aria-pressed={active}
              onClick={() => onActivate(row.expressId)}
              className={cn(
                'absolute left-0 right-0 h-5 -translate-y-1/2 justify-start gap-1.5 rounded-sm px-1 py-0 text-2xs font-normal',
                active ? 'text-overlay-accent' : 'text-muted-foreground',
              )}
              style={{ top: at }}
            >
              <span aria-hidden className={cn('h-0.5 w-6 shrink-0 rounded-full', active ? 'bg-overlay-accent' : 'bg-foreground/50')} />
              <span className="min-w-0 flex-1 truncate text-left">{row.Name}</span>
              <span className="shrink-0 tabular-nums">{formatElevation(row.elevation)}</span>
            </Button>
            {row.height !== null && row !== top && (
              <span aria-hidden className="pointer-events-none absolute left-3 text-2xs tabular-nums text-muted-foreground/80" style={{ top: at - Math.max(MIN_GAP_PX, row.height * PX_PER_M) / 2 - 6 }}>
                {formatHeight(row.height)}
              </span>
            )}
          </div>
        );
      })}
    </figure>
  );
}
