/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { extractTypeEntityOwnProperties, extractTypeEntityOwnQuantities } from '@ifc-lite/parser';
import { gymCommand } from './gym.js';
import * as channels from './gym/channels.js';
import { schemas, source } from './type-mutation-test-helpers.js';

describe('gym preserves type-owned data through edits and reset (#8056)', () => {
  for (const fixture of schemas) {
    it(`${fixture.schema} ${fixture.type} projects the edit and undoes it on reset`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ifc-type-gym-'));
      // Observe the actual reparsed stores handed to the real schema checker.
      // No canned return value replaces parsing, export, mutation or checking.
      const checker = vi.spyOn(channels, 'computeSchemaChannel');
      const output = new PassThrough();
      let transcript = '';
      output.on('data', chunk => { transcript += String(chunk); });
      try {
        const inputPath = join(dir, 'input.ifc');
        await writeFile(inputPath, source(fixture));
        const input = Readable.from([
          { type: 'step', ops: [{ op: 'setProperty', expressId: 1,
            psetName: 'Pset_TestType', propName: 'FireRating', value: 'EI90' }] },
          { type: 'reset' },
          { type: 'step', ops: [] },
          { type: 'close' },
        ].map(command => `${JSON.stringify(command)}\n`));
        await gymCommand(['--model', inputPath, '--checks', 'schema'], { input, output });
        const lines = transcript.trim().split('\n').map(line => JSON.parse(line) as { type: string });
        expect(lines.map(line => line.type)).toEqual(['reset', 'reward', 'reset', 'reward']);
        expect(checker.mock.calls).toHaveLength(4);
        for (const [index, [store]] of checker.mock.calls.entries()) {
          const properties = extractTypeEntityOwnProperties(store, 1)
            .find(set => set.name === 'Pset_TestType')?.properties;
          expect(properties?.map(p => ({ name: p.name, value: p.value })))
            .toEqual(expect.arrayContaining([
              { name: 'FireRating', value: index === 1 ? 'EI90' : 'EI60' },
              { name: 'Code', value: 'TYPE-001' },
            ]));
          expect(properties).toHaveLength(2);
          const quantities = extractTypeEntityOwnQuantities(store, 1)
            .find(set => set.name === 'Qto_TestType')?.quantities;
          expect(quantities?.map(q => ({ name: q.name, value: q.value })))
            .toEqual([{ name: 'Length', value: 2 }, { name: 'Area', value: 6 }]);
        }
      } finally {
        checker.mockRestore();
        output.destroy();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
