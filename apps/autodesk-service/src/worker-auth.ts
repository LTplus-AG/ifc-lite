/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash, timingSafeEqual } from 'node:crypto';

export function validateWorkerKey(key: string): void {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(key)) throw new Error('Configure a random base64url worker key of at least 32 bytes.');
}
export function authorizedWorker(request: Request, key: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(request.headers.get('authorization') ?? ''), digest(`Bearer ${key}`));
}
