/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Browser stand-in for `fs`/`path`; every function throws. See node-builtins.js. */
type Unavailable = (...args: unknown[]) => never;
export declare const existsSync: Unavailable;
export declare const mkdirSync: Unavailable;
export declare const readFileSync: Unavailable;
export declare const realpathSync: Unavailable;
export declare const rmSync: Unavailable;
export declare const writeFileSync: Unavailable;
export declare const dirname: Unavailable;
export declare const join: Unavailable;
export declare const sep: '/';
export declare const posix: { sep: '/'; join: Unavailable; dirname: Unavailable };
export declare const win32: { sep: '\\'; join: Unavailable; dirname: Unavailable };
declare const stub: {
  existsSync: Unavailable; mkdirSync: Unavailable; readFileSync: Unavailable; realpathSync: Unavailable;
  rmSync: Unavailable; writeFileSync: Unavailable; dirname: Unavailable; join: Unavailable;
  sep: '/'; posix: typeof posix; win32: typeof win32;
};
export default stub;
