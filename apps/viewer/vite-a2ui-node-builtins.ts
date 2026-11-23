/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * `@a2ui/agent` imports `fs` and `path` at module top for a file-system catalog
 * provider the browser never calls. Point those two imports, from that package
 * only, at `@ifc-lite/a2ui`'s throwing stub; nothing else in the viewer has its
 * `fs` / `path` resolution changed.
 */
export function a2uiNodeBuiltins(): Plugin {
  const stub = path.resolve(__dirname, '../../packages/a2ui/stubs/node-builtins.js');
  const builtins = new Set(['fs', 'path', 'node:fs', 'node:path']);
  return {
    name: 'ifc-lite:a2ui-node-builtins',
    enforce: 'pre',
    resolveId(source, importer) {
      if (builtins.has(source) && importer && /[\\/]@a2ui[\\/]agent[\\/]/.test(importer)) return stub;
      return null;
    },
  };
}
