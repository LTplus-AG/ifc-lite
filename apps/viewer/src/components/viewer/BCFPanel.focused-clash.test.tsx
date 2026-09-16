/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A topic or viewpoint created from the BCF panel while a clash is focused
 * carries the clashing pair as found objects (#4806).
 *
 * #4808 fixed this only for the Clash panel's own "Create BCF topic" button.
 * `focusClash` clears the live selection and paints the pair through the
 * clash colour channel (#1277/#1339), so the BCF panel's "New topic" and
 * "Capture viewpoint" still wrote a viewpoint with no `<Selection>`, which is
 * what the reporter saw in BIMcollab and usBIM.
 *
 * The store is seeded with exactly what `focusClash` leaves behind: an empty
 * selection and `clashHighlightColors` from `buildClashPairColors`.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { createBCFProject, createBCFTopic } from '@ifc-lite/bcf';
import { render, cleanup, type } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { clearGlobalRefs, setGlobalRendererRef } from '@/hooks/useBCF.js';
import { buildClashPairColors } from '@/lib/clash/clash-colors.js';
import { BCFPanel } from './BCFPanel.js';

installLayout();

const PIPE_GUID = '1PipeSegment0000000001';
const BEAM_GUID = '2Beam00000000000000002';
const ID_OFFSET = 1_000_000;

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

function focusClashState(): void {
  // Two models, so the refs are federated global ids, not bare express ids.
  const mep = { ...fixtureModel('mep.ifc', { entities: [{ expressId: 11, type: 'IfcPipeSegment', globalId: PIPE_GUID }] }), maxExpressId: 100 };
  const str = {
    ...fixtureModel('structure.ifc', { idOffset: ID_OFFSET, entities: [{ expressId: 22, type: 'IfcBeam', globalId: BEAM_GUID }] }),
    maxExpressId: 100,
  };
  useViewerStore.setState({
    ...fixtureModels(mep, str),
    geometryResult: null,
    hiddenEntities: new Set(),
    isolatedEntities: null,
    selectedEntityId: null,
    selectedEntityIds: new Set(),
    selectedEntitiesSet: new Set(),
    clashSelectedId: 'clash-1',
    clashHighlightColors: buildClashPairColors(11, 22 + ID_OFFSET),
  });
}

beforeEach(() => {
  setGlobalRendererRef({ current: renderer });
});

afterEach(() => {
  cleanup();
  clearGlobalRefs();
});

function selectionGuids(): string[] {
  const project = useViewerStore.getState().bcfProject;
  const topic = [...(project?.topics.values() ?? [])].at(-1);
  return (topic?.viewpoints.at(-1)?.components?.selection ?? []).map((c) => c.ifcGuid ?? '');
}

test('BCF panel "New topic" while a clash is focused records both clashing GlobalIds (#4806)', async () => {
  useViewerStore.setState({ bcfProject: null, activeTopicId: null });
  focusClashState();
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
  const form = title.closest('form');
  assert.ok(form);
  await act(async () => {
    form.requestSubmit();
    await new Promise((r) => setTimeout(r, 0));
  });

  const topic = [...(useViewerStore.getState().bcfProject?.topics.values() ?? [])][0];
  assert.equal(topic?.title, 'Pipe through beam');
  assert.deepEqual(
    new Set(selectionGuids()),
    new Set([PIPE_GUID, BEAM_GUID]),
    'BUG: the new topic viewpoint has no found objects while a clash is focused',
  );
  const colors = topic?.viewpoints[0]?.components?.coloring?.map((c) => c.components.map((x) => x.ifcGuid)) ?? [];
  assert.deepEqual(colors, [[PIPE_GUID], [BEAM_GUID]], 'each side keeps its own on-screen clash colour');
  assert.deepEqual(
    topic?.header?.map((h) => h.filename).sort(),
    ['mep.ifc', 'structure.ifc'],
    'the header names both models the clash spans',
  );
});

test('BCF panel "Capture viewpoint" while a clash is focused records both clashing GlobalIds (#4806)', async () => {
  const project = createBCFProject({ name: 'Review' });
  const topic = createBCFTopic({ title: 'Existing', author: 'reviewer@example.invalid' });
  project.topics.set(topic.guid, topic);
  useViewerStore.setState({ bcfProject: project, activeTopicId: topic.guid });
  focusClashState();
  const ui = render(<BCFPanel onClose={() => {}} />);

  const captureButton = [...ui.querySelectorAll('button')].find((b) => b.textContent?.includes('Capture'));
  assert.ok(captureButton, 'the topic detail offers the 3D capture action');
  await act(async () => {
    captureButton.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.deepEqual(
    new Set(selectionGuids()),
    new Set([PIPE_GUID, BEAM_GUID]),
    'BUG: the captured viewpoint has no found objects while a clash is focused',
  );
});

test('without a focused clash the BCF panel capture carries no invented selection (#4806)', async () => {
  const project = createBCFProject({ name: 'Review' });
  const topic = createBCFTopic({ title: 'Existing', author: 'reviewer@example.invalid' });
  project.topics.set(topic.guid, topic);
  useViewerStore.setState({ bcfProject: project, activeTopicId: topic.guid });
  focusClashState();
  useViewerStore.setState({ clashSelectedId: null, clashHighlightColors: null });
  const ui = render(<BCFPanel onClose={() => {}} />);
  const captureButton = [...ui.querySelectorAll('button')].find((b) => b.textContent?.includes('Capture'));
  assert.ok(captureButton);
  await act(async () => {
    captureButton.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  const vp = useViewerStore.getState().bcfProject?.topics.get(topic.guid)?.viewpoints[0];
  assert.ok(vp, 'a viewpoint is still captured');
  assert.equal(vp.components?.selection, undefined);
});
