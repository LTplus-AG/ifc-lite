/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Stair and Railing commands' own bar controls (charter #6232, D1), after
 * their typed fields: what the stair will climb (how many risers, to which
 * storey) and the railing's point count and length, with a Finish button for
 * touch users, who have no Enter or double-click.
 */

import { Check } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { useViewerStore } from '@/store';
import { commitCommand } from '@/lib/commands/modeling/runtime';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { stairRise, type StairPlaceGesture } from '@/lib/commands/modeling/commands/stair-place-geometry';
import { pathLength, pathOf, type RailingPlaceGesture } from '@/lib/commands/modeling/commands/railing-place-geometry';
import { formatDistance } from '../formatDistance';
import { HudDivider } from '../../../viewport-ui/hud';

export function StairPlaceBar({ ctx }: CommandHudProps<StairPlaceGesture>) {
  const { t, locale } = useTranslation();
  // The storey above and the dimensions the flight is fitted to can change under a running command.
  useViewerStore((s) => s.mutationVersion);
  const fit = stairRise(ctx);
  const countDisplay = formatLocaleNumber(locale, fit.risers);
  return (
    <>
      <HudDivider />
      <span className="whitespace-nowrap px-1 text-2xs tabular-nums text-overlay-ink-muted" data-stair-summary>
        {fit.upperName === null
          ? t('stairRailing.stair.risersFree', { count: fit.risers, countDisplay })
          : t('stairRailing.stair.risers', { count: fit.risers, countDisplay, storey: fit.upperName })}
      </span>
    </>
  );
}

export function RailingPlaceBar({ gesture }: CommandHudProps<RailingPlaceGesture>) {
  const { t, locale } = useTranslation();
  const overrides = useViewerStore((s) => s.unitDisplayOverrides);
  const path = pathOf(gesture);
  return (
    <>
      <HudDivider />
      {path.length > 0 && (
        <span className="whitespace-nowrap px-1 text-2xs tabular-nums text-overlay-ink-muted" data-railing-summary>
          {t('stairRailing.railing.summary', {
            count: path.length, countDisplay: formatLocaleNumber(locale, path.length), length: formatDistance(pathLength(path), overrides),
          })}
        </span>
      )}
      <button
        type="button"
        onClick={() => { commitCommand(); }}
        disabled={path.length < 2}
        title={t('stairRailing.railing.finishTitle')}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Check aria-hidden className="h-3.5 w-3.5" />
        {t('stairRailing.railing.finish')}
      </button>
    </>
  );
}
