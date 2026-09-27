/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import * as lens from './index.js';

it('#5896 retires the standalone matcher from the published Lens entry point', () => {
  expect(Object.hasOwn(lens, 'matchesCriteria')).toBe(false);
  expect(typeof lens.evaluateLens).toBe('function');
});
