/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

type Unavailable = (...args: unknown[]) => never;

export const existsSync: Unavailable;
export const mkdirSync: Unavailable;
export const readFileSync: Unavailable;
export const realpathSync: Unavailable;
export const rmSync: Unavailable;
export const writeFileSync: Unavailable;
export const dirname: Unavailable;
export const join: Unavailable;
export const sep: '/';
export const posix: { sep: string; join: Unavailable; dirname: Unavailable };
export const win32: typeof posix;

declare const stub: {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readFileSync: typeof readFileSync;
  realpathSync: typeof realpathSync;
  rmSync: typeof rmSync;
  writeFileSync: typeof writeFileSync;
  dirname: typeof dirname;
  join: typeof join;
  sep: typeof sep;
  posix: typeof posix;
  win32: typeof win32;
};
export default stub;
