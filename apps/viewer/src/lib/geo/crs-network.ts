/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's network policy for `@ifc-lite/geo`, which makes no request of
 * its own: an EPSG code missing from the bundled index is looked up on
 * epsg.io, and datum-shift grids come from cdn.proj.org.
 *
 * Imported for its side effect by `reproject.ts`, the module every viewer
 * caller resolves a projection through.
 */

import { configureCrsLoaders, epsgIoDefinitionLoader, projCdnGridLoader } from '@ifc-lite/geo';

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
