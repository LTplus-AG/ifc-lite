/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser stand-in for `fs` and `path`. `@a2ui/agent` imports both at module
 * top for its file-system catalog provider and skill writer; ifc-lite never
 * calls those, so every member throws if something ever does.
 */

function unavailable(name) {
  return () => {
    throw new Error(`${name} is not available in the browser build of @a2ui/agent`);
  };
}

export const existsSync = unavailable('fs.existsSync');
export const mkdirSync = unavailable('fs.mkdirSync');
export const readFileSync = unavailable('fs.readFileSync');
export const realpathSync = unavailable('fs.realpathSync');
export const rmSync = unavailable('fs.rmSync');
export const writeFileSync = unavailable('fs.writeFileSync');
export const dirname = unavailable('path.dirname');
export const join = unavailable('path.join');
export const sep = '/';
export const posix = { sep: '/', join, dirname };
export const win32 = { sep: '\\', join, dirname };

export default { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, dirname, join, sep, posix, win32 };
