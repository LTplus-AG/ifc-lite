/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The key a manifest path has in a bundle's file map: forward slashes, no
 * leading `./`. Every lookup of a manifest-referenced file goes through this,
 * so a path the loader accepts is also one a host can find (#5431 review).
 */
export function normaliseBundlePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
