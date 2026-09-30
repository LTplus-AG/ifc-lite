/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.pushPull`'s bar controls (charter #6232, C4), after its size
 * field: which face is grabbed and how far it has moved, and what the drag
 * snapped to. The size itself is the command's typed field.
 */

import { useTranslation } from '@/i18n';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { faceOf, sizeOf, type PushPullGesture } from '@/lib/push-pull/push-pull-gesture';
import { HudDivider } from '../../../viewport-ui/hud';
import { formatMetres } from '../../model-inspector/inspector-fields';

export function PushPullBar({ gesture }: CommandHudProps<PushPullGesture>) {
  const { t } = useTranslation();
  const face = faceOf(gesture);
  const size = sizeOf(gesture);
  if (!face || size === null) return null;
  const delta = size - face.size;
  const sign = delta >= 0 ? '+' : '−';
  return (
    <>
      <HudDivider />
      <span className="text-2xs text-overlay-ink-muted" data-push-pull-readout>
        {t('pushPull.bar.readout', { face: t(face.labelKey), delta: `${sign}${formatMetres(Math.abs(delta))}` })}
      </span>
      {gesture.snapped && (
        <span className="text-2xs text-overlay-ink-muted">{t(gesture.snapped === 'level' ? 'pushPull.bar.snapLevel' : 'pushPull.bar.snapStep')}</span>
      )}
    </>
  );
}
