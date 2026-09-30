/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.align`'s bar controls (charter #6232, C4): which edge of the
 * reference the targets line up on, and how many are picked. The edge is a
 * choice of the running gesture, not a default of the next element, so it
 * writes the gesture.
 */

import { useTranslation, type TranslationKey } from '@/i18n';
import { updateCommandGesture } from '@/lib/commands/modeling/runtime';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { ALIGN_MODES, type AlignMode } from '@/lib/commands/modeling/align-boxes';
import { alignMoves, type AlignGesture } from '@/lib/commands/modeling/align-gesture';
import { HudDivider, HudSegmented } from '../../../viewport-ui/hud';

const MODE_KEYS: Record<AlignMode, TranslationKey> = {
  left: 'align.mode.left',
  centre: 'align.mode.centre',
  right: 'align.mode.right',
  top: 'align.mode.top',
  middle: 'align.mode.middle',
  bottom: 'align.mode.bottom',
};

export function AlignBar({ gesture }: CommandHudProps<AlignGesture>) {
  const { t } = useTranslation();
  return (
    <>
      <HudSegmented
        aria-label={t('align.mode.aria')}
        options={ALIGN_MODES.map((value) => ({ value, label: t(MODE_KEYS[value]) }))}
        value={gesture.mode}
        onChange={(mode) => updateCommandGesture((g) => ({ ...(g as AlignGesture), mode }))}
      />
      <HudDivider />
      <span className="text-2xs text-overlay-ink-muted" data-align-count>
        {t('align.bar.count', { targets: gesture.targets.length, moving: alignMoves(gesture).length })}
      </span>
    </>
  );
}
