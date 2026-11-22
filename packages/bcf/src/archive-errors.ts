/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import JSZip from 'jszip';

/**
 * Raised when an archive blows a resource cap. Distinguishable so the
 * per-topic/per-viewpoint "skip malformed content" catch blocks rethrow it
 * instead of downgrading a detected zip bomb to a console warning.
 */
export class BCFResourceLimitError extends Error {
  override name = 'BCFResourceLimitError';
}
export class BCFArchiveFormatError extends Error {
  override name = 'BCFArchiveFormatError';
}

export async function loadBcfArchive(bytes: Uint8Array): Promise<JSZip> {
  try { return await JSZip.loadAsync(bytes); }
  catch (error) {
    // JSZip reports malformed archive bytes as plain Errors. Preserve unexpected runtime faults.
    if (error instanceof Error && error.constructor === Error) throw new BCFArchiveFormatError(error.message, { cause: error });
    throw error;
  }
}
