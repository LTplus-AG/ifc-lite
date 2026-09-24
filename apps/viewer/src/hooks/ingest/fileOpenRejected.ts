/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { toast } from '@/components/ui/toast';
import { trackUiEvent } from '@/lib/analytics';
import { splitDxfFiles } from './dxfIngest';
import { describeUnsupportedFormat } from './unsupportedFormat';

/**
 * The one place a file-open attempt that yielded no loadable model is
 * reported (#5618): drop, `<input>` and File System Access picker alike. DXF
 * underlays are routed separately, so a DXF-only pick is not a rejection.
 * Only the reason category leaves the browser, never a file name.
 *
 * Tells the user *why* when we recognise the format (a Recap project, a
 * SketchUp file, ...), so no open path rejects a file silently.
 */
export function reportFileOpenRejected(files: File[]): void {
  const { modelFiles } = splitDxfFiles(files);
  if (modelFiles.length === 0) return;
  const explained = modelFiles.find((f) => describeUnsupportedFormat(f.name));
  trackUiEvent('file_open_rejected', { reason: explained ? 'unsupported_format' : 'unrecognized_format' });
  if (explained) toast.error(`${explained.name}: ${describeUnsupportedFormat(explained.name)}`);
}
