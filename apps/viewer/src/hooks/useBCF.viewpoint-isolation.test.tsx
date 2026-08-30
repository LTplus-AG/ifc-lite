/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useBCF`'s `applyViewpoint` isolation arm (#3338 / #3389).
 *
 * Two properties, and they pull in opposite directions:
 *
 *  - a viewpoint's `visibleGuids` name whatever the AUTHORING tool recorded,
 *    which is not guaranteed geometry-bearing in this renderer, so a
 *    geometry-less `IfcElementAssembly` must be expanded to its parts before
 *    it reaches `setIsolatedEntities` (#3338);
 *  - applying a viewpoint is a "put the view into exactly this state"
 *    operation, so the assignment must happen on EVERY apply. Skipping it
 *    when the resolver answers `[]` ("resolved, nothing renders") leaves the
 *    PREVIOUS viewpoint's isolation on screen while the BCF panel reports the
 *    new viewpoint as applied -- one viewpoint's content mislabelled as
 *    another's, which is worse than the blank view main produced.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BCFViewpoint } from '@ifc-lite/bcf';
import type { Renderer } from '@ifc-lite/renderer';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { useBCF } from './useBCF.js';

/** Express ids behind the three GUIDs the viewpoints below reference. */
const WALL_A = 11;
const SPACE_B = 22;
const ASSEMBLY_C = 33;
const ASSEMBLY_C_PART = 34;

const GUID_TO_EXPRESS_ID: Record<string, number> = {
  'WALL-A00000000000000000': WALL_A,
  'SPACE-B0000000000000000': SPACE_B,
  'ASSEMBLY-C00000000000000': ASSEMBLY_C,
};

/** Legacy single-model lookup path: `models` empty, `ifcDataStore.entities`
 *  answers `getExpressIdByGlobalId`, so express ids pass through unoffset. */
const dataStore = {
  entities: {
    getExpressIdByGlobalId: (guid: string): number | undefined => GUID_TO_EXPRESS_ID[guid],
  },
} as unknown as IfcDataStore;

/** Only `getCamera().getDistance()` is reached: the viewpoints below carry no
 *  camera and no clipping plane, so `applyCameraState` never runs. */
const renderer = {
  getCamera: () => ({ getDistance: () => 10 }),
} as unknown as Renderer;

function isolationViewpoint(guid: string, visibleGuid: string): BCFViewpoint {
  return {
    guid,
    components: {
      visibility: { defaultVisibility: false, exceptions: [{ ifcGuid: visibleGuid }] },
    },
  } as BCFViewpoint;
}

let api: ReturnType<typeof useBCF> | null = null;
let root: Root | null = null;

function Probe(): null {
  api = useBCF({ rendererRef: { current: renderer } });
  return null;
}

/** `resolveHighlightIds`: WALL_A renders as itself, ASSEMBLY_C expands to its
 *  part, and anything else genuinely resolves to nothing renderable. */
function resolver(ids: number[]): number[] {
  const out: number[] = [];
  for (const id of ids) {
    if (id === WALL_A) out.push(WALL_A);
    if (id === ASSEMBLY_C) out.push(ASSEMBLY_C_PART);
  }
  return out;
}

beforeEach(async () => {
  useViewerStore.setState({
    models: new Map(),
    ifcDataStore: dataStore,
    isolatedEntities: null,
    ghostExceptEntities: null,
    hiddenEntities: new Set(),
    cameraCallbacks: { resolveHighlightIds: resolver },
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

describe('useBCF — applyViewpoint isolation', () => {
  it('expands a geometry-less assembly guid to its geometry-bearing part (#3338)', () => {
    act(() => {
      api!.applyViewpoint(isolationViewpoint('vp-c', 'ASSEMBLY-C00000000000000'), false);
    });
    assert.deepEqual(
      useViewerStore.getState().isolatedEntities,
      new Set([ASSEMBLY_C_PART, ASSEMBLY_C]),
      'the assembly\'s renderable part must be unioned in, or the viewport goes blank',
    );
  });

  it('replaces the previous viewpoint\'s isolation even when the new one resolves to nothing renderable (#3389)', () => {
    act(() => {
      api!.applyViewpoint(isolationViewpoint('vp-a', 'WALL-A00000000000000000'), false);
    });
    assert.deepEqual(
      useViewerStore.getState().isolatedEntities,
      new Set([WALL_A]),
      'sanity: the first viewpoint installs its own isolation',
    );

    act(() => {
      api!.applyViewpoint(isolationViewpoint('vp-b', 'SPACE-B0000000000000000'), false);
    });
    const after = useViewerStore.getState().isolatedEntities;
    assert.equal(
      after?.has(WALL_A),
      false,
      'BUG: applying the second viewpoint left the FIRST viewpoint\'s isolation on screen',
    );
    assert.deepEqual(
      after,
      new Set([SPACE_B]),
      'a viewpoint apply must install its own isolation on every apply',
    );
  });
});
