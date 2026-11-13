/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Handle server completion and ownership before deciding on local fallback.
 * True means this attempt is handled (completed or stale); only a current
 * server failure may fall through to local processing.
 */
export async function handleServerLoadAttempt(
  load: () => Promise<boolean>,
  isStale: () => boolean,
  complete: () => Promise<void>,
): Promise<boolean> {
  const success = await load();
  if (isStale()) return true; // #9538: stale server results must not start local processing.
  if (!success) return false;
  await complete();
  return true;
}
