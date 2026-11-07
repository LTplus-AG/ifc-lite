/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it, vi } from 'vitest';

// Counts the times `exceljs` is loaded; the real module is still returned.
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('exceljs', async (importOriginal) => {
  loads.count += 1;
  return importOriginal();
});

it('loads exceljs when a workbook is written or read, not when the package is imported', async () => {
  // The viewer imports the barrel at app start; exceljs (about 900 KB, every
  // module of it run on load) must not come with it.
  const flowNodes = await import('./index.js');
  expect(loads.count).toBe(0);

  const bytes = await flowNodes.writeXlsxTable({
    columns: [{ name: 'GlobalId', type: 'string' }, { name: 'Name', type: 'string' }],
    rows: [{ GlobalId: '2O2Fr$t4X7Zf8NOew3FLOH', Name: 'D01' }],
    key: 'GlobalId',
  });
  expect(loads.count).toBe(1);

  const { table, problems } = await flowNodes.readXlsxTable(bytes);
  expect(problems).toEqual([]);
  expect(table.rows).toEqual([{ GlobalId: '2O2Fr$t4X7Zf8NOew3FLOH', Name: 'D01' }]);
  expect(loads.count).toBe(1);
  // Loading exceljs is heavy: 0.6 to 2 s measured under the package suite's parallel
  // load, and past vitest's 5 s default on a loaded CI runner (PR #576).
}, 30_000);
