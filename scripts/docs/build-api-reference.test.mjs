/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { run } from '../consumer/packed-packages.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('public docs:api command renders searchable package and subpath symbols', { timeout: 600000 }, () => {
  // Exercise the public command so removing the generator is an assertion failure,
  // rather than an import failure in the production-revert oracle.
  assert.doesNotThrow(() => run('pnpm', ['--silent', 'docs:api'], root, { timeout: 540000 }));
  const output = join(root, 'docs/api/generated');
  const coverage = JSON.parse(readFileSync(join(output, 'coverage.json'), 'utf8'));
  assert.equal(coverage.modules.length, coverage.entryPoints);
  assert.ok(coverage.packageCount > 0);
  const publicSymbols = [
    ['@ifc-lite/sdk/headless', 'openModel'],
    ['@ifc-lite/sdk/headless', 'HeadlessModelSession'],
    ['@ifc-lite/parser', 'parseModel'],
    ['@ifc-lite/geometry', 'GeometryProcessor'],
    ['@ifc-lite/query', 'IfcQuery'],
    ['@ifc-lite/export', 'StepExporter'],
    ['@ifc-lite/ids', 'validateIDS'],
  ];
  for (const [surface, name] of publicSymbols) {
    const module = coverage.modules.find(entry => entry.surface === surface);
    assert.ok(module, `Missing public import ${surface}`);
    const symbol = module.exports.find(entry => entry.name === name);
    assert.ok(symbol, `Missing public symbol ${surface}.${name}`);
    const page = readFileSync(join(output, symbol.url.split('#')[0]), 'utf8');
    // @source-text-assertion-ok generated HTML is the user-facing output, not implementation source
    assert.ok(page.includes(name), `Rendered page does not name ${name}`);
    if (name === 'HeadlessModelSession') {
      for (const member of ['close', 'capability', 'report']) {
        // @source-text-assertion-ok generated HTML anchors are the documentation link contract
        assert.ok(page.includes(`id="${member}"`), `Session documentation lost ${member}`);
      }
    }
  }
  assert.ok(statSync(join(output, 'assets/search.js')).size > 0, 'Search index was not emitted');
  assert.ok(statSync(join(output, 'assets/favicon.svg')).size > 0, 'Brand favicon was not emitted');
});
