/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ambient module declaration for `apache-arrow` to bridge TS5+'s strict
 * resolver against the package's browser/node export-conditions split.
 *
 * The package's `package.json` exports map points the browser build at
 * `Arrow.dom.mjs` (no `.d.ts` neighbour), and the `types` condition is
 * absent for the dom branch. TS5 then refuses to follow the package's
 * own root `types` field, leaving the dynamic `import('apache-arrow')`
 * untyped — that's a runtime-correct shape, just not a type-safe one.
 *
 * Declaring the module as `any` here keeps the type-check happy in the
 * web/dom build path without lying about the actual API surface
 * (callers use it via untyped property access already).
 *
 * NOTE: This declaration is also picked up by `tsc` runs against the
 * `@ifc-lite/export` and `@ifc-lite/server-client` source files because
 * the viewer's tsconfig wires those packages in via `paths`. A
 * package-local copy of this declaration would be cleaner long-term;
 * for now, this is the single source of truth.
 */
declare module 'apache-arrow' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arrow: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export = arrow;
}
