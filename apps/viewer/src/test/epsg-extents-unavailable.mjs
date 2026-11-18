/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// The bundled EPSG extents fail to load (a chunk that never arrives): every
// `@ifc-lite/data` area-of-use lookup rejects, while the EPSG index still works.
const EXTENTS = /\/packages\/data\/(?:src|dist)\/generated\/epsg-extents\.generated\.(?:ts|js)(?:\?|$)/;
export async function load(url, context, nextLoad) {
  if (!EXTENTS.test(url)) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: "throw new Error('EPSG extents chunk failed to load');" };
}
