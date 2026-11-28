/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isUuid, type ReportCorrelation } from '@ifc-lite/report-contract';
import { attachLoadCorrelation } from './context';

/** The captured error event and build only; the analytics session ID stays out of the report. */
export function reportCorrelation(capture: { uuid: string; properties: Record<string, unknown> } | undefined): ReportCorrelation | undefined {
  if (!capture || !isUuid(capture.uuid) || typeof capture.properties.app_build_sha !== 'string') return;
  return { eventId: capture.uuid, buildSha: capture.properties.app_build_sha };
}
export function attachCapturedLoad(file: File, capture: Parameters<typeof reportCorrelation>[0]): void {
  const correlation = reportCorrelation(capture);
  if (correlation) attachLoadCorrelation(file, correlation);
}
