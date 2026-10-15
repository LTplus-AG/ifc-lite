/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

function withCommandFixture(action) {
  const root = mkdtempSync(join(tmpdir(), 'ifclite-packed-required-'));
  try {
    mkdirSync(join(root, 'scripts/consumer'), { recursive: true });
    // Execute the real command/helper; assertions inspect runtime output.
    for (const path of ['check-packed-workflows.mjs', 'consumer/packed-packages.mjs']) {
      copyFileSync(new URL(path, import.meta.url), join(root, 'scripts', path));
    }
    action(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const invoke = (root, script) => spawnSync(process.execPath, [join(root, script)], {
  cwd: root, encoding: 'utf8', timeout: 10000,
});

test('packed command refuses a missing committed wall even with an optional fixture present (PR #7648)', () => {
  withCommandFixture(root => {
    const optional = join(root, 'tests/models/ara3d/AC20-FZK-Haus.ifc');
    mkdirSync(join(root, 'tests/models/ara3d'), { recursive: true });
    // Its existence is the condition under test; its bytes must never be read.
    writeFileSync(optional, 'optional fixture placeholder');
    const result = invoke(root, 'scripts/check-packed-workflows.mjs');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Required committed fixture .*hello-wall\.ifc is missing/);
    assert.equal(result.stdout, '');
  });
});

for (const fixture of [
  { label: 'runtime', name: '@fixture/unbuilt', built: [], missing: 'dist/index.js', remedy: /Run pnpm build/ },
  { label: 'declaration', name: '@fixture/unbuilt', built: ['dist/index.js'], missing: 'dist/index.d.ts', remedy: /Run pnpm build/ },
  { label: 'WASM', name: '@ifc-lite/wasm', built: ['dist/index.js', 'dist/index.d.ts'], missing: 'pkg/ifc-lite_bg.wasm', remedy: /pnpm build:wasm:fetch/ },
]) {
  test(`packing names a missing ${fixture.label} entry and its build remedy before writing tarballs (PR #7648)`, () => {
    withCommandFixture(root => {
      const pkg = join(root, 'packages/unbuilt');
      mkdirSync(pkg, { recursive: true });
      mkdirSync(join(root, 'tarballs'));
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: fixture.name, version: '1.0.0', type: 'module',
        main: './dist/index.js', types: './dist/index.d.ts', files: ['dist', 'pkg'],
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' },
          ...(fixture.label === 'WASM' ? { './ifc-lite_bg.wasm': './pkg/ifc-lite_bg.wasm' } : {}) } }));
      for (const file of fixture.built) {
        mkdirSync(join(pkg, 'dist'), { recursive: true });
        writeFileSync(join(pkg, file), 'export {};\n');
      }
      writeFileSync(join(root, 'pack.mjs'), `import { packClosure } from './scripts/consumer/packed-packages.mjs';
packClosure(process.cwd(), ${JSON.stringify(join(root, 'tarballs'))}, [${JSON.stringify(fixture.name)}]);\n`);
      const result = invoke(root, 'pack.mjs');
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /Missing built entry point/);
      assert.ok(result.stderr.includes(fixture.name));
      assert.ok(result.stderr.includes(fixture.missing));
      assert.match(result.stderr, fixture.remedy);
      assert.deepEqual(readdirSync(join(root, 'tarballs')), []);
    });
  });
}

// DX5: exercise the developer command, including its installed artifact and
// declaration checks. A missing script is a failed consumer entry point.
test('packed workflow command proves consumer behavior on real IFC bytes (DX5)', { timeout: 180000 }, () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pnpm = process.env.npm_execpath;
  const result = pnpm && /\.(c?js|mjs)$/i.test(pnpm)
    ? spawnSync(process.execPath, [pnpm, '--silent', 'test:packed'], { cwd: root, encoding: 'utf8', timeout: 170000 })
    : spawnSync('pnpm', ['--silent', 'test:packed'], { cwd: root, encoding: 'utf8', timeout: 170000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.packageVersions['@ifc-lite/sdk']);
  assert.ok(report.packageVersions['@ifc-lite/wasm']);
  const wall = report.receipts.find(receipt => receipt.type === 'IfcWall');
  assert.equal(wall?.count, 1);
  for (const receipt of report.receipts) {
    assert.equal(receipt.sha256, createHash('sha256').update(readFileSync(new URL(`../${receipt.fixture}`, import.meta.url))).digest('hex'));
    assert.ok(receipt.meshes > 0);
  }
  if (existsSync(new URL('../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url))) {
    assert.equal(report.receipts.find(receipt => receipt.type === 'IfcDoor')?.count, 5);
  }
});
