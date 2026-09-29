/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { flushPlacementGeometry } from './bounds-revision';

/**
 * #6436: the viewer's one flush wrapper picks the upload slice. Streaming keeps
 * the scene's short default (the worker pump needs the main thread), so does
 * navigation (frames must stay short); otherwise the queue left behind a
 * large stream drains in longer slices.
 */
describe('flushPlacementGeometry upload slice (#6436)', () => {
  afterEach(() => useViewerStore.setState({ geometryStreamingActive: false }));

  function budgetFor(interacting: boolean): number | undefined {
    let seen: number | undefined = -1;
    const scene = {
      flushPending: (_device: GPUDevice, _pipeline: unknown, budgetMs?: number) => {
        seen = budgetMs;
        return false;
      },
    } as unknown as ReturnType<Renderer['getScene']>;
    flushPlacementGeometry(scene, {} as GPUDevice, {} as NonNullable<ReturnType<Renderer['getPipeline']>>, interacting);
    return seen;
  }

  it('grants a longer slice once the stream has ended and nobody is navigating', () => {
    useViewerStore.setState({ geometryStreamingActive: false });
    assert.equal(budgetFor(false), 32);
  });

  it('keeps the streaming default while geometry streams', () => {
    useViewerStore.setState({ geometryStreamingActive: true });
    assert.equal(budgetFor(false), undefined);
  });

  it('keeps the streaming default while the user navigates', () => {
    useViewerStore.setState({ geometryStreamingActive: false });
    assert.equal(budgetFor(true), undefined);
  });
});
