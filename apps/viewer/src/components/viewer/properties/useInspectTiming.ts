/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react';
import { fieldTelemetry } from '@/lib/perf/fieldTelemetryLoader';

/**
 * `ifc_inspect` (#6961): tell the field module the panel has committed
 * `populatedGlobalId`'s properties (null while it shows anything else). The
 * module only acts when that id is the one a sampled viewport click selected.
 */
export function useInspectTiming(populatedGlobalId: number | null): void {
  useEffect(() => {
    if (populatedGlobalId !== null) fieldTelemetry?.noteInspectPopulated(populatedGlobalId);
  }, [populatedGlobalId]);
}
