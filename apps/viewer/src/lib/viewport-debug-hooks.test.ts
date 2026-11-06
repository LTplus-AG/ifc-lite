/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer } from '@ifc-lite/renderer';
import { clearViewportDebugHooks, installViewportDebugHooks } from './viewport-debug-hooks';

afterEach(clearViewportDebugHooks);

it('#5895 exposes live annotation overlay vertices to the browser witness and clears the hook on teardown', () => {
  let vertices = 6;
  // Installation only stores the renderer; the overlay diagnostic reads its
  // own live supplier. Browser E2E supplies the renderer and authored curves.
  installViewportDebugHooks({} as Renderer, () => ({ hiddenIds: new Set(), isolatedIds: null }), () => vertices);
  const host = globalThis as Record<string, unknown>;
  const readVertices = host.__ifc_lite_annotation_line_vertices__;
  assert.equal(typeof readVertices, 'function');
  assert.equal((readVertices as () => number)(), 6);
  vertices = 0;
  assert.equal((readVertices as () => number)(), 0);

  clearViewportDebugHooks();
  assert.equal(host.__ifc_lite_annotation_line_vertices__, undefined);
});

it('#8413 frame observation reads only the renderer snapshot and clears on teardown', () => {
  const frame = { timestamp: 20, drawCalls: 3 };
  const renderer = {
    getFrameStats: () => frame,
    getScene: () => { throw new Error('frame observation must not walk the scene'); },
  } as unknown as Renderer;
  installViewportDebugHooks(renderer, () => ({ hiddenIds: new Set(), isolatedIds: null }), () => 0);
  const host = globalThis as Record<string, unknown>;
  assert.equal((host.__ifc_lite_render_frame__ as () => unknown)(), frame);
  clearViewportDebugHooks();
  assert.equal(host.__ifc_lite_render_frame__, undefined);
});

// #8566: exercise the installed hook, not source strings. Vite's existing test
// loader supplies this same mutable environment object to imported modules.
for (const gate of [undefined, 'false', 'true', 'internal-unqualified']) {
  it(`#8566 diagnostic color capture fails closed for gate ${String(gate)}`, async () => {
    const host = globalThis as Record<string, unknown>;
    const env = host.__VITE_ENV__ as Record<string, unknown>;
    const previous = env.VITE_GAUSSIAN_SPLATS;
    const calls: unknown[] = [];
    try {
      env.VITE_GAUSSIAN_SPLATS = gate;
      const renderer = { captureColorFrame: async (diagnostic?: boolean) => {
        calls.push(diagnostic);
        // A coalesced ordinary frame has no second copy: never manufacture it.
        return { width: 1, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 255]) };
      } } as unknown as Renderer;
      installViewportDebugHooks(renderer, () => ({ hiddenIds: new Set(), isolatedIds: null }), () => 0);
      const hook = host.__ifc_lite_capture_color_diagnostic__ as (() => Promise<unknown>) | undefined;
      if (gate === 'internal-unqualified') {
        assert.equal(typeof hook, 'function'); assert.equal(await hook!(), null);
        assert.deepEqual(calls, [true]);
      } else { assert.equal(hook, undefined); assert.deepEqual(calls, []); }
      clearViewportDebugHooks(); assert.equal(host.__ifc_lite_capture_color_diagnostic__, undefined);
    } finally { env.VITE_GAUSSIAN_SPLATS = previous; }
  });
}
