/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fly speed readout: shown while the right mouse button is held (fly mode)
 * and briefly after the wheel changes the speed, so the user can see which
 * of the speed levels they are on without a permanent HUD.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { flySpeedStore } from './flySpeedStore.js';
import { FLY_SPEED_LEVELS } from './flyNavigation.js';

/** How long the readout lingers after a speed change once fly mode has ended. */
const LINGER_MS = 1200;

export function FlySpeedIndicator() {
  const { level, active, changedAt } = useSyncExternalStore(flySpeedStore.subscribe, flySpeedStore.get);
  const [lingering, setLingering] = useState(false);

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
    <div
      className="pointer-events-none absolute bottom-16 left-1/2 -translate-x-1/2 rounded-md bg-background/80 px-2.5 py-1 text-xs text-foreground/80 backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      Fly speed {level + 1}/{FLY_SPEED_LEVELS.length}
      <span className="ml-1.5 tabular-nums text-muted-foreground">×{multiplier}</span>
    </div>
  );
}
