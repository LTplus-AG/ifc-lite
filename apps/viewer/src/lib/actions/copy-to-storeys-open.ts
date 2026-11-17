/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared picker entry point for the chip and the canonical command palette. */
export const COPY_TO_STOREYS_EVENT = 'ifc-lite:copy-to-storeys';
export function openCopyToStoreys(): void {
  window.dispatchEvent(new Event(COPY_TO_STOREYS_EVENT));
}
