/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { waitFor } from './render';

/** The lazy list is shared by the desktop popover and phone dialog (#8947). */
export async function activityListReady(): Promise<HTMLElement> {
  let list: HTMLElement | null = null;
  await waitFor(() => (list = document.querySelector<HTMLElement>('section[aria-label="Activity"]')) !== null,
    'Activity lazy list loaded');
  return list!;
}
