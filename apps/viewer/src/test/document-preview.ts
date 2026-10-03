/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { waitFor } from './render';

/** Wait for preparation, never for the page count/content an assertion checks.
 * Happy DOM leaves image decoding to each image fixture's load event; the
 * initial composed page is sufficient for tests unrelated to intrinsic size. */
export function documentPreviewReady(): Promise<void> {
  return waitFor(() => {
    const previews = [...document.querySelectorAll('[data-document-preview]')];
    return previews.length > 0 && previews.every(preview => preview.querySelector('[data-preview-section]') !== null
      && preview.getAttribute('data-layout-pending') !== 'true');
  },
  'document preview finishes resolving its shared page layout');
}
