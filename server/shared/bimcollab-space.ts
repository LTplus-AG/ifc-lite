/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One space label, never a caller-supplied URL or nested subdomain. */
export function bimcollabSpaceOrigin(label: string): string | null {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
    ? `https://${label}.bimcollab.com` : null;
}
