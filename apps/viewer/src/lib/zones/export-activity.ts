/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { captureTranslation } from '@/i18n/registry';
import { beginActivity, finishActivity, updateActivity } from '@/lib/activity/activity-journal';
import type { ZoneGeometryExportResult } from '@/hooks/useZoneGeometrySplit';
import type { ZoneSplitProgress } from './split-worker-client';

/** Called only after the native binding/zone/busy preflight acquires its lease (#7142). */
export async function recordZoneGeometryExport(subject: string,
  run: (progress: ZoneSplitProgress) => Promise<ZoneGeometryExportResult>): Promise<ZoneGeometryExportResult> {
  const t = captureTranslation();
  const id = beginActivity({ kind: 'export', title: 'activityTray.job.zoneGeometry', panel: 'zones', subject });
  try {
    const result = await run((done, total) => updateActivity(id, { progress: { done, total } }));
    if (!result.ok) {
      finishActivity(id, 'failed', { detailKey: 'zonesPanel.exportNothingToExport' });
    } else {
      const { whole, cut, refused, noGeometry } = result.summary;
      finishActivity(id, refused + noGeometry > 0 ? 'partial' : 'completed', refused + noGeometry > 0
        ? { detail: t('activityTray.zone.geometryPartial', { whole, cut, refused, missing: noGeometry }) } : {});
    }
    return result;
  } catch (error) {
    finishActivity(id, 'failed', { detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
