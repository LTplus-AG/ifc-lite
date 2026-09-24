/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { trackUiEvent } from '@/lib/analytics';
import { splitDxfFiles } from './dxfIngest';
import { describeUnsupportedFormat } from './unsupportedFormat';

/**
 * The one place a file-open attempt that yielded no loadable model is
 * reported (#5618): drop, `<input>` and File System Access picker alike. DXF
 * underlays are routed separately, so a DXF-only pick is not a rejection.
 * Only the reason category leaves the browser, never a file name.
 *
 * Returns the user-facing explanation for the first file we recognise
 * (`name: why`), or null when there is none to show.
 */
export function reportFileOpenRejected(files: File[]): string | null {
  const { modelFiles } = splitDxfFiles(files);
  if (modelFiles.length === 0) return null;
  const explained = modelFiles.find((f) => describeUnsupportedFormat(f.name));
  trackUiEvent('file_open_rejected', { reason: explained ? 'unsupported_format' : 'unrecognized_format' });
  return explained ? `${explained.name}: ${describeUnsupportedFormat(explained.name)}` : null;
}
