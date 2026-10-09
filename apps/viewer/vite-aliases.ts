/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import path from 'node:path';

// Specific subpaths must precede package prefixes in Vite's alias resolution.
export const viewerAliases = {
      '@': path.resolve(__dirname, './src'),
      '@ifc-lite/parser/browser': path.resolve(__dirname, '../../packages/parser/src/browser.ts'),
      '@ifc-lite/parser': path.resolve(__dirname, '../../packages/parser/src'),
      '@ifc-lite/geometry': path.resolve(__dirname, '../../packages/geometry/src'),
      '@ifc-lite/renderer': path.resolve(__dirname, '../../packages/renderer/src'),
      '@ifc-lite/query': path.resolve(__dirname, '../../packages/query/src'),
      '@ifc-lite/server-client': path.resolve(__dirname, '../../packages/server-client/src'),
      '@ifc-lite/semantic': path.resolve(__dirname, '../../packages/semantic/src'),
      '@ifc-lite/spatial': path.resolve(__dirname, '../../packages/spatial/src'),
      '@ifc-lite/data': path.resolve(__dirname, '../../packages/data/src'),
      '@ifc-lite/export': path.resolve(__dirname, '../../packages/export/src'),
      '@ifc-lite/cache': path.resolve(__dirname, '../../packages/cache/src'),
      '@ifc-lite/collab': path.resolve(__dirname, '../../packages/collab/src'),
      '@ifc-lite/ifcx': path.resolve(__dirname, '../../packages/ifcx/src'),
      '@ifc-lite/pointcloud': path.resolve(__dirname, '../../packages/pointcloud/src'),
      '@ifc-lite/wasm': path.resolve(__dirname, '../../packages/wasm/pkg/ifc-lite.js'),
      '@ifc-lite/sdk': path.resolve(__dirname, '../../packages/sdk/src'),
      '@ifc-lite/create': path.resolve(__dirname, '../../packages/create/src'),
      '@ifc-lite/sandbox/network': path.resolve(__dirname, '../../packages/sandbox/src/network-request.ts'),
      '@ifc-lite/sandbox/schema': path.resolve(__dirname, '../../packages/sandbox/src/bridge-schema.ts'),
      '@ifc-lite/sandbox': path.resolve(__dirname, '../../packages/sandbox/src'),
      '@ifc-lite/lens': path.resolve(__dirname, '../../packages/lens/src'),
      '@ifc-lite/mutations': path.resolve(__dirname, '../../packages/mutations/src'),
      '@ifc-lite/bcf': path.resolve(__dirname, '../../packages/bcf/src'),
      '@ifc-lite/bcf-api': path.resolve(__dirname, '../../packages/bcf-api/src'),
      '@ifc-lite/oauth-pkce': path.resolve(__dirname, '../../packages/oauth-pkce/src'),
      '@ifc-lite/drawing-2d': path.resolve(__dirname, '../../packages/drawing-2d/src'),
      '@ifc-lite/encoding': path.resolve(__dirname, '../../packages/encoding/src'),
      '@ifc-lite/ids-authoring': path.resolve(__dirname, '../../packages/ids-authoring/src'),
      '@ifc-lite/ids': path.resolve(__dirname, '../../packages/ids/src'),
      '@ifc-lite/lists': path.resolve(__dirname, '../../packages/lists/src'),
};
