/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Select production changes by either rename location, then include both
 * locations in the inverse and restoration. Copies keep their original path
 * untouched: that source is still present on the branch (#6663). */
export function productionRevertPaths(entries, only = []) {
  const selected = entries.filter(entry => only.length === 0 || [entry.path, entry.oldPath].some(path =>
    path && only.some(scope => path === scope || path.startsWith(scope.endsWith('/') ? scope : `${scope}/`))));
  return [...new Set(selected.flatMap(entry => entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]))];
}
