// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { wasmMemberSurface } from '../lib/wasm-member-surface.mjs';
import { run } from './packed-packages.mjs';

/** Inspect actual archives and installed declaration closure, including CLI's
 * and geometry's wildcard dist payload. Called by the existing packed gate.
 */
export function assertDevelopmentExcluded(root, consumer, tarballs, versions) {
  const declarationFiles = [];
  for (const name of Object.keys(versions)) {
    const archive = join(tarballs, `${name.replaceAll('/', '-').replaceAll('@', '')}.tgz`);
    const files = run('tar', ['-tzf', archive], consumer).trim().split('\n');
    assert.ok(files.length > 0);
    for (const file of files) {
      assert.doesNotMatch(file, /(?:\.retained-dev|development[-_]inspection|retained[-_]inspection|retained-contract|(?:^|\/)smlib(?:\/|$))/iu,
        `Private development artifact in ${name}: ${file}`);
      if (['@ifc-lite/geometry', '@ifc-lite/cli'].includes(name) && file.endsWith('.d.ts')) {
        declarationFiles.push(join(consumer, 'node_modules', name, file.replace(/^package\//u, '')));
      }
    }
  }
  const snapshot = JSON.parse(readFileSync(join(root, 'scripts/api-surface.json'), 'utf8'));
  const wasm = join(consumer, 'node_modules/@ifc-lite/wasm');
  for (const [entry, key] of [['pkg/ifc-lite.d.ts', '@ifc-lite/wasm#members'],
    ['retained.d.ts', '@ifc-lite/wasm/retained#members']]) {
    const surface = wasmMemberSurface(join(wasm, entry));
    assert.deepEqual(surface.rows, snapshot[key], `Installed member surface: ${key}`);
    for (const file of surface.files) {
      assert.ok(!relative(wasm, file).startsWith('..'), `Declaration escapes installed WASM package: ${file}`);
    }
  }
  assert.ok(declarationFiles.length > 0, 'Actual CLI/geometry declaration payloads required');
  return declarationFiles;
}
