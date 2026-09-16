/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { HeadlessBackend } from './headless-backend.js';

const path = fileURLToPath(new URL('../../../tests/models/cost/buildingsmart-cost-composition.ifc', import.meta.url));
const available = existsSync(path);
if (!available) console.warn('skip: canonical cost fixture missing — run `pnpm fixtures`');

describe('#4855 CLI cost backend', () => {
  it.skipIf(!available)('exposes the same canonical totals through the headless context', async () => {
    const bytes = new Uint8Array(readFileSync(path));
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
    const bim = createBimContext({ backend: new HeadlessBackend(store, 'cost.ifc') });
    expect(bim.cost.data().source).toBe('loaded-source');
    expect(bim.cost.evaluateItem({ modelId: 'default', expressId: 40 }).Amount).toBe('800');
    expect(bim.cost.evaluateItem({ modelId: 'default', expressId: 41 }).Amount).toBe('1300');
    expect(bim.cost.evaluateItem({ modelId: 'default', expressId: 42 }).Amount).toBe('2250');
    expect(() => bim.cost.data('another-model')).toThrow('Unknown modelId');
  });
});
