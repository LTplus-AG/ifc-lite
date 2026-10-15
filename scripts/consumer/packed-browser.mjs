/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { Console } from 'node:console';
import { writeFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build, version } from 'vite';

globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
writeFileSync('index.html', '<script type="module" src="/browser-entry.mjs"></script>');
writeFileSync('browser-entry.mjs', `import { GeometryProcessor } from '@ifc-lite/geometry';
globalThis.IFCliteGeometry = GeometryProcessor;
`);
await build({ configFile: false, logLevel: 'silent', worker: { format: 'es' },
  build: { target: 'esnext', outDir: 'browser-dist', minify: false } });
const files = readdirSync('browser-dist', { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry =>
    relative('browser-dist', join(entry.parentPath, entry.name)).replaceAll('\\', '/')).sort();
assert.ok(files.some(file => /geometry\.worker[^/]*\.js$/.test(file)), 'Browser build must emit the geometry worker');
assert.ok(files.some(file => file.endsWith('.wasm')), 'Browser build must emit the real WASM artifact');
process.stdout.write(JSON.stringify({ viteVersion: version, files }) + '\n');
