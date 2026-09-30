/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `curtainwall.place`'s bar controls (charter #6232, D3), after its typed
 * fields: how many panels the wall divides into as it stands, so a panel size
 * typed into Panel W / Panel H shows its effect before the second click.
 */

import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { planCurtainWall, type CurtainWallGesture } from '@/lib/commands/modeling/commands/curtainwall-place-geometry';
import { HudDivider } from '../../../viewport-ui/hud';

export function CurtainWallPlaceBar({ gesture }: CommandHudProps<CurtainWallGesture>) {
  const { t, locale } = useTranslation();
  const plan = planCurtainWall(gesture, 0);
  if (!plan.ok) return null;
  return (
    <>
      <HudDivider />
      <span className="text-2xs tabular-nums text-overlay-ink-muted" data-curtain-wall-summary>
        {t('curtainWall.summary', { bays: formatLocaleNumber(locale, plan.bays), rows: formatLocaleNumber(locale, plan.rows) })}
      </span>
    </>
  );
}
