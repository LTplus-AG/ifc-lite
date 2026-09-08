/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Non-React glue between `exportAnonymizedSubset` (`@ifc-lite/export`) and
 * the viewer's ONE download path (`lib/export/download.ts`, per
 * `apps/viewer/AGENTS.md` "Save files through lib/export/download.ts").
 * Kept out of the dialog component so the download/filename logic is
 * testable without mounting React.
 */

import { exportAnonymizedSubset, type AnonymizeOptions, type AnonymizeResult } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import { downloadFile, sanitizeFilename, stripExtension } from '@/lib/export/download';

export interface RunAnonymizedExportArgs {
  store: IfcDataStore;
  /**
   * User-chosen download stem (sanitized here). Deliberately NOT the model
   * name: a file called `<project>_anonymized.ifc` leaks what the content
   * was scrubbed of. The dialog prompts for it, defaulting to `anonymized`.
   */
  fileStem: string;
  includedIds: ReadonlySet<number>;
  options?: AnonymizeOptions;
}

/** Filename stem shared by the `.ifc` export and the GUID-map download, so
 *  the two files a user downloads from one export are recognizably paired. */
export function anonymizedStem(fileStem: string): string {
  return sanitizeFilename(stripExtension(fileStem.trim()), { fallback: 'anonymized' });
}

/**
 * Run `exportAnonymizedSubset` and immediately download the resulting STEP
 * file as `<stem>.ifc`. Returns the full result so the caller can
 * report stats/warnings. The old->new GlobalId map is deliberately NOT
 * offered for download here (the CLI has `--guid-map` for local correlation).
 */
export function runAnonymizedExport(args: RunAnonymizedExportArgs): AnonymizeResult {
  const result = exportAnonymizedSubset(args.store, args.includedIds, args.options);
  downloadFile(result.content, `${anonymizedStem(args.fileStem)}.ifc`, 'text/plain');
  return result;
}
