/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useBCF`'s `createViewpointFromState` visibility capture, THIRD state
 * (#4509 review).
 *
 * The isolation channel has three states, not two:
 *
 *  - `isolatedEntities === null` — no isolation. No visibility channel.
 *  - a non-null EMPTY Set — isolation is active and matches nothing. The
 *    viewport IS empty, and the viewpoint must say so
 *    (`DefaultVisibility="false"` with no exceptions). Pinned by the sibling
 *    `useBCF.viewpoint-capture-empty-isolate.test.tsx`.
 *  - a NON-empty Set whose entities have no resolvable IFC GlobalId — the
 *    viewer is showing those entities, but the capture cannot NAME them.
 *    That is a failure to express the state, not the state "nothing is
 *    visible". Writing `DefaultVisibility="false"` with no exceptions here
 *    puts a false claim into a file other tools read: every recipient would
 *    open a blank viewport for a view that was never blank. Omit the channel
 *    instead, and tell the author it was omitted.
 *
 * The second and third states both produce `guids.length === 0`, which is
 * exactly why only the source `isolatedEntities.size` can tell them apart.
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
import { toast } from '@/components/ui/toast';
import { useBCF } from './useBCF.js';

/** Isolated in the viewer, and carrying no GlobalId this store can answer. */
const ISOLATED_ID = 99;
const NAMED_ISOLATED_ID = 77;
const NAMED_ISOLATED_GUID = 'NAMED-0000000000000000';
const HIDDEN_ID = 22;
const HIDDEN_GUID = 'HIDDEN-0000000000000000';

const dataStore = {
  entities: {
    // Deliberately answers for the HIDDEN entity (and, for the mixed case,
    // one nameable isolated entity) only: ISOLATED_ID is unnameable, the way
    // a viewer-only / freshly-authored entity is.
    getGlobalId: (expressId: number): string | undefined =>
      expressId === HIDDEN_ID ? HIDDEN_GUID : expressId === NAMED_ISOLATED_ID ? NAMED_ISOLATED_GUID : undefined,
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
  useViewerStore.setState({
    models: new Map(),
    ifcDataStore: dataStore,
    isolatedEntities: new Set<number>([ISOLATED_ID]),
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

describe('useBCF — createViewpointFromState with an unresolvable isolate', () => {
  it('omits the visibility channel rather than writing "nothing is visible"', async () => {
    const seen: string[] = [];
    const originalInfo = toast.info;
    toast.info = (message: string) => { seen.push(message); };
    let viewpoint: BCFViewpoint | null = null;
    try {
      await act(async () => {
        viewpoint = await api!.createViewpointFromState({
          includeSnapshot: false,
          includeSelection: false,
          includeHidden: true,
        });
      });
    } finally {
      toast.info = originalInfo;
    }
    assert.ok(viewpoint, 'a viewpoint must still be produced');
    const vp: BCFViewpoint = viewpoint;

    assert.notEqual(
      vp.components?.visibility?.defaultVisibility,
      false,
      'BUG: an isolate nobody could name was written as DefaultVisibility="false" ' +
        'with no exceptions, i.e. a positive claim that NOTHING is visible',
    );
    assert.equal(
      vp.components?.visibility,
      undefined,
      'an inexpressible visibility state is omitted, not guessed at',
    );
    assert.equal(seen.length, 1, 'the author is told the visibility channel was dropped');
    assert.match(seen[0], /visib/i);
  });

  it('does not silently fall back to capturing hiddenEntities instead', async () => {
    let viewpoint: BCFViewpoint | null = null;
    const originalInfo = toast.info;
    toast.info = () => {};
    try {
      await act(async () => {
        viewpoint = await api!.createViewpointFromState({
          includeSnapshot: false,
          includeSelection: false,
          includeHidden: true,
        });
      });
    } finally {
      toast.info = originalInfo;
    }
    assert.ok(viewpoint, 'a viewpoint must still be produced');
    const vp: BCFViewpoint = viewpoint;
    // Isolation was active. Capturing `hiddenEntities` would record an
    // unrelated normal-mode view ("everything visible except HIDDEN"), which
    // is a different false claim, not a recovery.
    // Guards the OTHER direction: this one holds before and after the fix, so
    // it cannot red on its own. Its job is to catch an over-correction that
    // recovers from the unnameable isolate by falling through to normal mode.
    assert.notEqual(
      vp.components?.visibility?.defaultVisibility,
      true,
      'isolation was active, so the normal-mode (default-visible) branch must not be taken',
    );
    assert.equal(
      vp.components?.visibility?.exceptions?.some((c) => c.ifcGuid === HIDDEN_GUID) ?? false,
      false,
      'the unrelated hidden entity must not be captured',
    );
  });
  it('a partially nameable isolate records the nameable entity and tells the author about the rest (#4529)', async () => {
    // Re-render the probe so the hook's closure sees the widened isolate.
    await act(async () => {
      useViewerStore.setState({ isolatedEntities: new Set<number>([ISOLATED_ID, NAMED_ISOLATED_ID]) });
    });
    const seen: string[] = [];
    const originalInfo = toast.info;
    toast.info = (message: string) => { seen.push(message); };
    let viewpoint: BCFViewpoint | null = null;
    try {
      await act(async () => {
        viewpoint = await api!.createViewpointFromState({
          includeSnapshot: false,
          includeSelection: false,
          includeHidden: true,
        });
      });
    } finally {
      toast.info = originalInfo;
    }
    const vp: BCFViewpoint = viewpoint!;
    assert.equal(vp.components?.visibility?.defaultVisibility, false, 'the isolation is recorded');
    assert.deepEqual(
      vp.components?.visibility?.exceptions?.map((e) => e.ifcGuid),
      [NAMED_ISOLATED_GUID],
      'exactly the nameable entity is the allowlist',
    );
    assert.equal(seen.length, 1, 'the author is told what was not recorded');
    assert.match(seen[0], /1 of 2 isolated element has no IFC GlobalId and will appear hidden/);
  });
});
