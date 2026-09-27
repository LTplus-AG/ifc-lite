/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `BCFOverlay` on the shared scene-overlay kernel (#5511, charter #5478): a
 * topic marker is a `Pin` registered on the shared `SceneProjector`, not the
 * bespoke WebGPU projection adapter + `BCFOverlayRenderer` DOM class this
 * component used to create and poll itself.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup } from '@/test/render.js';
import { renderScene } from '@/components/viewport-ui/scene/test/scene-test-support';
import { useViewerStore } from '@/store';
import type { BCFProject, BCFTopic } from '@ifc-lite/bcf';
import { BCFOverlay } from './BCFOverlay';

function topicWithCameraPosition(overrides: Partial<BCFTopic> = {}): BCFTopic {
  return {
    guid: 't1',
    title: 'Missing fire door',
    creationDate: '2026-01-01T00:00:00.000Z',
    creationAuthor: 'a@example.com',
    topicStatus: 'Open',
    comments: [],
    index: 1,
    // The derived "camera-target" position (origin + direction*distance, then
    // BCF Z-up → viewer Y-up) must land within the stub camera's 800x600
    // canvas — the stub maps world x/y straight to screen px, so a point
    // outside those bounds is legitimately off-screen and the Pin hides,
    // exactly as it would for a real out-of-view marker.
    viewpoints: [
      {
        guid: 'v1',
        perspectiveCamera: {
          cameraViewPoint: { x: 5, y: 0, z: 0 },
          cameraDirection: { x: 0, y: 0, z: 1 },
          cameraUpVector: { x: 0, y: 1, z: 0 },
          fieldOfView: 60,
        },
      },
    ],
    ...overrides,
  } as BCFTopic;
}

function projectWithTopics(topics: BCFTopic[]) {
  const bcfProject: BCFProject = {
    version: '2.1',
    projectId: 'p1',
    topics: new Map(topics.map((topic) => [topic.guid, topic])),
  };
  useViewerStore.setState({ bcfProject });
}

afterEach(() => {
  cleanup();
  useViewerStore.setState({ bcfProject: null, activeTopicId: null });
});

describe('BCFOverlay', () => {
  it('renders nothing when there is no BCF project loaded', () => {
    const { container, flush } = renderScene(<BCFOverlay />);
    flush();
    assert.equal(container.querySelector('[data-scene-primitive="pin"]'), null);
  });

  it('projects a topic marker as a Pin, hidden until the shared projector ticks', () => {
    projectWithTopics([topicWithCameraPosition()]);
    const { container, flush } = renderScene(<BCFOverlay />);
    const pin = container.querySelector('[data-bcf-marker-id="t1"]') as SVGGElement;
    assert.ok(pin, 'a Pin is registered for the topic');
    assert.equal(pin.style.display, 'none', 'not projected until the shared loop ticks');
    flush();
    assert.equal(pin.style.display, '');
    // Mutation check: reverting to the bespoke WebGPU-projection-adapter
    // DOM renderer would either fail the [data-bcf-marker-id] lookup (no
    // such attribute on a plain <div> marker) or show it immediately.
  });

  it('clicking a marker sets the active topic and opens the BCF panel', () => {
    projectWithTopics([topicWithCameraPosition()]);
    let openedPanel: string | null = null;
    useViewerStore.setState({
      openWorkspacePanel: (panel) => {
        openedPanel = panel;
      },
    });
    const { container, flush } = renderScene(<BCFOverlay />);
    flush();
    const pin = container.querySelector('[data-bcf-marker-id="t1"]') as SVGGElement;
    act(() => {
      pin.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(useViewerStore.getState().activeTopicId, 't1');
    assert.equal(openedPanel, 'bcf');
    // Mutation check: dropping the onClick wiring on the Pin leaves
    // activeTopicId unset and the panel never opened.
  });
});
