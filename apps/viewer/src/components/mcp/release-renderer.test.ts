/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `/mcp` renderer teardown sequence (#2445).
 *
 * Both scenes used to end `dispose()` with `renderer.dispose()` and a
 * `removeChild`, never calling `forceContextLoss()`, so the WebGL context was
 * released only whenever the canvas happened to be collected. That matters on
 * `/mcp` specifically, where `McpPlayground` unmounts and remounts
 * `PlaygroundViewer` every time the 3D panel is toggled.
 *
 * What this can and cannot prove: `THREE.WebGLRenderer` is unconstructible
 * under happy-dom (no WebGL at all), so no suite can observe a real GL context
 * being handed back. What is testable — and what actually regressed — is the
 * *sequence*: dispose, then force the loss, then detach. That is why it was
 * extracted into `releaseRenderer` with a structural parameter. The container
 * and canvas below are real DOM; only the renderer is a stand-in, and it is
 * built so the pre-fix behaviour (no `forceContextLoss` call) is exactly what
 * the assertions reject.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { releaseRenderer, type ReleasableRenderer } from './release-renderer.js';

/** Records the teardown calls in the order the code under test makes them. */
function fakeRenderer(): ReleasableRenderer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    domElement: document.createElement('canvas'),
    dispose() { calls.push('dispose'); },
    forceContextLoss() { calls.push('forceContextLoss'); },
  };
}

describe('releaseRenderer (#2445)', () => {
  it('forces the context loss, after dispose and before detaching the canvas', () => {
    const container = document.createElement('div');
    const renderer = fakeRenderer();
    container.appendChild(renderer.domElement);
    const realRemoveChild = container.removeChild.bind(container);
    container.removeChild = (<T extends Node>(child: T): T => {
      renderer.calls.push('detached');
      return realRemoveChild(child);
    }) as typeof container.removeChild;

    releaseRenderer(renderer, container);

    assert.deepEqual(
      renderer.calls,
      ['dispose', 'forceContextLoss', 'detached'],
      'three.js resources go first, then the browser is asked for the context back, then the DOM',
    );
    assert.equal(renderer.domElement.parentNode, null, 'and the canvas is detached');
    assert.equal(container.childNodes.length, 0);
  });

  it('still releases the context when the canvas was never in this container', () => {
    // The DOM guard predates this change and is deliberately kept: a canvas
    // reparented (or already removed) by something else must not be yanked out
    // of whatever now owns it. Releasing the GL context is unconditional
    // though — that is the resource this exists to reclaim.
    const container = document.createElement('div');
    const elsewhere = document.createElement('div');
    const renderer = fakeRenderer();
    elsewhere.appendChild(renderer.domElement);

    releaseRenderer(renderer, container);

    assert.deepEqual(renderer.calls, ['dispose', 'forceContextLoss']);
    assert.equal(renderer.domElement.parentNode, elsewhere, 'someone else owns the canvas');
  });
});
