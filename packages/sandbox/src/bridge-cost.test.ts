/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createBimContext, createCostBackend } from '@ifc-lite/sdk';
import { createSandbox } from './sandbox.js';

const path = fileURLToPath(new URL('../../../tests/models/cost/buildingsmart-cost-composition.ifc', import.meta.url));
const available = existsSync(path);
if (!available) console.warn('skip: canonical cost fixture missing — run `pnpm fixtures`');

describe('#4855 sandbox cost bridge', () => {
  it.skipIf(!available)('marshals the canonical decimal result through QuickJS', async () => {
    const bytes = new Uint8Array(readFileSync(path));
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
    const cost = createCostBackend(requested => {
      const modelId = requested ?? 'sandbox-b';
      if (modelId !== 'sandbox-a' && modelId !== 'sandbox-b') throw new Error(`Unknown modelId '${modelId}'`);
      return { modelId, store };
    });
    const bim = createBimContext({ backend: { cost } as never });
    const sandbox = await createSandbox(bim, { permissions: { query: true } });
    try {
      const result = await sandbox.eval(`
        const item = bim.cost.items('sandbox-a').find(value => value.Name === 'External wall total');
        bim.cost.evaluateItem(item.ref, { Precision: 34 });
      `);
      expect(result.value).toMatchObject({
        ref: { modelId: 'sandbox-a', expressId: 42 }, Amount: '2250', Currency: 'GBP', Diagnostics: [],
      });

      const defaults = await sandbox.eval(`({
        omitted: bim.cost.data().modelId,
        explicitUndefined: bim.cost.data(undefined).modelId,
      })`);
      expect(defaults.value).toEqual({ omitted: 'sandbox-b', explicitUndefined: 'sandbox-b' });

      await expect(sandbox.eval(`bim.cost.evaluateItem({ expressId: 42 })`))
        .rejects.toThrow('model-qualified EntityRef');
      await expect(sandbox.eval(`bim.cost.evaluateItem(
        { modelId: 'sandbox-a', expressId: 42 }, { precision: 34 }
      )`)).rejects.toThrow("exact 'Precision' field");
      await expect(sandbox.eval(`bim.cost.evaluateItem(
        { modelId: 'sandbox-a', expressId: ${String(Number.MAX_SAFE_INTEGER + 1)} }
      )`)).rejects.toThrow('non-negative safe integer expressId');
      await expect(sandbox.eval(`bim.cost.evaluateItem(
        { modelId: 'sandbox-a', expressId: 42 }, { Precision: 10001 }
      )`)).rejects.toThrow('integer from 1 through 10000');
    } finally {
      sandbox.dispose();
    }
  });

  it('omits the namespace when query permission is disabled', async () => {
    const bim = createBimContext({ backend: { cost: { data: () => { throw new Error('must not run'); } } } as never });
    const sandbox = await createSandbox(bim, { permissions: { query: false } });
    try {
      const result = await sandbox.eval(`typeof bim.cost`);
      expect(result.value).toBe('undefined');
    } finally {
      sandbox.dispose();
    }
  });
});
