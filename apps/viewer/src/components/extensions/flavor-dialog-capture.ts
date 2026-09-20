/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { serializeClashConfig } from '@/lib/clash/persistence.flavor';

/** Snapshot the current clash rule-set + detection settings for a flavor's
 *  `settings.clash` blob, so each profile carries its own clash config. */
export function captureClashConfig(): unknown {
  const s = useViewerStore.getState();
  return serializeClashConfig(s.clashPresets, {
    mode: s.clashMode,
    tolerance: s.clashTolerance,
    clearance: s.clashClearance,
    duplicateTolerance: s.clashDuplicateTolerance,
    clusterEpsilon: s.clashClusterEpsilon,
    reportTouch: s.clashReportTouch,
    groupBy: s.clashGroupBy,
  });
}
