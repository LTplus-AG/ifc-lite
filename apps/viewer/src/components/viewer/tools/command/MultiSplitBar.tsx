/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `split.multi`'s bar (charter #6232, C5): whose elements the cut takes, how
 * many the line splits so far, and how many it crosses but cannot split. The
 * refused ones are named, with their reasons, in the refused count's tooltip
 * and beside each of them in the scene and the plan.
 */

import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import type { MultiSplitGesture } from '@/lib/commands/modeling/commands/multi-split';
import { HudDivider } from '../../../viewport-ui/hud';

export function MultiSplitBar({ gesture }: CommandHudProps<MultiSplitGesture>) {
  const { t, locale } = useTranslation();
  const { plan, targets, mode } = gesture;
  const count = (n: number) => ({ count: n, countDisplay: formatLocaleNumber(locale, n) });
  const refused = plan.refused.map((r) => `${r.label}: ${r.reason}`).join('\n');
  return (
    <>
      <HudDivider />
      <span className="whitespace-nowrap px-1 text-xs text-muted-foreground" data-multi-split="scope">
        {t(mode === 'selection' ? 'multiSplit.scope.selection' : 'multiSplit.scope.storey', count(targets.length))}
      </span>
      <HudDivider />
      <span
        className={`whitespace-nowrap px-1 text-xs tabular-nums ${plan.splits.length > 0 ? 'text-overlay-accent' : 'text-muted-foreground'}`}
        data-multi-split="splits"
        data-count={plan.splits.length}
      >
        {t('multiSplit.bar.splits', count(plan.splits.length))}
      </span>
      {plan.refused.length > 0 && (
        <span
          className="whitespace-nowrap px-1 text-xs tabular-nums text-status-danger"
          data-multi-split="refused"
          data-count={plan.refused.length}
          title={refused}
        >
          {t('multiSplit.bar.refused', count(plan.refused.length))}
        </span>
      )}
    </>
  );
}
