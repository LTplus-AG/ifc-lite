/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Plugin } from 'vite';

/** Opt-in attribution of the actual output graph, including manual chunks. */
export function bundleAnalysis(): Plugin {
  return {
    name: 'viewer-bundle-analysis',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(item => item.type === 'chunk').map(chunk => ({
        file: chunk.fileName,
        bytes: Buffer.byteLength(chunk.code),
        imports: chunk.imports,
        dynamicImports: chunk.dynamicImports,
        modules: Object.entries(chunk.modules).map(([id, module]) => ({
          id: id.replaceAll('\\', '/').replace(/^.*?(?=\/node_modules\/|\/packages\/|\/apps\/)/, ''),
          renderedLength: module.renderedLength,
        })),
      }));
      this.emitFile({ type: 'asset', fileName: 'bundle-analysis.json', source: JSON.stringify(chunks, null, 2) });
    },
  };
}
