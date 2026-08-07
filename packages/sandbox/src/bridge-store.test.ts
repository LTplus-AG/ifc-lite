/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store` had zero behavioural coverage — bridge-permissions.test.ts
 * only checks that `typeof bim.store` is gated correctly, never calls a
 * method's `call:` handler. These tests exercise the handlers directly
 * against a minimal mock SDK, without spinning up QuickJS.
 *
 * `requireStoreyId` (shared by addColumn/addWall/addSlab/addDoor/addWindow/
 * addSpace/addRoof/addPlate/addMember) rejects `storeyExpressId <= 0` —
 * EXPRESS ids are 1-based, so `#0` is never a valid reference (see the
 * comment on `requireStoreyId` in bridge-store.ts). `addBeam` alone
 * duplicates this guard inline and only rejects `< 0`, letting `0` through
 * to `sdk.store.addBeam`.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { buildStoreNamespace } from './bridge-store.js';

function findMethod(name: string) {
  const ns = buildStoreNamespace();
  const method = ns.methods.find((m) => m.name === name);
  if (!method) throw new Error(`no such method: ${name}`);
  return method;
}

/** Minimal mock SDK — only `store.addX` needs to exist; call() should throw
 * on invalid input before ever reaching these mocks. */
function mockSdk() {
  return {
    store: {
      addColumn: vi.fn(() => ({ modelId: 'm', expressId: 99 })),
      addBeam: vi.fn(() => ({ modelId: 'm', expressId: 99 })),
    },
  } as unknown as BimContext;
}

describe('bim.store storeyExpressId guard — addBeam vs. its siblings', () => {
  it('addColumn rejects storeyExpressId 0 (EXPRESS ids are 1-based)', () => {
    const sdk = mockSdk();
    const call = findMethod('addColumn').call;
    expect(() =>
      call(sdk, ['model', 0, { Position: [0, 0, 0], Width: 1, Depth: 1, Height: 1 }]),
    ).toThrow(/storeyExpressId must be a positive integer/);
    expect((sdk as unknown as { store: { addColumn: ReturnType<typeof vi.fn> } }).store.addColumn).not.toHaveBeenCalled();
  });

  it('addBeam also rejects storeyExpressId 0, matching addColumn', () => {
    const sdk = mockSdk();
    const call = findMethod('addBeam').call;
    expect(() =>
      call(sdk, ['model', 0, { Start: [0, 0, 0], End: [1, 0, 0], Width: 1, Height: 1 }]),
    ).toThrow();
    expect((sdk as unknown as { store: { addBeam: ReturnType<typeof vi.fn> } }).store.addBeam).not.toHaveBeenCalled();
  });

  it('addBeam still rejects negative storeyExpressId (bounding control)', () => {
    const sdk = mockSdk();
    const call = findMethod('addBeam').call;
    expect(() =>
      call(sdk, ['model', -1, { Start: [0, 0, 0], End: [1, 0, 0], Width: 1, Height: 1 }]),
    ).toThrow();
    expect((sdk as unknown as { store: { addBeam: ReturnType<typeof vi.fn> } }).store.addBeam).not.toHaveBeenCalled();
  });
});
