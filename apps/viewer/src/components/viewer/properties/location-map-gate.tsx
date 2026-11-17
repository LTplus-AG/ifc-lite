/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The location map's tiles come from an outside map service. A deploying
 * host can switch such requests off (`privacy.third-party`, see
 * `lib/features`); the map is then not mounted, so no tile is requested.
 * Its own module because `LocationMap.tsx` and its caller are at their size
 * budgets.
 */

import { isFeatureEnabled } from '@/lib/features';
import { LocationMap as HostedLocationMap, type LocationMapProps } from './LocationMap';

export type { PickedPosition } from './LocationMap';

export function LocationMap(props: LocationMapProps) {
  return isFeatureEnabled('privacy.third-party') ? <HostedLocationMap {...props} /> : null;
}
