/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Node-only entry for `@ifc-lite/data`.
 *
 * `@ifc-lite/data` (root) is bundled into browser apps, so anything that
 * needs `node:fs` and friends lives here instead: 5.3.0 exported
 * `readPackageVersion` from the root and broke every Vite production build
 * (#5767). Reserved for the CLI and the MCP server.
 */

export { readPackageVersion, UNKNOWN_VERSION } from './package-version.js';
