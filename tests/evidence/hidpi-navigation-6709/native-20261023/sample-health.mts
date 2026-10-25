/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Observe errors after the final asynchronous frame and host observations. */
export async function verifyFinalHealth(
  meta: { hostAfter?: unknown; errors?: unknown },
  settle: () => Promise<unknown>,
  readHost: () => Promise<unknown>,
  readErrors: () => Promise<unknown>,
): Promise<void> {
  await settle();
  meta.hostAfter = await readHost();
  meta.errors = await readErrors();
  if (!Array.isArray(meta.errors)) throw Error('Final page/GPU error observation missing');
  if (meta.errors.length) throw Error('Unhandled page/GPU errors observed');
  if (typeof meta.hostAfter !== 'object' || meta.hostAfter === null ||
      !('quiet' in meta.hostAfter) || meta.hostAfter.quiet !== true) {
    throw Error('Host post-admission refused');
  }
}
