/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { create } from 'tar';
import { missingWorkerAssets } from '../src/utils/published-worker-assets.js';

const roots: string[] = [];
function archive(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ifclite-worker-tar-')); roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const file = join(root, 'package', path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, contents);
  }
  const output = join(root, 'artifact.tgz');
  create({ cwd: root, file: output, gzip: true, sync: true }, ['package']);
  return output;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('published worker closure (DX5)', () => {
  it('rejects a TypeScript worker URL when the tarball ships only JavaScript', () => {
    const result = missingWorkerAssets(archive({
      'dist/pool.js': 'new Worker(new URL("./geometry.worker.ts", import.meta.url), {type:"module"});',
      'dist/geometry.worker.js': 'self.onmessage = () => {};',
    }));
    expect(result).toEqual([{ file: 'package/dist/pool.js', specifier: './geometry.worker.ts' }]);
  });
  it('accepts an emitted worker with the matching file', () => {
    expect(missingWorkerAssets(archive({ 'dist/pool.js': 'new Worker(new URL("./geometry.worker.js", import.meta.url));',
      'dist/geometry.worker.js': 'self.onmessage = () => {};', }))).toEqual([]);
  });
  it('does not mistake a comment or quoted example for an executable URL', () => {
    expect(missingWorkerAssets(archive({ 'dist/index.js': '// new URL("./missing.worker.ts", import.meta.url)\n' +
      'const example = "new URL(\'./missing.worker.ts\', import.meta.url)";' }))).toEqual([]);
  });
  it('resolves encoded names and query strings like a module URL', () => {
    expect(missingWorkerAssets(archive({ 'dist/pool.js': 'new URL("./large%20model.worker.js?cache=1", import.meta.url);',
      'dist/large model.worker.js': 'self.onmessage = () => {};', }))).toEqual([]);
  });

  it('rejects a worker path outside the installed package', () => {
    expect(missingWorkerAssets(archive({ 'dist/pool.js': 'new URL("../../outside.worker.js", import.meta.url);' })))
      .toEqual([{ file: 'package/dist/pool.js', specifier: '../../outside.worker.js' }]);
  });
});
