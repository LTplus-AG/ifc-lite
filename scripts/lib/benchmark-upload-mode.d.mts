/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export function requireTimingUploads(payload: {
  environment?: { uploadMode?: string };
  loadCounters?: { uploadMode?: string };
}): void;
