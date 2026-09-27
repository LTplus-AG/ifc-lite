/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AddElementType } from '@/store/slices/addElementSlice';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

interface DropGuidanceProps {
  ready: boolean;
  disabledReason?: string;
  type: AddElementType;
  slabMode: 'rectangle' | 'polygon';
  pendingCount: number;
  hoverDistance: number | null;
  onClearPending: () => void;
}

/** Stateful guidance pane — mirrors the multi-click flow so the user always knows what comes next. */
export function DropGuidance({ ready, disabledReason, type, slabMode, pendingCount, hoverDistance, onClearPending }: DropGuidanceProps) {
  const { t, locale } = useTranslation();
  if (!ready) {
    return (
      <section className="mt-2 rounded-sm border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-3 text-2xs font-mono text-zinc-500 dark:text-zinc-400">
        {disabledReason ?? t('addElement.guidance.disabled')}
      </section>
    );
  }

  let primary: string;
  let secondary: string;
  // Single-click placements share the same prompt shape.
  if (type === 'column' || type === 'door' || type === 'window') {
    primary = t(`addElement.guidance.single.${type}` as TranslationKey);
    secondary = t('addElement.guidance.single.secondary');
  } else if (type === 'wall' || type === 'beam' || type === 'member') {
    // Two-click axial placements (start → end).
    if (pendingCount === 0) {
      primary = t(`addElement.guidance.axis.${type}Start` as TranslationKey);
      secondary = t('addElement.guidance.axis.startSecondary');
    } else {
      primary = t(`addElement.guidance.axis.${type}End` as TranslationKey);
      secondary = hoverDistance !== null
        ? t('addElement.guidance.axis.length', { length: formatLocaleNumber(locale, hoverDistance, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })
        : t('addElement.guidance.restart');
    }
  } else {
    // slab / roof / plate / space — rectangle (2 clicks) or polygon (N + Enter).
    if (slabMode === 'rectangle') {
      if (pendingCount === 0) {
        primary = t(`addElement.guidance.rectangle.${type}First` as TranslationKey);
        secondary = t('addElement.guidance.rectangle.firstSecondary');
      } else {
        primary = t('addElement.guidance.rectangle.opposite');
        secondary = t('addElement.guidance.rectangle.oppositeSecondary');
      }
    } else {
      if (pendingCount === 0) {
        primary = t(`addElement.guidance.polygon.${type}First` as TranslationKey);
        secondary = t('addElement.guidance.polygon.firstSecondary');
      } else if (pendingCount < 3) {
        primary = t('addElement.guidance.polygon.needPoint', { point: formatLocaleNumber(locale, pendingCount + 1) });
        secondary = t('addElement.guidance.restart');
      } else {
        primary = t('addElement.guidance.polygon.nextPoint', { point: formatLocaleNumber(locale, pendingCount + 1) });
        secondary = t('addElement.guidance.polygon.restart');
      }
    }
  }

  return (
    <section
      className="mt-2 rounded-sm border border-emerald-300 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20 p-3 text-2xs font-mono leading-relaxed text-emerald-800 dark:text-emerald-300"
      aria-live="polite"
    >
      <div className="flex items-start gap-2 justify-between">
        <div className="min-w-0">
          <span className="block font-semibold">{primary}</span>
          <span className="block text-2xs opacity-80 mt-0.5">{secondary}</span>
        </div>
        {pendingCount > 0 && (
          <button
            type="button"
            onClick={onClearPending}
            className="shrink-0 text-2xs underline-offset-2 hover:underline opacity-80 hover:opacity-100"
            aria-label={t('addElement.guidance.discardAria')}
          >
            {t('addElement.guidance.reset')}
          </button>
        )}
      </div>
    </section>
  );
}
