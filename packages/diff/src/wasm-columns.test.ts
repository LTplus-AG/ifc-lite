/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, test } from 'vitest';
import { fingerprintColumns } from './wasm-columns.js';
import type { EntityFingerprint } from './types.js';

test('column transport refuses lone UTF-16 units without conflating identities (#8042, #8081)', () => {
  const entity: EntityFingerprint<null> = { key: '😀', ifcType: 'IfcWall', dataHash: 'd', ref: null };
  expect(fingerprintColumns([entity]).strings[0]).toBe('😀');
  for (const text of ['\ud800', '\udc00', 'a\ud800b', '\ud800\ud800', '\udc00\udc00']) {
    const variants: EntityFingerprint<null>[] = [
      { ...entity, key: text }, { ...entity, ifcType: text },
      { ...entity, dataHash: text }, { ...entity, geometryHash: text },
      { ...entity, container: text }, { ...entity, components: { [text]: 'd' } },
      { ...entity, components: { propertySets: text } },
    ];
    for (const variant of variants) expect(() => fingerprintColumns([variant])).toThrow(/well-formed UTF-16/);
  }
  const scalar = { ...entity, key: '�', components: { propertySets: 'literal\\ud800' } };
  expect(fingerprintColumns([scalar]).strings).toContain('literal\\ud800');
});
