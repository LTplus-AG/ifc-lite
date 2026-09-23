/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { toast } from '@/components/ui/toast';
import { readBCF, type BCFProject } from '@ifc-lite/bcf';

export async function readBCFWithDiagnostics(file: File): Promise<{
  project: BCFProject;
  readWarningCount: number;
  versionWarning?: string;
}> {
  let readWarningCount = 0;
  let versionWarning: string | undefined;
  const project = await readBCF(file, {
    onWarning: (message, kind) => {
      if (kind === 'version') versionWarning = message;
      else readWarningCount++;
    },
  });
  return { project, readWarningCount, versionWarning };
}

/**
 * Import always succeeds independent of what (if anything) is loaded in the
 * viewport — a BCF's topics reference GlobalIds in the model they were
 * captured from, which `readBCF` never checks. With no model loaded, every
 * viewpoint then silently fails to resolve later (nothing to zoom to or
 * select), with no error to explain why. Called right after a successful
 * import — the one point BCFPanel knows this is true (issue #4099).
 */
export function warnIfNoModelLoaded(loadedModelCount: number): void {
  if (loadedModelCount === 0) {
    toast.info("BCF imported. Load the model this BCF refers to, to view its topics' viewpoints in 3D.");
  }
}

/**
 * `readBCF` reports a skipped topic or viewpoint through its onWarning
 * callback while retaining the readable items (#5213).
 */
export function warnIfImportTruncated(readWarningCount: number): void {
  if (readWarningCount > 0) {
    toast.error(
      `BCF import finished, but ${readWarningCount} ${readWarningCount === 1 ? 'item was' : 'items were'} ` +
        'skipped -- some topics or viewpoints could not be read. See the browser console for details.',
    );
  }
}

/** The reader can continue with BCF 2.1 rules for an unknown version. */
export function warnIfUnsupportedVersion(message: string | undefined): void {
  if (message) toast.error(`${message}. Some data may be missing.`);
}
