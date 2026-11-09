/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { FileAttachment } from '@/lib/llm/types';
import { useViewerStore } from '@/store';

/** Check at commit time: concurrent extraction batches share the same six slots. */
export function attachmentAdmission(current: () => boolean, add: (attachment: FileAttachment) => void,
  setError: (message: string) => void) {
  return (attachment: FileAttachment) => {
    if (!current()) return;
    if (useViewerStore.getState().chatAttachments.length >= 6) {
      setError('You can attach up to 6 files per message.');
      return;
    }
    add(attachment);
  };
}
