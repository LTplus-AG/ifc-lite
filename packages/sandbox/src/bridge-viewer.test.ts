/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.viewer` had zero behavioural coverage. Most methods are thin
 * passthroughs (`colorize`, `hide`, `show`, `isolate`, `select`, `flyTo`,
 * `resetColors`, `resetVisibility`) with no independent logic — the
 * `entityRefs` arg type (unmarshalled in bridge-schema.ts, out of scope
 * here) already extracts `.ref` before the `call:` handler ever runs, so
 * there is nothing for a unit test at this layer to catch beyond "the SDK
 * method was called with the args it was given."
 *
 * `colorizeAll` is the one method with real logic in this file: unlike its
 * siblings it declares its arg as `'dump'` (not `'entityRefs'`), so it does
 * its own `.ref ?? e` extraction and reshapes `{ entities, color }[]` into
 * `{ refs, color }[]`. That reshape is pinned here, including the
 * `.ref ?? e` fallback for bare (unwrapped) entity refs.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BimContext, EntityRef } from '@ifc-lite/sdk';
import { buildViewerNamespace } from './bridge-viewer.js';

function findMethod(name: string) {
  const method = buildViewerNamespace().methods.find((m) => m.name === name);
  if (!method) throw new Error(`no such method: ${name}`);
  return method;
}

function mockSdk() {
  return {
    viewer: {
      colorize: vi.fn(),
      colorizeAll: vi.fn(),
      hide: vi.fn(),
      show: vi.fn(),
      isolate: vi.fn(),
      select: vi.fn(),
      flyTo: vi.fn(),
      resetColors: vi.fn(),
      resetVisibility: vi.fn(),
    },
  } as unknown as BimContext;
}

describe('bim.viewer.colorizeAll — batch reshape', () => {
  it('extracts .ref from wrapped entities and pairs it with the batch color', () => {
    const sdk = mockSdk();
    const refA: EntityRef = { modelId: 'm1', expressId: 1 };
    const refB: EntityRef = { modelId: 'm1', expressId: 2 };
    findMethod('colorizeAll').call(sdk, [
      [
        { entities: [{ ref: refA, name: 'Wall A' }], color: '#ff0000' },
        { entities: [{ ref: refB, name: 'Wall B' }], color: '#00ff00' },
      ],
    ]);
    expect(sdk.viewer.colorizeAll).toHaveBeenCalledWith([
      { refs: [refA], color: '#ff0000' },
      { refs: [refB], color: '#00ff00' },
    ]);
  });

  it('falls back to the bare entity object when .ref is absent, matching the framework entityRefs unmarshal', () => {
    const sdk = mockSdk();
    const bareRef = { modelId: 'm1', expressId: 3 };
    findMethod('colorizeAll').call(sdk, [
      [{ entities: [bareRef], color: '#0000ff' }],
    ]);
    expect(sdk.viewer.colorizeAll).toHaveBeenCalledWith([
      { refs: [bareRef], color: '#0000ff' },
    ]);
  });

  it('maps every entity within every batch, not just the first of each', () => {
    const sdk = mockSdk();
    const refs: EntityRef[] = [
      { modelId: 'm1', expressId: 1 },
      { modelId: 'm1', expressId: 2 },
      { modelId: 'm1', expressId: 3 },
    ];
    findMethod('colorizeAll').call(sdk, [
      [{ entities: refs.map((ref) => ({ ref })), color: '#fff' }],
    ]);
    const call = (sdk.viewer.colorizeAll as any).mock.calls[0][0];
    expect(call[0].refs).toEqual(refs);
  });
});
