/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  createNumericRegistryAdapter,
  type NumericFederationRegistry,
} from '../src/federation/bridge.js';

describe('numeric registry adapter', () => {
  function fakeRegistry(): NumericFederationRegistry {
    const offsets: Record<string, number> = { arch: 0, mep: 1_000_000 };
    return {
      toGlobalId(modelId, expressId) {
        return offsets[modelId] + expressId;
      },
      fromGlobalId(globalId) {
        for (const [modelId, base] of Object.entries(offsets)) {
          if (globalId >= base && globalId < base + 1_000_000) {
            return { modelId, expressId: globalId - base };
          }
        }
        return null;
      },
      getModelForGlobalId(globalId) {
        const r = this.fromGlobalId(globalId);
        return r?.modelId ?? null;
      },
    };
  }

  it('forwards numeric ids through string-shaped resolver', () => {
    const reg = fakeRegistry();
    const resolver = createNumericRegistryAdapter(reg);
    expect(resolver.toGlobalId('arch', '42')).toBe('42');
    expect(resolver.toGlobalId('mep', '7')).toBe('1000007');
    const r = resolver.fromGlobalId('1000007');
    expect(r).toEqual({ modelId: 'mep', globalId: '7' });
    expect(resolver.getModelForGlobalId('1000007')).toBe('mep');
  });

  it('throws on non-numeric local ids', () => {
    const reg = fakeRegistry();
    const resolver = createNumericRegistryAdapter(reg);
    expect(() => resolver.toGlobalId('arch', 'wall-uuid')).toThrow(/numeric local ids/);
  });
});
