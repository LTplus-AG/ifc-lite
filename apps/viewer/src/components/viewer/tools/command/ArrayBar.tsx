/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.array`'s bar controls (#6232 C3), after its Count and distance
 * fields: Linear / Polar, and for a linear array whether the clicked
 * distance is one step (Spacing) or the whole array (Fit).
 */

import { useTranslation } from '@/i18n';
import { updateCommandGesture } from '@/lib/commands/modeling/runtime';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import type { ArrayGesture, ArrayMode } from '@/lib/commands/modeling/commands/element-array';
import { HudDivider, HudSegmented } from '../../../viewport-ui/hud';

export function ArrayBar({ gesture }: CommandHudProps<ArrayGesture>) {
  const { t } = useTranslation();
  return (
    <>
      <HudDivider />
      <HudSegmented
        aria-label={t('copyArray.mode.label')}
        options={[
          { value: 'linear', label: t('copyArray.mode.linear') },
          { value: 'polar', label: t('copyArray.mode.polar') },
        ]}
        value={gesture.mode}
        // The first click means another thing in the other mode: start again.
        onChange={(mode: ArrayMode) => updateCommandGesture((g) => ({ ...(g as ArrayGesture), mode, anchor: null, distance: null }))}
      />
      {gesture.mode === 'linear' && (
        <HudSegmented
          aria-label={t('copyArray.fit.label')}
          options={[
            { value: 'spacing', label: t('copyArray.fit.spacing'), title: t('copyArray.fit.spacingTitle') },
            { value: 'fit', label: t('copyArray.fit.fit'), title: t('copyArray.fit.fitTitle') },
          ]}
          value={gesture.fit ? 'fit' : 'spacing'}
          onChange={(value) => updateCommandGesture((g) => ({ ...(g as ArrayGesture), fit: value === 'fit' }))}
        />
      )}
    </>
  );
}
