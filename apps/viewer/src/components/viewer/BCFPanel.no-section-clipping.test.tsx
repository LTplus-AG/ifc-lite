/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A BCF viewpoint carries `<ClippingPlanes>` only when a section is on screen
 * (#4806, revised by #5893).
 *
 * #4806: the reporter never cut the model while reviewing clashes, yet every
 * exported viewpoint had a section plane, because `sectionPlane.enabled`
 * stayed on after the Section tool closed while the renderer stopped drawing
 * it — `useBCF` read the flag alone, so an invisible cut still exported.
 *
 * #5893 makes the cut lasting scene state: `enabled: true` with the Select
 * tool active is no longer a leftover, it is the cut genuinely on screen
 * (`sceneState.section.visible` defaults `true`, independent of the tool) —
 * that combination now correctly exports. What #4806 actually protects is
 * still true and still tested below: `sceneState.section.visible: false`
 * (the chip's hide toggle) is the real "not on screen" signal now, and a
 * hidden cut must still export no `<ClippingPlanes>`.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import JSZip from 'jszip';
import type { Renderer } from '@ifc-lite/renderer';
import type { GeometryResult } from '@ifc-lite/geometry';
import { createBCFProject, createBCFTopic, writeBCF, type BCFProject } from '@ifc-lite/bcf';
import { render, cleanup, type } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { clearGlobalRefs, setGlobalRendererRef } from '@/hooks/useBCF.js';
import { BCFPanel } from './BCFPanel.js';

installLayout();

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

function seed(activeTool: string, enabled: boolean, visible = true): void {
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
  const model = { ...fixtureModel('model.ifc'), loadedAt: 1, geometryResult } as FederatedModel;
  useViewerStore.setState({
    ...fixtureModels(model),
    geometryResult: null,
    hiddenEntities: new Set(),
    isolatedEntities: null,
    selectedEntityId: null,
    selectedEntityIds: new Set(),
    clashSelectedId: null,
    clashHighlightColors: null,
    activeTool,
    sectionPlane: { ...useViewerStore.getState().sectionPlane, axis: 'down', position: 25, flipped: false, enabled, custom: undefined },
    sceneState: { ...useViewerStore.getState().sceneState, section: { visible } },
  });
}

beforeEach(() => {
  setGlobalRendererRef({ current: renderer });
});

afterEach(() => {
  cleanup();
  clearGlobalRefs();
  useViewerStore.setState({ activeTool: 'select', bcfProject: null, activeTopicId: null });
  useViewerStore.getState().setSectionPlaneEnabled(false);
});

async function bcfvXml(project: BCFProject | null): Promise<string> {
  assert.ok(project, 'a BCF project exists');
  const zip = await JSZip.loadAsync(await (await writeBCF(project)).arrayBuffer());
  const entries = Object.keys(zip.files).filter((name) => name.endsWith('.bcfv'));
  assert.equal(entries.length, 1, 'exactly one viewpoint was written');
  return (await zip.file(entries[0])!.async('string'));
}

async function newTopicXml(): Promise<string> {
  useViewerStore.setState({ bcfProject: null, activeTopicId: null });
  const ui = render(<BCFPanel onClose={() => {}} />);
  const newTopic = ui.querySelector<HTMLButtonElement>('[aria-label="New topic"]');
  assert.ok(newTopic, 'the topic list offers "New topic"');
  await act(async () => {
    newTopic.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  const title = ui.querySelector<HTMLInputElement>('input[placeholder="Brief description of the topic"]');
  assert.ok(title, 'the create form is open');
  type(title, 'Pipe through beam');
  await act(async () => {
    title.closest('form')!.requestSubmit();
    await new Promise((r) => setTimeout(r, 0));
  });
  return bcfvXml(useViewerStore.getState().bcfProject);
}

async function captureXml(): Promise<string> {
  const project = createBCFProject({ name: 'Review' });
  const topic = createBCFTopic({ title: 'Existing', author: 'reviewer@example.invalid' });
  project.topics.set(topic.guid, topic);
  useViewerStore.setState({ bcfProject: project, activeTopicId: topic.guid });
  const ui = render(<BCFPanel onClose={() => {}} />);
  const captureButton = [...ui.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Capture 3D');
  assert.ok(captureButton, 'the topic detail offers the 3D capture action');
  await act(async () => {
    captureButton.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  return bcfvXml(useViewerStore.getState().bcfProject);
}

for (const [label, xmlOf] of [['New topic', newTopicXml], ['Capture viewpoint', captureXml]] as const) {
  test(`BCF panel "${label}" writes <ClippingPlanes> for a cut left enabled across a tool switch — lasting scene state (#5893)`, async () => {
    seed('select', true);
    const xml = await xmlOf();
    assert.match(xml, /<PerspectiveCamera>/, 'the viewpoint itself was written');
    assert.match(xml, /<ClippingPlane>/, 'the cut is genuinely on screen now (#5893), so it exports');
  });

  test(`BCF panel "${label}" writes no <ClippingPlanes> when the cut is hidden by the visibility toggle (#4806, #5893)`, async () => {
    seed('select', true, false);
    const xml = await xmlOf();
    assert.match(xml, /<PerspectiveCamera>/, 'the viewpoint itself was written');
    assert.doesNotMatch(xml, /<ClippingPlanes>|<ClippingPlane>/, 'BUG: a section the user cannot see was exported');
  });

  test(`BCF panel "${label}" writes no <ClippingPlanes> with no section at all (#4806)`, async () => {
    seed('select', false);
    assert.doesNotMatch(await xmlOf(), /<ClippingPlane/);
  });

  test(`BCF panel "${label}" writes exactly the visible section cut (#4806)`, async () => {
    seed('section', true);
    const xml = await xmlOf();
    assert.equal(xml.match(/<ClippingPlane>/g)?.length, 1, 'exactly one clipping plane');
    // 25 % up the Y range 0..12 is y = 3, which is BCF Z (IFC is Z-up).
    const location = /<ClippingPlane>\s*<Location>\s*<X>([^<]+)<\/X>\s*<Y>([^<]+)<\/Y>\s*<Z>([^<]+)<\/Z>/.exec(xml);
    assert.ok(location, 'the plane has a Location');
    assert.deepEqual(location.slice(1).map(Number), [0, 0, 3]);
  });
}
