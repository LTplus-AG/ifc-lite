/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { build } from 'vite';

describe('BCF vendor app production bundle', () => {
  it('includes allowlisted public values but never a configured VITE_ client secret', async () => {
    const envDir = await mkdtemp(join(tmpdir(), 'ifc-lite-bcf-env-'));
    try {
      await writeFile(
        join(envDir, '.env.production'),
        [
          'VITE_BCF_APP_BIMCOLLAB_CLIENT_ID=PUBLIC_CLIENT_SENTINEL',
          'VITE_BCF_APP_BIMCOLLAB_REDIRECT_URI=https://viewer.example/Callback',
          'VITE_BCF_APP_BIMCOLLAB_CLIENT_SECRET=SECRET_MUST_NOT_SHIP_SENTINEL',
        ].join('\n'),
      );

      const result = await build({
        configFile: false,
        envDir,
        logLevel: 'silent',
        mode: 'production',
        build: {
          lib: {
            entry: resolve('src/components/viewer/bcf/bcf-server-presets.ts'),
            formats: ['es'],
          },
          minify: true,
          write: false,
        },
      });
      const outputs = Array.isArray(result) ? result : [result];
      const emitted = outputs
        .flatMap((output) => {
          if (!('output' in output)) throw new Error('Vite unexpectedly returned a watcher');
          return output.output;
        })
        .filter((item) => item.type === 'chunk')
        .map((item) => item.code)
        .join('\n');

      assert.match(emitted, /PUBLIC_CLIENT_SENTINEL/, 'the build loaded the synthetic env');
      assert.doesNotMatch(emitted, /SECRET_MUST_NOT_SHIP_SENTINEL/);
      assert.doesNotMatch(emitted, /VITE_BCF_APP_BIMCOLLAB_CLIENT_SECRET/);
    } finally {
      await rm(envDir, { recursive: true, force: true });
    }
  });
});
