/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { downloadFile, modelExportFilename } from '@/lib/export/download.js';

/** One queued edit, as the mutation view records it. */
export type ExportedMutation = unknown;

/**
 * The "Changes only (JSON delta)" export: the session's queued edits as a JSON delta.
 *
 * Source-independent by construction — it is built from the mutation view
 * alone and never touches the model's `IfcDataStore`. That is what keeps it
 * available for a LandXML model, which has no data store at all (#4937), and
 * it is why the dialog's data-store guard must not cover this branch.
 */
export function exportChangesJson(
  modelId: string, modelName: string, mutations: ExportedMutation[],
): string {
  const data = {
    version: 1,
    modelId,
    modelName,
    mutations,
    exportedAt: new Date().toISOString(),
  };
  downloadFile(JSON.stringify(data, null, 2), modelExportFilename(modelName, 'json', '_changes'), 'application/json');
  return `Exported ${mutations.length} changes as JSON`;
}
