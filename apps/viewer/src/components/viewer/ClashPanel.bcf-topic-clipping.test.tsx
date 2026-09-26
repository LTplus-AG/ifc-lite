/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Clash panel's "BCF topic" button (the reporter's path) writes
 * `<ClippingPlanes>` only for a section that is on screen (#4806, revised by
 * #5893).
 *
 * #4806: the reporter never cut the model, yet every clash topic opened
 * sectioned in BIMcollab and usBIM, because `sectionPlane.enabled` stayed on
 * after the Section tool was left while the renderer stopped drawing it.
 *
 * #5893 makes the cut lasting scene state: `enabled: true` outside the tool
 * is no longer a leftover, it is the cut the user genuinely still has on
 * screen (`sceneState.section.visible` defaults `true`) — that combination
 * now correctly exports. The real "not on screen" signal is
 * `sceneState.section.visible: false` (the chip's hide toggle), still tested
 * below.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import JSZip from 'jszip';
import type { Renderer } from '@ifc-lite/renderer';
import type { GeometryResult } from '@ifc-lite/geometry';
import { writeBCF } from '@ifc-lite/bcf';
import { summarizeClashes, type Clash, type ClashResult } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { clearGlobalRefs, setGlobalRendererRef } from '@/hooks/useBCF.js';
import { ClashPanel } from './ClashPanel.js';
import { Toaster } from '@/components/ui/toast.js';

Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 400 });

const BOUNDS = { min: { x: -10, y: 0, z: -8 }, max: { x: 10, y: 12, z: 8 } };

const renderer = {
  getCamera: () => ({
    getPosition: () => ({ x: 30, y: 20, z: 25 }),
    getTarget: () => ({ x: 1, y: 2, z: 3 }),
    getUp: () => ({ x: 0, y: 1, z: 0 }),
    getFOV: () => Math.PI / 4,
    getAspect: () => 16 / 9,
    getDistance: () => 10,
  }),
} as unknown as Renderer;

const CLASH: Clash = {
  id: 'clash-1',
  a: { key: 'a', ref: 11, model: 'model.ifc', tag: 'IfcPipeSegment', name: 'Pipe' },
  b: { key: 'b', ref: 22, model: 'model.ifc', tag: 'IfcBeam', name: 'Beam' },
  rule: 'all-clashes',
  status: 'hard',
  distance: -0.05,
  point: [1, 2, 3],
  bounds: { min: [0.5, 1.5, 2.5], max: [1.5, 2.5, 3.5] },
  severity: 'major',
};

function result(): ClashResult {
  return {
    clashes: [CLASH],
    summary: summarizeClashes([CLASH]),
    rulesRun: [{ id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' }],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

function seed(activeTool: string, enabled: boolean, modelCount = 1, visible = true): void {
  const geometryResult: GeometryResult = {
    meshes: [],
    totalVertices: 0,
    totalTriangles: 0,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: BOUNDS, shiftedBounds: BOUNDS, hasLargeCoordinates: false },
  };
  const model = { ...fixtureModel('model.ifc'), loadedAt: 1, geometryResult } as FederatedModel;
  useViewerStore.setState({
    ...fixtureModels(model, ...(modelCount === 2 ? [fixtureModel('other.ifc', { idOffset: 1_000_000 })] : [])),
    geometryResult: null,
    hiddenEntities: new Set(),
    isolatedEntities: null,
    selectedEntityId: null,
    selectedEntityIds: new Set(),
    bcfProject: null,
    bcfPanelVisible: false,
    activeTopicId: null,
    clashResult: result(),
    clashGroups: null,
    clashSelectedId: CLASH.id,
    clashStatusFilter: new Set(['open', 'resolved', 'accepted']),
    clashHideTouching: false,
    activeTool,
    sectionPlane: { ...useViewerStore.getState().sectionPlane, axis: 'down', position: 25, flipped: false, enabled, custom: undefined },
    sceneState: { ...useViewerStore.getState().sceneState, section: { visible } },
  });
}

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  const dismiss = container?.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]');
  if (dismiss) await act(async () => dismiss.click());
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
  clearGlobalRefs();
  useViewerStore.getState().clearClashFocus();
  useViewerStore.setState({ clashResult: null, bcfProject: null, activeTopicId: null, activeTool: 'select' });
  useViewerStore.getState().setSectionPlaneEnabled(false);
});

async function clickBcfTopic(): Promise<string> {
  setGlobalRendererRef({ current: renderer });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<><ClashPanel /><Toaster /></>);
  });
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'BCF topic');
  assert.ok(button, 'the Clash panel offers "BCF topic"');
  await act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 50));
  });
  const project = useViewerStore.getState().bcfProject;
  assert.ok(project, 'the button created a BCF project');
  const zip = await JSZip.loadAsync(await (await writeBCF(project)).arrayBuffer());
  const entries = Object.keys(zip.files).filter((name) => name.endsWith('.bcfv'));
  assert.equal(entries.length, 1, 'exactly one viewpoint was written');
  return zip.file(entries[0])!.async('string');
}

describe('Clash panel "BCF topic" clipping planes (#4806, #5893)', () => {
  it('writes <ClippingPlanes> for a cut left enabled across a tool switch — lasting scene state (#5893)', async () => {
    seed('select', true);
    const xml = await clickBcfTopic();
    assert.match(xml, /<PerspectiveCamera>/, 'the viewpoint itself was written');
    assert.match(xml, /<ClippingPlane>/, 'the cut is genuinely on screen now (#5893), so it exports');
  });

  it('writes no <ClippingPlanes> when the cut is hidden by the visibility toggle (#4806, #5893)', async () => {
    seed('select', true, 1, false);
    const xml = await clickBcfTopic();
    assert.match(xml, /<PerspectiveCamera>/, 'the viewpoint itself was written');
    assert.doesNotMatch(xml, /<ClippingPlane/, 'BUG: the clash topic carries a section the user cannot see');
  });

  it('writes exactly the visible section cut while the Section tool shows one', async () => {
    seed('section', true);
    const xml = await clickBcfTopic();
    assert.equal(xml.match(/<ClippingPlane>/g)?.length, 1, 'exactly one clipping plane');
  });
});

for (const modelCount of [1, 2]) {
  it('keeps Clash open after creating a BCF topic with ' + modelCount + ' model(s) (#5827)', async () => {
    seed('select', false, modelCount);
    await clickBcfTopic();
    assert.equal(useViewerStore.getState().bcfPanelVisible, false);
    assert.ok([...container!.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'BCF topic'),
      'Clash panel remains mounted');
    assert.ok(container?.textContent?.includes('Topic created'), 'success toast is shown');
    const open = [...(container?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Open BCF');
    assert.ok(open, 'toast offers an Open BCF action');
    await act(async () => open.click());
    assert.equal(useViewerStore.getState().bcfPanelVisible, true);
  });
}
