/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
export function StaleMeasurementBadge({ id }: { id: string }) {
  const stale = useViewerStore((state) => state.placementStaleMeasurements.has(id));
  return stale ? <span className="text-amber-700" title="Model positions changed. These points remain at their old workspace coordinates; re-measure to validate."> · Stale</span> : null;
}
