/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { classifyPath } from './revert-oracle.mjs';

function selected(entry, only) {
  return only.length === 0 || [entry.path, entry.oldPath].some(path =>
    path && only.some(scope => path === scope || path.startsWith(scope.endsWith('/') ? scope : `${scope}/`)));
}

/** A whole rename cannot be reversed while leaving its non-production side
 * pinned. Report this capability gap before any applicability waiver or edit. */
export function unsupportedProductionRenames(entries, only = []) {
  return entries.filter(entry => entry.oldPath && selected(entry, only)).flatMap(entry => {
    const oldKind = classifyPath(entry.oldPath), newKind = classifyPath(entry.path);
    return oldKind !== newKind && [oldKind, newKind].includes('production')
      ? [`${entry.oldPath} -> ${entry.path} (${oldKind} -> ${newKind})`] : [];
  });
}

/** Select production changes by either rename location, then include both
 * locations in the inverse and restoration. Copies keep their original path
 * untouched: that source is still present on the branch (#6663). */
export function productionRevertPaths(entries, only = []) {
  const changes = entries.filter(entry => selected(entry, only));
  return [...new Set(changes.flatMap(entry => entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]))];
}
