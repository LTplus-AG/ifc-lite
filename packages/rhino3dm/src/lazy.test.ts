/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test, vi } from 'vitest';
const state = vi.hoisted(() => ({ evaluated: false }));
vi.mock('#rhino-factory', () => {
  state.evaluated = true;
  return { default: () => { throw new Error('initialization sentinel'); } };
});
test('importing the package does not even evaluate rhino3dm', async () => {
  const api = await import('./index.js');
  expect(typeof api.writeRhino3dm).toBe('function');
  expect(state.evaluated).toBe(false);
  const { loadRhino } = await import('./runtime.js');
  await expect(loadRhino()).rejects.toThrow('initialization sentinel');
  expect(state.evaluated).toBe(true);
});
