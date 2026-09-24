/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// @ifc-lite/data is bundled into browser apps. 5.3.0 broke every Vite
// consumer's production build because its index statically imported
// `node:fs` (#5586 added `readPackageVersion` there). Bundle the real entry
// the way a browser app does and fail on any Node builtin reaching it.
describe('@ifc-lite/data bundles for the browser', () => {
  it('pulls no Node builtin into a browser bundle of its index', async () => {
    const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
    const builtins: string[] = [];
    await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      logLevel: 'silent',
      plugins: [
        {
          name: 'record-node-builtins',
          setup(b) {
            b.onResolve({ filter: /^node:/ }, (args) => {
              builtins.push(`${args.path} (from ${args.importer})`);
              return { path: args.path, external: true };
            });
          },
        },
      ],
    });
    expect(builtins).toEqual([]);
  });
});
