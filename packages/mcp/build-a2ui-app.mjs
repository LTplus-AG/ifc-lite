/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const source = new URL('./src/apps/a2ui/', import.meta.url);
const template = await readFile(new URL('app.html', source), 'utf8');
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('app.ts', source))],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  write: false,
});
const output = new URL('./dist/apps/a2ui/', import.meta.url);
await mkdir(output, { recursive: true });
const script = outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await writeFile(new URL('app.html', output),
  template.replace('<!-- APP_SCRIPT -->', () => `<script>${script}</script>`));
