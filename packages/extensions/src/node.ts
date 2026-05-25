/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Node-only entry for `@ifc-lite/extensions`.
 *
 * Importing from `@ifc-lite/extensions/node` brings in pieces that use
 * `node:fs` / `node:path` / etc. — currently the directory-walking
 * bundle loader. Reserved for the CLI, the eval harness, and Node tests.
 *
 * Browser code (the viewer) imports from `@ifc-lite/extensions` (root)
 * and gets only browser-safe primitives.
 */

export { loadBundleFromDirectory } from './bundle/loader-node.js';
