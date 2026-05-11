/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  createMapBackedResolver,
  passThroughResolver,
} from '../src/federation/resolver.js';

describe('FederationResolver', () => {
  it('passThroughResolver returns localId verbatim and refuses fromGlobalId', () => {
    expect(passThroughResolver.toGlobalId('arch', 'wall-uuid')).toBe('wall-uuid');
    expect(passThroughResolver.fromGlobalId('wall-uuid')).toBeNull();
    expect(passThroughResolver.getModelForGlobalId('wall-uuid')).toBeNull();
  });

  it('map-backed resolver round-trips entries', () => {
    const table = new Map<string, { modelId: string; globalId: string }>([
      ['G1', { modelId: 'arch', globalId: 'wall' }],
      ['G2', { modelId: 'mep', globalId: 'duct' }],
    ]);
    const resolver = createMapBackedResolver(table);

    expect(resolver.fromGlobalId('G1')).toEqual({ modelId: 'arch', globalId: 'wall' });
    expect(resolver.fromGlobalId('G2')?.modelId).toBe('mep');
    expect(resolver.fromGlobalId('missing')).toBeNull();
    expect(resolver.getModelForGlobalId('G2')).toBe('mep');
    expect(resolver.toGlobalId('arch', 'wall')).toBe('wall');
  });
});
