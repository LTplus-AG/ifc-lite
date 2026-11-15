/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's network and logging policy for `@ifc-lite/geo`, which makes no
 * request and writes no log of its own: an EPSG code missing from the bundled
 * index is looked up on epsg.io, datum-shift grids come from cdn.proj.org,
 * and the engine's diagnostics (approximated datum shifts, unreadable WKT,
 * refused positions) go to the console as warnings.
 *
 * Imported for its side effect by `reproject.ts`, the module every viewer
 * caller resolves a projection through.
 */

import {
  configureCrsDiagnostics,
  configureCrsLoaders,
  epsgIoDefinitionLoader,
  projCdnGridLoader,
} from '@ifc-lite/geo';

/**
 * Under the Node test runner no grid is fetched and callers get the bundled
 * `+towgs84` definition. Tests have no stable path to cdn.proj.org, and they
 * assert on tolerances both definitions satisfy.
 */
const underNodeTest = typeof process !== 'undefined' && !!process.env.NODE_TEST_CONTEXT;

configureCrsLoaders({
  epsgDefinition: epsgIoDefinitionLoader(),
  gridFile: underNodeTest ? null : projCdnGridLoader(),
});

configureCrsDiagnostics((message, cause) => {
  if (cause === undefined) console.warn(message);
  else console.warn(message, cause);
});
