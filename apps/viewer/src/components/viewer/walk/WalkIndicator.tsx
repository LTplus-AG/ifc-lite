/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Walk-mode readout: the walker's state and its keys, bottom-centre while the
 * Walk tool is active. `pointer-events-none` like the fly readout, since it
 * sits where a mouse-look drag passes.
 */

import { useSyncExternalStore } from 'react';
import { useTranslation } from '@/i18n';
import { HudHint, HudItem } from '../../viewport-ui/hud';
import { walkStatusStore } from './walkStatusStore.js';

export function WalkIndicator() {
  const { active, physics, crouching } = useSyncExternalStore(walkStatusStore.subscribe, walkStatusStore.get);
  const { t } = useTranslation();
  if (!active) return null;
  const state = !physics
    ? t('viewportLighting.walk.floating')
    : crouching ? t('viewportLighting.walk.crouching') : t('viewportLighting.walk.walking');
  return (
    <HudItem region="bottom-center" order={11}>
      <HudHint className="rounded-md bg-popover/80 px-2.5 py-1 backdrop-blur-sm">
        {state}
        <span className="ml-1.5 text-overlay-ink-muted">{t('viewportLighting.walk.hint')}</span>
      </HudHint>
    </HudItem>
  );
}
