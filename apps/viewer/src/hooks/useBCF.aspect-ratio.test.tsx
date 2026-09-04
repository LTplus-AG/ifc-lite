/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A viewpoint captured in the viewer must be writable as BCF 3.0 (#3612).
 *
 * `@ifc-lite/bcf`'s writer refuses to invent a `Camera/AspectRatio`, which
 * v3_0/visinfo.xsd makes a required element. `writeBCF` throws on the first
 * camera that lacks one, and it throws for the WHOLE archive — so a project
 * exported with a single viewer-captured viewpoint produced no file at all,
 * only the panel's "Failed to export BCF file" error.
 *
 * The path is not hypothetical and needs no 3.0-specific UI: `readBCF` sets
 * `project.version` from the imported `bcf.version`, so importing another
 * tool's 3.0 archive and adding a topic lands here.
 *
 * This test asserts the app-side half — `getCameraState` reads the live
 * viewport ratio off the renderer — by driving the real `createViewpointFromState`
 * and then actually writing the archive. Asserting only that the field is set
 * would pass against a camera the writer still rejects.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Renderer } from '@ifc-lite/renderer';
import { writeBCF } from '@ifc-lite/bcf';
import type { BCFProject, BCFViewpoint } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store';
import { useBCF } from './useBCF.js';

/** 1600x900 viewport. A square one would not distinguish w/h from h/w. */
const ASPECT = 16 / 9;

const renderer = {
  getCamera: () => ({
    getPosition: () => ({ x: 10, y: 5, z: 20 }),
    getTarget: () => ({ x: 1, y: 2, z: 3 }),
    getUp: () => ({ x: 0, y: 1, z: 0 }),
    getFOV: () => Math.PI / 4,
    getAspect: () => ASPECT,
    getDistance: () => 10,
  }),
} as unknown as Renderer;

let api: ReturnType<typeof useBCF> | null = null;
let root: Root | null = null;

function Probe(): null {
  api = useBCF({ rendererRef: { current: renderer } });
  return null;
}

/** Wrap one viewpoint in the smallest BCF 3.0 project `writeBCF` accepts. */
function projectAround(viewpoint: BCFViewpoint): BCFProject {
  return {
    version: '3.0',
    projectId: '99999999-9999-4999-8999-999999999999',
    name: 'Imported from another tool',
    topics: new Map([
      [
        '11111111-1111-4111-8111-111111111111',
        {
          guid: '11111111-1111-4111-8111-111111111111',
          title: 'Captured in the viewer',
          topicType: 'Issue',
          topicStatus: 'Open',
          creationDate: '2026-01-02T03:04:05Z',
          creationAuthor: 'author@example.invalid',
          comments: [],
          viewpoints: [viewpoint],
        },
      ],
    ]),
  };
}

/** Drive the real capture path and insist it produced something. */
async function captureViewpoint(): Promise<BCFViewpoint> {
  const captured: (BCFViewpoint | null)[] = [];
  await act(async () => {
    captured.push(await api!.createViewpointFromState({ includeSnapshot: false }));
  });
  const viewpoint = captured[0];
  assert.ok(viewpoint, 'a viewpoint must be produced');
  return viewpoint;
}

beforeEach(async () => {
  useViewerStore.setState({
    models: new Map(),
    isolatedEntities: null,
    ghostExceptEntities: null,
    hiddenEntities: new Set(),
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

describe('useBCF — captured viewpoints carry the viewport aspect ratio', () => {
  it('records the live viewport ratio on the camera', async () => {
    const viewpoint = await captureViewpoint();
    assert.equal(
      viewpoint.perspectiveCamera?.aspectRatio,
      ASPECT,
      'BUG: the captured camera has no AspectRatio, so BCF 3.0 cannot be written',
    );
  });

  it('exports as BCF 3.0 instead of throwing away the whole archive', async () => {
    const blob = await writeBCF(projectAround(await captureViewpoint()));
    assert.ok(blob.size > 0, 'the export must produce an archive');
  });
});
