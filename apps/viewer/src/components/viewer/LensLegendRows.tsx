/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { memo } from 'react';
import type { LensRule, AutoColorLegendEntry } from '@/store/slices/lensSlice';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';

/** Format large counts compactly: 1234 → "1.2k" */
function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

// ─── Rule display (read-only, clickable for isolation) ──────────────────────

export const RuleRow = memo(function RuleRow({
  rule,
  count,
  isIsolated,
  onClick,
}: {
  rule: LensRule;
  count: number;
  isIsolated?: boolean;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const isEmpty = count === 0;
  const isClickable = !!onClick && !isEmpty;

  return (
    <button
      type="button"
      disabled={!isClickable}
      aria-pressed={!!isIsolated}
      className={cn(
        'group/row relative flex w-full items-center gap-2 pl-3 pr-3 py-1.5 text-left text-xs',
        'border-l-2 transition-[border-color,background-color] duration-100',
        !rule.enabled && 'opacity-40',
        !isIsolated && !isEmpty && 'border-l-transparent',
        isClickable && 'cursor-pointer hover:border-l-primary/70 hover:bg-zinc-100/80 dark:hover:bg-zinc-700/40',
        isIsolated && 'border-l-primary bg-primary/8 dark:bg-primary/15',
        isEmpty && 'border-l-transparent opacity-50 cursor-default',
      )}
      onClick={(e) => { if (isClickable) { e.stopPropagation(); onClick(); } }}
      title={isClickable ? t('lensPanel.ruleRow.isolateTooltip') : isEmpty ? t('lensPanel.ruleRow.emptyTooltip') : undefined}
    >
      <span
        className={cn(
          'w-3 h-3 rounded-sm flex-shrink-0 ring-1 ring-black/10 dark:ring-white/20',
          isEmpty && 'grayscale',
        )}
        style={{ backgroundColor: rule.color }}
      />
      <span className={cn(
        'flex-1 truncate font-medium',
        isIsolated
          ? 'text-zinc-900 dark:text-zinc-50'
          : isEmpty
            ? 'text-zinc-400 dark:text-zinc-600'
            : 'text-zinc-900 dark:text-zinc-50',
      )}>
        {rule.name}
      </span>
      {isIsolated && (
        <span className="text-2xs uppercase tracking-wider font-bold text-primary">
          {t('lensPanel.isolatedBadge')}
        </span>
      )}
      <span className={cn(
        'text-2xs tabular-nums font-mono min-w-[2ch] text-right',
        isEmpty
          ? 'text-zinc-300 dark:text-zinc-700'
          : 'text-zinc-400 dark:text-zinc-500',
      )}>
        {isEmpty ? '—' : formatCount(count)}
      </span>
    </button>
  );
});

// ─── Auto-color legend row (read-only, clickable for isolation) ─────────────

export const AutoColorRow = memo(function AutoColorRow({
  entry,
  isIsolated,
  onClick,
}: {
  entry: AutoColorLegendEntry;
  isIsolated?: boolean;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const isEmpty = entry.count === 0;
  const isClickable = !!onClick && !isEmpty;

  return (
    <button
      type="button"
      disabled={!isClickable}
      aria-pressed={!!isIsolated}
      className={cn(
        'group/row relative flex w-full items-center gap-2 pl-3 pr-3 py-1.5 text-left text-xs',
        'border-l-2 transition-[border-color,background-color] duration-100',
        !isIsolated && !isEmpty && 'border-l-transparent',
        isClickable && 'cursor-pointer hover:border-l-primary/70 hover:bg-zinc-100/80 dark:hover:bg-zinc-700/40',
        isIsolated && 'border-l-primary bg-primary/8 dark:bg-primary/15',
        isEmpty && 'border-l-transparent opacity-50 cursor-default',
      )}
      onClick={(e) => { if (isClickable) { e.stopPropagation(); onClick(); } }}
      title={isClickable ? t('lensPanel.autoColorRow.isolateTooltip') : undefined}
    >
      <span
        className="w-3 h-3 rounded-sm flex-shrink-0 ring-1 ring-black/10 dark:ring-white/20"
        style={{ backgroundColor: entry.color }}
      />
      <span
        className={cn(
          'flex-1 truncate font-medium text-zinc-900 dark:text-zinc-50',
          // Absence buckets ("No classification", "Not in this system") are
          // synthetic - not a value read off the model - so they're set in
          // italics to read as a category rather than a classification code,
          // while staying otherwise identical (same swatch shape, same
          // clickable/isolate behavior) so they don't look broken or special.
          entry.isAbsent && 'italic text-zinc-600 dark:text-zinc-300',
        )}
      >
        {entry.name}
      </span>
      {isIsolated && (
        <span className="text-2xs uppercase tracking-wider font-bold text-primary">
          {t('lensPanel.isolatedBadge')}
        </span>
      )}
      <span className="text-2xs tabular-nums font-mono min-w-[2ch] text-right text-zinc-400 dark:text-zinc-500">
        {formatCount(entry.count)}
      </span>
    </button>
  );
});
