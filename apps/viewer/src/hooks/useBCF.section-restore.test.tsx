/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5829: a BCF viewpoint replaces the user's section cut (shows its own clip
 * plane, or clears the cut when it has none, #4910) and nothing gave the
 * user's cut back. With `restoreSectionOnUnmount` (the BCF panel's option),
 * closing the panel restores the cut, its visibility and the tool from
 * before the first viewpoint, unless the user changed the section
 * meanwhile. Other `useBCF` callers (the Clash panel's topic creation)
 * restore nothing. Two models are loaded, as in a federation.
 *
 * #5893 review: the cut is lasting scene state now, not tool-coupled — the
 * restore hands back `sceneState.section.visible` (`hooks/bcf/
 * section-restore.ts`) alongside the plane, so "restored" means visible
 * immediately, not merely remembered until the Section tool reopens.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Renderer } from '@ifc-lite/renderer';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { BCFViewpoint } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store';
import { activeSectionPlane } from '@/store/section-active.js';
import type { FederatedModel } from '@/store/types';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useBCF } from './useBCF.js';

const BOUNDS = { min: { x: -10, y: 0, z: -8 }, max: { x: 10, y: 12, z: 8 } };

const renderer = {
  getCamera: () => ({
    getPosition: () => ({ x: 30, y: 20, z: 25 }),
    getTarget: () => ({ x: 1, y: 2, z: 3 }),
    getUp: () => ({ x: 0, y: 1, z: 0 }),
    getFOV: () => Math.PI / 4,
    getAspect: () => 16 / 9,
    getDistance: () => 10,
    setPosition: () => {},
    setTarget: () => {},
  }),
} as unknown as Renderer;

function model(id: string, idOffset: number): FederatedModel {
  const geometryResult: GeometryResult = {
    meshes: [],
    totalVertices: 0,
    totalTriangles: 0,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: BOUNDS,
      shiftedBounds: BOUNDS,
      hasLargeCoordinates: false,
    },
  };
  return { ...fixtureModel(id, { idOffset }), loadedAt: 1, geometryResult } as FederatedModel;
}

let api: ReturnType<typeof useBCF> | null = null;
let root: Root | null = null;
const s = () => useViewerStore.getState();

async function mount(restoreSectionOnUnmount: boolean): Promise<void> {
  function Probe(): null {
    api = useBCF({ rendererRef: { current: renderer }, restoreSectionOnUnmount });
    return null;
  }
  const container = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
}

async function unmount(): Promise<void> {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
}

/** The user's own cut: front at 30 %, then back to the Select tool (stays
 *  visible there — lasting scene state, #5893). */
async function userCut(position = 30): Promise<void> {
  await act(async () => {
    s().setActiveTool('section');
    s().setSectionPlaneAxis('front');
    s().setSectionPlanePosition(position);
    s().setActiveTool('select');
  });
}

/** A viewpoint with its own cut: captured from a side cut at 80 %. */
async function sideViewpoint(): Promise<BCFViewpoint> {
  await act(async () => {
    s().setActiveTool('section');
    s().setSectionPlaneAxis('side');
    s().setSectionPlanePosition(80);
  });
  let vp: BCFViewpoint | null = null;
  await act(async () => { vp = await api!.createViewpointFromState({ includeSnapshot: false }); });
  assert.ok(vp);
  return vp;
}

beforeEach(() => {
  useViewerStore.setState({
    ...fixtureModels(model('A', 0), model('B', 1000)),
    geometryResult: null, ifcDataStore: null, isolatedEntities: null, hiddenEntities: new Set(),
    selectedEntityId: null, selectedEntityIds: new Set(), activeTool: 'select',
  });
  s().setSectionPlaneEnabled(false);
  useViewerStore.setState({ sectionPlane: { ...s().sectionPlane, custom: undefined, flipped: false } });
});

afterEach(unmount);

describe('BCF panel close restores the section cut viewpoints replaced (#5829)', () => {
  for (const kind of ['a clipped', 'an unclipped'] as const) {
    it(`gives back the user's cut and tool after ${kind} viewpoint`, async () => {
      await mount(true);
      const vp = kind === 'a clipped' ? await sideViewpoint() : { guid: '66666666-6666-4666-8666-666666666666' };
      await userCut();
      const before = s().sectionPlane;
      await act(async () => api!.applyViewpoint(vp, false));
      if (kind === 'a clipped') assert.equal(s().sectionPlane.axis, 'side', 'the viewpoint shows its cut');
      else assert.equal(s().sectionPlane.parked || s().sectionPlane.enabled, false, 'the viewpoint clears the cut');
      await unmount();
      assert.equal(s().activeTool, 'select');
      assert.equal(s().sectionPlane.axis, before.axis);
      assert.equal(s().sectionPlane.position, before.position);
      // #5893: restored means visible, not "parked ready for the tool" — the
      // cut is lasting scene state, not tool-coupled.
      assert.equal(s().sectionPlane.enabled, true, "the user's cut is restored and visible");
      assert.ok(activeSectionPlane(s()), 'the renderer receives the restored cut');
    });
  }

  it('keeps a cut the user changed after the viewpoint', async () => {
    await mount(true);
    const vp = await sideViewpoint();
    await userCut();
    await act(async () => api!.applyViewpoint(vp, false));
    await act(async () => s().setSectionPlanePosition(55));
    await unmount();
    assert.equal(s().sectionPlane.axis, 'side');
    assert.equal(s().sectionPlane.position, 55);
  });

  it('the restored cut stays visible after the user leaves the Section tool (#5829, revised by #5893)', async () => {
    await mount(true);
    const vp = await sideViewpoint();
    await act(async () => {
      s().setSectionPlaneAxis('front');
      s().setSectionPlanePosition(30);
    });
    assert.equal(s().activeTool, 'section');
    assert.ok(activeSectionPlane(s()), 'the original cut is visible before the viewpoint');

    await act(async () => api!.applyViewpoint(vp, false));
    assert.equal(s().sectionPlane.axis, 'side');
    await act(async () => s().setActiveTool('select'));
    // #5893: leaving the tool no longer parks the viewpoint's cut — it stays
    // on screen, lasting scene state.
    assert.equal(s().sectionPlane.enabled, true, 'the viewpoint cut stays visible after the tool switch');
    assert.ok(activeSectionPlane(s()));

    await unmount();
    assert.equal(s().activeTool, 'select', 'closing BCF keeps the tool chosen by the user');
    assert.equal(s().sectionPlane.axis, 'front');
    assert.equal(s().sectionPlane.position, 30);
    assert.equal(s().sectionPlane.enabled, true, 'the restored cut is visible, not parked (#5893)');
    assert.equal(s().sectionPlane.parked, false);
    assert.ok(activeSectionPlane(s()), 'the renderer receives the restored cut immediately, no Section-tool reopen needed');

    await act(async () => s().setActiveTool('section'));
    assert.equal(activeSectionPlane(s())?.position, 30, 'reopening Section still shows the same cut');
  });

  it('restores nothing for a useBCF caller without the option', async () => {
    await mount(false);
    const vp = await sideViewpoint();
    await userCut();
    await act(async () => api!.applyViewpoint(vp, false));
    await unmount();
    assert.equal(s().sectionPlane.axis, 'side', 'no restore without restoreSectionOnUnmount');
  });

  it('a non-opt-in caller cannot leave a stale cut for the next BCF panel (#5829)', async () => {
    await mount(false);
    const vp = await sideViewpoint();
    await userCut(30);
    await act(async () => api!.applyViewpoint(vp, false));
    await unmount();

    await userCut(65);
    const nextUserCut = s().sectionPlane;
    await mount(true);
    await act(async () => api!.applyViewpoint(vp, false));
    assert.equal(s().sectionPlane.axis, 'side');
    await unmount();
    assert.equal(s().activeTool, 'select');
    assert.equal(s().sectionPlane.axis, nextUserCut.axis);
    assert.equal(s().sectionPlane.position, 65);
    // #5893: the second panel's restore returns the second user cut visible,
    // not parked — a stale first-panel snapshot would show up as position
    // 30 above, which the assertion already rules out.
    assert.equal(s().sectionPlane.enabled, true);
    assert.ok(activeSectionPlane(s()));
  });
});
