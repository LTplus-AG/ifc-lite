/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Run pnpm docs:api first. Retain the small coverage receipt, not generated HTML.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = join(root, 'docs/api/generated');
const coverage = JSON.parse(readFileSync(join(output, 'coverage.json'), 'utf8'));
const symbols = [
  ['@ifc-lite/sdk/headless', 'openModel'], ['@ifc-lite/sdk/headless', 'HeadlessModelSession'],
  ['@ifc-lite/parser', 'parseModel'], ['@ifc-lite/geometry', 'GeometryProcessor'],
  ['@ifc-lite/query', 'IfcQuery'], ['@ifc-lite/export', 'StepExporter'], ['@ifc-lite/ids', 'validateIDS'],
].map(([surface, name]) => {
  const symbol = coverage.modules.find(module => module.surface === surface)?.exports.find(entry => entry.name === name);
  assert.ok(symbol, `${surface}.${name} was not documented`);
  return { surface, ...symbol, bytes: statSync(join(output, symbol.url.split('#')[0])).size };
});
const receipt = { packageCount: coverage.packageCount, entryPoints: coverage.entryPoints,
  symbols, searchIndexBytes: statSync(join(output, 'assets/search.js')).size };
writeFileSync(new URL('receipt.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n');
