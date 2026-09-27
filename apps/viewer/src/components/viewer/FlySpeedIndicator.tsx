/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fly speed readout: shown while the right mouse button is held (fly mode)
 * and briefly after the wheel changes the speed, so the user can see which
 * of the speed levels they are on without a permanent HUD.
 *
 * Mounted as a bottom-center HUD readout (#5504, charter #5478 item 22),
 * `pointer-events-none` like `HudHint`: it can appear directly under the
 * cursor during a fly gesture, so it must never intercept the mouse move
 * that is steering the camera.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { flySpeedStore } from './flySpeedStore.js';
import { FLY_SPEED_LEVELS } from './flyNavigation.js';
import { useTranslation } from '@/i18n';
import { HudHint, HudItem } from '../viewport-ui/hud';

/** How long the readout lingers after a speed change once fly mode has ended. */
const LINGER_MS = 1200;

export function FlySpeedIndicator() {
  const { level, active, changedAt } = useSyncExternalStore(flySpeedStore.subscribe, flySpeedStore.get);
  const [lingering, setLingering] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    const remaining = changedAt + LINGER_MS - performance.now();
    if (remaining <= 0) return;
    setLingering(true);
    const timer = setTimeout(() => setLingering(false), remaining);
    return () => clearTimeout(timer);
  }, [changedAt]);

  if (!active && !lingering) return null;
  const multiplier = FLY_SPEED_LEVELS[level];

  return (
    <HudItem region="bottom-center" order={10}>
      <HudHint className="rounded-md bg-popover/80 px-2.5 py-1 backdrop-blur-sm">
        {t('viewportLighting.flySpeed.label', { level: level + 1, total: FLY_SPEED_LEVELS.length })}
        <span className="ml-1.5 tabular-nums text-overlay-ink-muted">×{multiplier}</span>
      </HudHint>
    </HudItem>
  );
}
