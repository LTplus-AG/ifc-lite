/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTypeEntityOwnProperties, extractTypeEntityOwnQuantities } from '@ifc-lite/parser';
import { loadIfcBytes } from '../loader.js';
import { mutateCommand } from './mutate.js';

import { schemas, source, directlyOwnedSetNames } from './type-mutation-test-helpers.js';

describe('CLI mutate preserves type-owned siblings and quantities (#8056)', () => {
  for (const fixture of schemas) {
    it(`${fixture.schema} ${fixture.type} survives an edit/export/reparse`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ifc-type-mutate-'));
      try {
        const input = join(dir, 'input.ifc');
        const output = join(dir, 'output.ifc');
        const bytes = source(fixture);
        await writeFile(input, bytes);
        const base = await loadIfcBytes(bytes, 'base');
        expect(extractTypeEntityOwnProperties(base, 1)[0]?.properties.map(p => p.name))
          .toEqual(['FireRating', 'Code']);
        await mutateCommand([input, '--id', '1', '--set', 'Pset_TestType.FireRating=EI90', '--out', output]);
        const reparsed = await loadIfcBytes(await readFile(output), 'mutated');
        expect(directlyOwnedSetNames(reparsed)).toEqual(['Pset_TestType', 'Qto_TestType']);
        const properties = extractTypeEntityOwnProperties(reparsed, 1)
          .find(set => set.name === 'Pset_TestType')?.properties;
        expect(properties?.map(p => ({ name: p.name, value: p.value })))
          .toEqual(expect.arrayContaining([
            { name: 'FireRating', value: 'EI90' },
            { name: 'Code', value: 'TYPE-001' },
          ]));
        expect(properties).toHaveLength(2);
        const quantities = extractTypeEntityOwnQuantities(reparsed, 1)
          .find(set => set.name === 'Qto_TestType')?.quantities;
        expect(quantities?.map(q => ({ name: q.name, value: q.value })))
          .toEqual([{ name: 'Length', value: 2 }, { name: 'Area', value: 6 }]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
