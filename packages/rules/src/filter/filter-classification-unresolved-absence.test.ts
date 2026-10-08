/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, test } from 'vitest';
import { matchClassificationRule } from './filter-match.js';

// #7131 invariant: a classification chain whose system cannot be resolved may
// belong to the requested system. Its omission cannot certify system absence.
test('#7131 an unresolved classification chain cannot certify an explicit system is absent', () => {
  const missing = { kind: 'classification', system: 'System7131', op: 'isNotSet', value: '' } as const;
  expect(matchClassificationRule(missing, [{ unresolved: true }])).toBe(false);
  expect(matchClassificationRule(missing, [{ system: 'Other system', identification: 'A' }, { unresolved: true }])).toBe(false);
  expect(matchClassificationRule(missing, [{ system: 'Other system', identification: 'A' }])).toBe(true);
  expect(matchClassificationRule(missing, [])).toBe(true);
});
