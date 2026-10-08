/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { recordActivity } from '@/lib/activity/activity-journal';
import { downloadBlob } from '@/lib/export/download';

/** Native ZIP writing has no abort contract; each publication owns its row (#7140). */
export function publishBcfArchive(subject: string, filename: string, archive: () => Promise<Blob>): Promise<void> {
  return recordActivity({ kind: 'export', title: 'activityTray.job.bcfArchive', panel: 'bcf', subject }, async () => {
    const blob = await archive();
    // An archive that was written but could not be downloaded is a failed publication.
    downloadBlob(blob, filename);
  });
}
