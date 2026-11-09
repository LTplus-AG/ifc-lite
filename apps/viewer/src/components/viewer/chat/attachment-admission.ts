/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { FileAttachment } from '@/lib/llm/types';
import { useViewerStore } from '@/store';

export const MAX_ATTACHMENTS_PER_MESSAGE = 6;

/** Check at commit time: concurrent extraction batches share the same six slots. */
export function attachmentAdmission(current: () => boolean, add: (attachment: FileAttachment) => void,
  setError: (message: string) => void) {
  return (attachment: FileAttachment) => {
    if (!current()) return;
    if (useViewerStore.getState().chatAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      setError(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`);
      return;
    }
    add(attachment);
  };
}
