/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useBCF`'s `createViewpointFromState` visibility-capture branch
 * (`isolatedEntities !== null && isolatedEntities.size > 0`).
 *
 * `isolatedEntities` is meaningfully nullable (`Set<number> | null`):
 * `null` means no isolation channel is active, a non-null Set — EMPTY
 * included — means one IS active and currently matches nothing. A
 * `.size > 0` check collapses those two, so an active-but-empty isolate
 * (reachable via `pinboardSlice.ts`'s `addToBasket`/`removeFromBasket`
 * deriving the set incrementally from two `EntityRef`s that alias one
 * globalId, per #4509) falls into the `hiddenEntities` branch and captures
 * a "normal mode, these entities hidden" viewpoint instead of correctly
 * recording that isolation is active. See `useDrawingGeneration.ts` for the
 * sibling fix and the shared convention
 * (`packages/renderer/src/entity-visibility.ts`'s `isEntityVisible`).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Renderer } from '@ifc-lite/renderer';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { BCFViewpoint } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store';
import { useBCF } from './useBCF.js';

const HIDDEN_ID = 22;
const HIDDEN_GUID = 'HIDDEN-0000000000000000';

const dataStore = {
  entities: {
    getGlobalId: (expressId: number): string | undefined =>
      expressId === HIDDEN_ID ? HIDDEN_GUID : undefined,
    getExpressIdByGlobalId: (): number | undefined => undefined,
  },
} as unknown as IfcDataStore;

const renderer = {
  getCamera: () => ({
    getPosition: () => ({ x: 10, y: 5, z: 20 }),
    getTarget: () => ({ x: 1, y: 2, z: 3 }),
    getUp: () => ({ x: 0, y: 1, z: 0 }),
    getFOV: () => Math.PI / 4,
    getAspect: () => 16 / 9,
    getDistance: () => 10,
  }),
} as unknown as Renderer;

let api: ReturnType<typeof useBCF> | null = null;
let root: Root | null = null;

function Probe(): null {
  api = useBCF({ rendererRef: { current: renderer } });
  return null;
}

beforeEach(async () => {
  // The store state a production writer can leave behind: an ACTIVE isolate
  // that matches nothing (the pinboard alias-collision shape, #4509), while
  // an unrelated hidden entity is also present. Set before mount so the
  // hook's very first render — and every `useCallback` closure it
  // produces — captures these values; a later `setState` would only be
  // visible after a re-render this test does not otherwise force.
  useViewerStore.setState({
    models: new Map(),
    ifcDataStore: dataStore,
    isolatedEntities: new Set<number>(),
    ghostExceptEntities: null,
    hiddenEntities: new Set<number>([HIDDEN_ID]),
  });
  const container = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(api, 'the probe must be mounted');
});

afterEach(async () => {
  const current = root;
  root = null;
  api = null;
  if (current) await act(async () => current.unmount());
});

describe('useBCF — createViewpointFromState with an active-but-empty isolate', () => {
  it('does not fall back to capturing hiddenEntities as a normal-mode viewpoint', async () => {
    const captured: (BCFViewpoint | null)[] = [];
    await act(async () => {
      captured.push(
        await api!.createViewpointFromState({
          includeSnapshot: false,
          includeSelection: false,
          includeHidden: true,
        }),
      );
    });
    const viewpoint = captured[0];
    assert.ok(viewpoint, 'a viewpoint must be produced');

    assert.equal(
      viewpoint.components?.visibility,
      undefined,
      'BUG: an active-but-empty isolate was read as "no isolation" and the unrelated ' +
        'hiddenEntities were captured as a normal-mode (defaultVisibility=true) viewpoint',
    );
  });
});
