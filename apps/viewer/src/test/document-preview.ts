/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { waitFor } from './render';

interface DocumentPreviewReadyOptions {
  root?: ParentNode;
  timeoutMs?: number;
}

/** Wait for preparation, never for the page count/content an assertion checks.
 * Happy DOM leaves image decoding to each image fixture's load event; the
 * initial composed page is sufficient for tests unrelated to intrinsic size. */
export function documentPreviewReady(
  { root = document, timeoutMs = 15_000 }: DocumentPreviewReadyOptions = {},
): Promise<void> {
  return waitFor(() => {
    const previews = [...root.querySelectorAll('[data-document-preview]')];
    return previews.length > 0 && previews.every(preview => preview.querySelector('[data-preview-section]') !== null
      && preview.getAttribute('data-layout-pending') !== 'true');
  },
  'document preview finishes resolving its shared page layout', timeoutMs);
}
