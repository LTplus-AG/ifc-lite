/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { statSync } from 'node:fs';

export function nativeFileIdentity(path) {
  const info = statSync(path, { bigint: true });
  if (!info.isFile()) throw new Error('native executable identity requires a regular file');
  return { dev: String(info.dev), ino: String(info.ino) };
}
export function sameNativeFile(left, right) {
  const valid = value => value && /^(0|[1-9]\d*)$/.test(value.dev ?? '') && /^[1-9]\d*$/.test(value.ino ?? '');
  return Boolean(valid(left) && valid(right) && left.dev === right.dev && left.ino === right.ino);
}
