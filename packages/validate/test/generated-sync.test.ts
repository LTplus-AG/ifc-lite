/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateValidators } from '@ifc-lite/codegen';
import { describe, expect, it } from 'vitest';

// src/generated is committed; regenerate it from the bundled EXPRESS schemas and
// fail on drift so a hand edit or a stale regeneration cannot ship.
const schemas = join(__dirname, '..', '..', 'codegen', 'schemas');

describe('committed validators match the generator', () => {
  it.each([
    ['IFC2X3_TC1.exp', 'ifc2x3'],
    ['IFC4_ADD2_TC1.exp', 'ifc4'],
    ['IFC4X3.exp', 'ifc4x3'],
  ])('%s -> src/generated/%s (regenerate with `pnpm --filter @ifc-lite/validate generate`)', (schema, dir) => {
    const source = readFileSync(join(schemas, schema), 'utf8').replace(/\r\n/g, '\n');
    const { files } = generateValidators(source, { runtimeImport: '../../runtime/index.js' });
    for (const [name, content] of Object.entries(files)) {
      const committed = readFileSync(join(__dirname, '..', 'src', 'generated', dir, name), 'utf8').replace(/\r\n/g, '\n');
      expect(committed === content, `${dir}/${name} is stale`).toBe(true);
    }
  }, 60_000);
});
