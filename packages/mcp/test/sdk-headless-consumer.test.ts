/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('a Node consumer imports SDK headless reads and queries a real model (DX2)', () => {
  // The public package export is part of the compatibility contract. A fresh
  // Node resolver must reach it without source aliases or MCP initialization.
  const sample = new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
  const script = `
    import { readFileSync } from 'node:fs';
    import { IfcParser } from '@ifc-lite/parser';
    import { createQueryAdapter } from '@ifc-lite/sdk/headless';
    const bytes = readFileSync(new URL(${JSON.stringify(sample.href)}));
    const store = await new IfcParser().parseColumnar(Uint8Array.from(bytes).buffer, { disableWorkerScan: true });
    const query = createQueryAdapter(store, 'model', () => null, () => null);
    console.log(JSON.stringify({ walls: query.entities({ types: ['IfcWall'] }).length }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 15000,
  });
  expect(result.status, 'The public SDK headless Node consumer must execute successfully').toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ walls: 1 });
});
