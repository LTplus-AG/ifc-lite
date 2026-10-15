/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = new URL('../../../', import.meta.url);
const template = process.argv[2] ?? 'basic';
const root = mkdtempSync(join(tmpdir(), 'ifclite-scaffold-acceptance-'));
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message ?? `${result.stderr}\n${result.stdout}`);
  return result.stdout;
};
try {
  run(process.execPath, [fileURLToPath(new URL('packages/create-ifc-lite/dist/index.js', repo)), 'consumer', '--template', template], root);
  const project = join(root, 'consumer');
  const lock = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8'));
  run('npm', ['ci', '--no-audit', '--no-fund'], project);
  run('npm', ['exec', '--', 'tsc', '--noEmit'], project);
  run('npm', ['run', 'build'], project);
  let verification;
  if (template === 'basic') {
    const fixture = fileURLToPath(new URL('tests/models/ara3d/AC20-FZK-Haus.ifc', repo));
    run('npm', ['run', 'parse', fixture], project);
    copyFileSync(new URL('packages/create-ifc-lite/test/fixtures/verify-basic-consumer.mjs', repo), join(project, 'verify.mjs'));
    const output = run(process.execPath, ['verify.mjs', fixture], project).trim().split('\n').at(-1);
    verification = JSON.parse(output);
    assert.equal(verification.IfcDoor, 5);
  }
  const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
  const packageVersions = Object.fromEntries(Object.keys(manifest.dependencies ?? {}).map(name =>
    [name, lock.packages[`node_modules/${name}`]?.version]));
  writeFileSync(new URL(`${template}.json`, import.meta.url), JSON.stringify({ runtime: process.version,
    template, lockfileVersion: lock.lockfileVersion, packageVersions,
    npmCi: true, typecheck: true, build: true, generatedParseCommand: template === 'basic' ? true : undefined,
    verification }, null, 2) + '\n');
} finally { rmSync(root, { recursive: true, force: true }); }
