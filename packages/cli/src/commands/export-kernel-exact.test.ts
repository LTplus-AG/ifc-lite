// SPDX-License-Identifier: MPL-2.0
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportCommand } from './export.js';

const root = new URL('../../../../', import.meta.url);
const golden = JSON.parse(await readFile(new URL('tests/fixtures/cli-retained/exact-obj-sha256.json', root), 'utf8')) as Record<string, string>;
it('#7955 default and explicit exact OBJ match the pre-dispatch main SHA256 golden', async () => {
  expect(Object.keys(golden).length).toBeGreaterThanOrEqual(2);
  const directory = await mkdtemp(join(tmpdir(), 'exact-obj-'));
  try {
    for (const [fixture, hash] of Object.entries(golden)) {
      for (const kernel of [[], ['--kernel', 'exact']]) {
        const output = join(directory, 'model.obj');
        await exportCommand([fileURLToPath(new URL(fixture, root)), '--format', 'obj', '--out', output, ...kernel]);
        expect(createHash('sha256').update(await readFile(output)).digest('hex'), fixture).toBe(hash);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);
