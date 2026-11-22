/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

describe('@ifc-lite/ifcx bundles without a Vite asset pipeline (#10962)', () => {
  it('bundles its index with esbuild and pulls in no laz-perf module', async () => {
    const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: 'neutral',
      mainFields: ['module', 'main'],
      format: 'esm',
      logLevel: 'silent',
      metafile: true,
    });
    const lazPerf = Object.keys(result.metafile.inputs).filter((input) => input.includes('laz-perf'));
    assert.deepStrictEqual(lazPerf, []);
  });
});
