/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6232: the sandbox exposes `bim.store.addOpening` / `addHostedDoor` /
 * `addHostedWindow` on the `store` namespace and forwards the host id and
 * params untouched; only a host id that cannot be an EXPRESS id is refused at
 * the boundary (dimension checks are the builders').
 */

import { describe, expect, it, vi } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { buildStoreNamespace } from './bridge-store.js';
import type { BridgeCallContext } from './bridge-schema.js';

const CTX: BridgeCallContext = { sandboxSessionId: 'test' };
const NAMES = ['addOpening', 'addHostedDoor', 'addHostedWindow'] as const;

function method(name: string) {
  const found = buildStoreNamespace().methods.find((m) => m.name === name);
  if (!found) throw new Error(`bim.store.${name} is not bridged`);
  return found;
}

describe('#6232 bim.store modelling methods in the sandbox', () => {
  it('bridges each method and forwards (modelId, hostExpressId, params)', () => {
    for (const name of NAMES) {
      const target = vi.fn(() => ({ modelId: 'm', expressId: 7 }));
      const sdk = { store: { [name]: target } } as unknown as BimContext;
      const params = { Offset: 2, Sill: 0.9, Width: 1, Height: 1.2 };
      method(name).call(sdk, ['m', 1222, params], CTX);
      expect(target).toHaveBeenCalledWith('m', 1222, params);
    }
  });

  it('refuses a host id that is not a positive integer before reaching the SDK', () => {
    for (const name of NAMES) {
      const target = vi.fn();
      const sdk = { store: { [name]: target } } as unknown as BimContext;
      expect(() => method(name).call(sdk, ['m', 0, { Offset: 1, Width: 1, Height: 1 }], CTX))
        .toThrow(/hostExpressId must be a positive integer/);
      expect(() => method(name).call(sdk, ['m', 5, null], CTX)).toThrow(/params is required/);
      expect(target).not.toHaveBeenCalled();
    }
  });

  it('bridges the type and material methods and checks id lists at the boundary', () => {
    for (const name of ['assignType', 'assignMaterial'] as const) {
      const target = vi.fn(() => ({ modelId: 'm', expressId: 9 }));
      const sdk = { store: { [name]: target } } as unknown as BimContext;
      method(name).call(sdk, ['m', 388, [1222]], CTX);
      expect(target).toHaveBeenCalledWith('m', 388, [1222]);
      expect(() => method(name).call(sdk, ['m', 388, []], CTX)).toThrow(/non-empty array/);
      expect(() => method(name).call(sdk, ['m', 388, [1.5]], CTX)).toThrow(/positive integer/);
      expect(target).toHaveBeenCalledTimes(1);
    }
    for (const name of ['addElementType', 'addMaterial', 'addMaterialLayerSet', 'addMaterialLayerSetUsage'] as const) {
      const target = vi.fn(() => ({ modelId: 'm', expressId: 9 }));
      const sdk = { store: { [name]: target } } as unknown as BimContext;
      method(name).call(sdk, ['m', { Name: 'x' }], CTX);
      expect(target).toHaveBeenCalledWith('m', { Name: 'x' });
      expect(() => method(name).call(sdk, ['m', undefined], CTX)).toThrow(/params is required/);
    }
  });
});
