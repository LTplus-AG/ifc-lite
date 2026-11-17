/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { build } from 'vite';

test('the conditional runtime initializes through CommonJS without ESM syntax detection', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    if (!createRequire(import.meta.url).resolve('#rhino-factory').endsWith('/rhino3dm.js')) throw new Error('Node must select CJS');
    import factory from '#rhino-factory';
    const r = await factory();
    const f = new r.File3dm();
    try { console.log(f.layers().count); } finally { f.delete(); }
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
  expect(stdout.trim()).toBe('0');
});

test('Vite bundles the pinned entry in a lazy chunk', async () => {
  const result = await build({
    configFile: false, logLevel: 'silent',
    build: {
      write: false, minify: false,
      lib: { entry: fileURLToPath(new URL('./index.ts', import.meta.url)), formats: ['es'] },
    },
  });
  const builds = Array.isArray(result) ? result : [result];
  const chunks = builds.flatMap(b => 'output' in b ? b.output : []).filter(o => o.type === 'chunk');
  const entry = chunks.find(c => c.isEntry)!;
  expect(entry).toBeDefined();
  const rhino = chunks.find(c => c.moduleIds.some(id => id.endsWith('/rhino3dm.module.js')))!;
  expect(rhino).toBeDefined(); expect(rhino.isDynamicEntry).toBe(true);
  expect(entry.moduleIds.some(id => id.includes('/node_modules/rhino3dm/'))).toBe(false);
  expect(entry.dynamicImports).toContain(rhino.fileName);
});
