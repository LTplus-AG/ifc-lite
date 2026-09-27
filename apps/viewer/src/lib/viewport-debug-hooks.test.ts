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
