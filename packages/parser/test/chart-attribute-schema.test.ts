/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { getRawNamedAttributes } from '../src/index.js';
import type { IfcEntity } from '@ifc-lite/data';

describe('schema-union named attributes (#4833)', () => {
  it('names IFC4X3-only scalar attributes instead of returning an empty map', () => {
    const entity = {
      expressId: 1,
      type: 'IFCKERB',
      attributes: ['gid', null, 'Kerb', null, null, null, null, null, '.USERDEFINED.'],
    } as IfcEntity;

    const named = getRawNamedAttributes(entity);
    expect(named.find(({ name }) => name === 'Name')?.raw).toBe('Kerb');
    expect(named.find(({ name }) => name === 'PredefinedType')?.raw).toBe('.USERDEFINED.');
  });
});
