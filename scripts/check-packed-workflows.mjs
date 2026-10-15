#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, realpathSync, lstatSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packClosure, run } from './consumer/packed-packages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'ifclite-packed-consumer-'));
try {
  const tarballs = join(scratch, 'tarballs');
  const consumer = join(scratch, 'consumer');
  mkdirSync(tarballs); mkdirSync(consumer);
  const outside = relative(realpathSync(root), realpathSync(consumer));
  assert.ok(outside === '..' || outside.startsWith('..' + sep) || isAbsolute(outside), 'Consumer must live outside the repository');
  const { dependencies, versions } = packClosure(root, tarballs,
    ['@ifc-lite/sdk', '@ifc-lite/parser', '@ifc-lite/geometry', '@ifc-lite/ids']);
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies,
    overrides: dependencies, devDependencies: { typescript: rootManifest.devDependencies.typescript,
      '@types/node': rootManifest.devDependencies['@types/node'] } }, null, 2));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  for (const [name, version] of Object.entries(versions)) {
    const installed = join(consumer, 'node_modules', name);
    assert.equal(lstatSync(installed).isSymbolicLink(), false, `${name} must be an installed artifact`);
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    assert.equal(manifest.version, version);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      assert.equal(Object.values(manifest[field] ?? {}).some(value => value.startsWith('workspace:')), false,
        `${name} still has workspace protocols in ${field}`);
    }
  }
  for (const file of ['packed-workflow.mjs', 'packed-types.mts']) {
    copyFileSync(join(root, 'scripts', 'consumer', file), join(consumer, file));
  }
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext',
    moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, types: ['node'] }, files: ['packed-types.mts'] }));
  run(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.json'], consumer);
  const receipts = [];
  for (const [path, type, count] of [
    ['apps/viewer/public/samples/hello-wall.ifc', 'IfcWall', 1],
    ['tests/models/ara3d/AC20-FZK-Haus.ifc', 'IfcDoor', 5],
  ]) {
    const fixture = join(root, path);
    if (!existsSync(fixture)) { process.stderr.write(`SKIP ${path}: run pnpm fixtures\n`); continue; }
    const receipt = JSON.parse(run(process.execPath, ['packed-workflow.mjs', fixture, type, String(count)], consumer));
    receipts.push({ fixture: path, sha256: createHash('sha256').update(readFileSync(fixture)).digest('hex'), ...receipt });
  }
  assert.ok(receipts.length > 0, 'No consumer fixture ran');
  process.stdout.write(JSON.stringify({ packageVersions: versions, declarationsChecked: true, receipts }, null, 2) + '\n');
} finally { rmSync(scratch, { recursive: true, force: true }); }
