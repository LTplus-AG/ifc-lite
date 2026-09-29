/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `grid.place`'s bar controls (charter #6232, D3), after its typed fields:
 * how the axes are tagged (1, 2, 3 across and A, B, C down, or the other way
 * round) and the axes the grid has as it stands. The choice is the next
 * grid's too.
 */

import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { updateCommandGesture } from '@/lib/commands/modeling/runtime';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { planGrid, withGridSettings, type GridPlaceGesture, type GridTagScheme } from '@/lib/commands/modeling/commands/grid-place-geometry';
import { HudDivider, HudSegmented } from '../../../viewport-ui/hud';

const TAG_KEYS: Record<GridTagScheme, TranslationKey> = {
  numbers: 'grid.tags.numbers',
  letters: 'grid.tags.letters',
};

export function GridPlaceBar({ gesture }: CommandHudProps<GridPlaceGesture>) {
  const { t, locale } = useTranslation();
  const plan = planGrid(gesture, 0);
  return (
    <>
      <HudDivider />
      <HudSegmented
        aria-label={t('grid.tags.label')}
        options={(['numbers', 'letters'] as const).map((value) => ({ value, label: t(TAG_KEYS[value]) }))}
        value={gesture.tags}
        onChange={(tags) => updateCommandGesture((g) => withGridSettings(g as GridPlaceGesture, { tags }))}
      />
      {plan.ok && (
        <span className="text-2xs tabular-nums text-overlay-ink-muted" data-grid-summary>
          {t('grid.summary', { uAxes: formatLocaleNumber(locale, plan.uAxes), vAxes: formatLocaleNumber(locale, plan.vAxes) })}
        </span>
      )}
    </>
  );
}
