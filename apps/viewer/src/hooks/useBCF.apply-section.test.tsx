/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Applying a BCF viewpoint shows exactly its clipping (#4910).
 *
 * The renderer draws a cut only while the Section tool is active. Applying a
 * viewpoint with `<ClippingPlanes>` stored the cut but never opened the tool,
 * so the topic opened uncut; a viewpoint without planes left whatever cut the
 * user had, visible or remembered for the next Section-tool open.
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
import type { FederatedModel } from '@/store/types';
import { activeSectionPlane } from '@/store/section-active';
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

function model(): FederatedModel {
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
  return { ...fixtureModel('m'), loadedAt: 1, geometryResult } as FederatedModel;
}

let api: ReturnType<typeof useBCF> | null = null;
let root: Root | null = null;

function Probe(): null {
  api = useBCF({ rendererRef: { current: renderer } });
  return null;
}

const s = () => useViewerStore.getState();

beforeEach(async () => {
  useViewerStore.setState({
    ...fixtureModels(model()),
    geometryResult: null,
    ifcDataStore: null,
    isolatedEntities: null,
    hiddenEntities: new Set(),
    selectedEntityId: null,
    selectedEntityIds: new Set(),
    activeTool: 'select',
  });
  s().setSectionPlaneEnabled(false);
  useViewerStore.setState({ sectionPlane: { ...s().sectionPlane, custom: undefined, flipped: false } });
  const container = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
  assert.ok(api, 'the probe must be mounted');
});

afterEach(async () => {
  const current = root;
  root = null;
  api = null;
  if (current) await act(async () => current.unmount());
});

async function capture(): Promise<BCFViewpoint> {
  let viewpoint: BCFViewpoint | null = null;
  await act(async () => {
    viewpoint = await api!.createViewpointFromState({ includeSnapshot: false });
  });
  assert.ok(viewpoint, 'a viewpoint must be produced');
  return viewpoint;
}

async function cutInSectionTool(axis: 'down' | 'front' | 'side', position: number): Promise<void> {
  await act(async () => {
    s().setActiveTool('section');
    s().setSectionPlaneAxis(axis);
    s().setSectionPlanePosition(position);
  });
}

describe('useBCF applyViewpoint — section cut (#4910)', () => {
  it('a viewpoint with clipping planes shows its cut, round-tripping a captured one', async () => {
    await cutInSectionTool('front', 30);
    const viewpoint = await capture();
    assert.equal(viewpoint.clippingPlanes?.length, 1, 'the visible cut is captured');

    // The user moves on: another cut, still on screen after leaving the
    // tool (#5893 — lasting scene state, not tool-coupled).
    await cutInSectionTool('side', 80);
    await act(async () => s().setActiveTool('select'));
    assert.equal(activeSectionPlane(s())?.axis, 'side', 'the moved cut is still on screen');

    await act(async () => api!.applyViewpoint(viewpoint, false));
    const shown = activeSectionPlane(s());
    assert.ok(shown, 'BUG: the viewpoint cut was stored but is not on screen');
    assert.equal(s().activeTool, 'section');
    assert.equal(shown.axis, 'front');
    assert.ok(Math.abs(shown.position - 30) < 1e-6, `position restored, got ${shown.position}`);

    const again = await capture();
    assert.equal(again.clippingPlanes?.length, 1, 'capturing the applied view keeps its cut');
  });

  it('a viewpoint without clipping planes clears an on-screen cut', async () => {
    await cutInSectionTool('down', 40);
    const uncut: BCFViewpoint = { guid: '44444444-4444-4444-8444-444444444444' };
    await act(async () => api!.applyViewpoint(uncut, false));
    assert.equal(activeSectionPlane(s()), null, 'BUG: the topic has no cut but the view keeps one');
    assert.equal((await capture()).clippingPlanes, undefined, 'and exporting it again adds none');
  });

  it('a viewpoint without clipping planes also drops the cut remembered for the next Section-tool open', async () => {
    // A face-picked cut: SectionPanel re-arms pick mode on open, so only the
    // remembered plane could bring it back.
    await act(async () => {
      s().setActiveTool('section');
      s().setSectionPlaneFromFace([0, 1, 0], [0, 4, 0]);
    });
    await act(async () => s().setActiveTool('select'));
    await act(async () => api!.applyViewpoint({ guid: '55555555-5555-4555-8555-555555555555' }, false));
    await act(async () => s().setActiveTool('section'));
    assert.equal(s().sectionPlane.enabled, false, 'the cleared cut must not come back');
  });
});

/**
 * #5644: a face-picked plane's `flipped` is relative to its own normal. BCF
 * captures the cardinal approximation, so it must map the flip to the cardinal
 * frame: a pick on the -X face keeps the solid, which is the cardinal Side cut
 * FLIPPED at the same position.
 */
describe('useBCF capture — face-picked section (#5644)', () => {
  it('captures a -X face pick as the flipped cardinal cut at the same position', async () => {
    await act(async () => {
      s().setActiveTool('section');
      s().setSectionPickMode(true);
      s().setSectionPlaneFromFace([-1, 0, 0], [BOUNDS.min.x, 6, 0], {
        min: [BOUNDS.min.x, BOUNDS.min.y, BOUNDS.min.z],
        max: [BOUNDS.max.x, BOUNDS.max.y, BOUNDS.max.z],
      });
    });
    assert.ok(s().sectionPlane.custom, 'the pick committed a custom plane');
    const picked = (await capture()).clippingPlanes;
    assert.equal(picked?.length, 1, 'the picked cut is captured');

    const cardinal = async (flipped: boolean) => {
      await act(async () => {
        useViewerStore.setState({ sectionPlane: { ...s().sectionPlane, custom: undefined, flipped } });
      });
      return (await capture()).clippingPlanes;
    };
    const { axis, position } = s().sectionPlane;
    assert.equal(axis, 'side');
    assert.deepEqual(picked, await cardinal(true), 'same plane and kept side as the flipped Side cut');
    assert.equal(s().sectionPlane.position, position);
    assert.notDeepEqual(picked, await cardinal(false), 'not the unflipped one');
  });
});

/** #7545: the viewpoint carries every cutting plane, and applying one restores the whole set. */
describe('useBCF several cutting planes (#7545)', () => {
  /** What cuts, order- and name-independent: BCF has no name slot, and lists the active plane first. */
  const planeSet = () => [s().sectionPlane, ...s().inactiveSectionPlanes]
    .map((p) => ({ axis: p.axis, position: Number(p.position.toFixed(6)), flipped: p.flipped, enabled: p.enabled }))
    .sort((a, b) => a.axis.localeCompare(b.axis));

  async function threeCuts(): Promise<void> {
    await act(async () => {
      s().clearSectionPlanes();
      s().setActiveTool('section');
      s().addSectionPlane('down'); s().setSectionPlanePosition(40);
      s().addSectionPlane('side'); s().setSectionPlanePosition(70); s().flipSectionPlane();
      s().addSectionPlane('front'); s().setSectionPlanePosition(25);
    });
  }

  it('captures one clipping plane per cutting plane, and applying it later brings the same three back, first active', async () => {
    await threeCuts();
    const before = planeSet();
    const viewpoint = await capture();
    assert.equal(viewpoint.clippingPlanes?.length, 3, 'every cutting plane is captured, not only the active one');

    await act(async () => { s().clearSectionPlanes(); s().addSectionPlane('side'); s().setSectionPlanePosition(90); s().setActiveTool('select'); });
    await act(async () => api!.applyViewpoint(viewpoint, false));

    assert.deepEqual(planeSet(), before, 'the same three half-spaces');
    assert.deepEqual([s().sectionPlane, ...s().inactiveSectionPlanes].map((p) => p.name).sort(), ['A', 'B', 'C'], 'names are regenerated: BCF has no slot for them');
    assert.equal(s().sectionPlane.name, 'A', 'the first clipping plane of the viewpoint is the active one');
    assert.equal(s().sectionPlane.axis, 'front', 'and that is the plane that was active when it was captured');
    assert.equal(s().activeTool, 'section');
    assert.equal((await capture()).clippingPlanes?.length, 3, 'and exporting it again keeps all three');
  });

  it('with a captured 2D section for the active plane, the OTHER planes keep their own place (not the collapsed midpoint)', async () => {
    await threeCuts(); // down 40, side 70 flipped, front 25 (active)
    const viewpoint = await (async () => {
      let out: BCFViewpoint | null = null;
      await act(async () => {
        out = await api!.createViewpointFromState({ includeSnapshot: false, capturedSectionPlane: { axis: 'front', worldPosition: 2, flipped: false } });
      });
      assert.ok(out);
      return out as BCFViewpoint;
    })();
    assert.equal(viewpoint.clippingPlanes?.length, 3);
    // BCF is Z up: the viewer's Y (the `down` plane) is BCF z. 40 % of 0..12 is 4.8; the collapsed midpoint would be 6.
    const down = viewpoint.clippingPlanes!.find((p) => Math.abs(p.direction.z) === 1)!;
    assert.ok(down, 'the down plane is in the viewpoint');
    assert.ok(Math.abs(down.location.z - 4.8) < 1e-6, `the down plane stays at 40 %, not at the midpoint 6: ${down.location.z}`);
  });

  it('a section box is not exported as the axis it carried before it was a box', async () => {
    await threeCuts();
    await act(async () => { s().setSectionBox({ min: [-5, 1, -4], max: [5, 9, 4] }); }); // the active plane (front) becomes a box
    const viewpoint = await capture();
    assert.equal(viewpoint.clippingPlanes?.length, 2, 'only the two real planes');
  });

  it('a plane that is not cutting is not exported', async () => {
    await threeCuts();
    await act(async () => { s().setSectionPlaneEnabled(false); });
    assert.equal((await capture()).clippingPlanes?.length, 2);
  });

  it('a viewpoint with more planes than the viewer holds shows the first eight', async () => {
    await threeCuts();
    const viewpoint = await capture();
    const planes = viewpoint.clippingPlanes!;
    const many: BCFViewpoint = { ...viewpoint, clippingPlanes: Array.from({ length: 10 }, (_, i) => planes[i % 3]!) };
    await act(async () => api!.applyViewpoint(many, false));
    assert.equal(1 + s().inactiveSectionPlanes.length, 8);
  });
});
