/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's name for the shared render-frame helpers. The implementation
 * lives in `@ifc-lite/geometry/world-frame`, next to `CoordinateInfo`,
 * so the CLI, the MCP playground and the SDK convert with the same code
 * (#4879).
 */
export { ifcToViewerAxes, viewerToIfcAxes, totalYupOffset } from '@ifc-lite/geometry/world-frame';
