/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `@ifc-lite/clash` functions the agent tools load on demand.
 *
 * They import THIS module dynamically, never `import('@ifc-lite/clash')`
 * itself. The package is already part of the eager bundle, and a dynamic
 * import of its index (e.g. inside `Promise.all`) needs the whole export
 * namespace, which stops the bundler from dropping any export. Every export
 * added to the package then grew the eager bundle. Named re-exports here stay
 * tree-shakeable.
 */

export { clashReviewKey, compareClashRevisions } from '@ifc-lite/clash';
