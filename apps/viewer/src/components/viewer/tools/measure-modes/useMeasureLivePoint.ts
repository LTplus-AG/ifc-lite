/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { measureLivePoint } from './readouts';

/** {@link measureLivePoint} over the store, shared by the Point tab and the HUD readouts. */
export function useMeasureLivePoint() {
  const measureMode = useViewerStore((s) => s.measureMode);
  const activeMeasurement = useViewerStore((s) => s.activeMeasurement);
  const measurements = useViewerStore((s) => s.measurements);
  const measurePointLive = useViewerStore((s) => s.measurePointLive);
  const measurePointLast = useViewerStore((s) => s.measurePointLast);
  return measureLivePoint({ measureMode, activeMeasurement, measurements, measurePointLive, measurePointLast });
}
