/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
type CesiumModule = typeof import('cesium');
import { addDataSourceLayer } from './addDataSourceLayer';
import { CesiumViewerLifetime } from './cesium-viewer-lifetime';

it('releases a delayed context tileset instead of attaching it to a retired Viewer (#4807)', async () => {
  let resolveTileset!: (tileset: InstanceType<CesiumModule['Cesium3DTileset']>) => void;
  const delayed = new Promise<InstanceType<CesiumModule['Cesium3DTileset']>>((resolve) => { resolveTileset = resolve; });
  const cesium = { createOsmBuildingsAsync: () => delayed } as unknown as CesiumModule;
  let released = 0;
  const tileset = { destroy() { released += 1; } } as unknown as InstanceType<CesiumModule['Cesium3DTileset']>;
  const viewer = { scene: { primitives: { add() { throw new Error('retired viewer must not receive tiles'); } } } } as unknown as InstanceType<CesiumModule['Viewer']>;
  const lifetime = new CesiumViewerLifetime(viewer);
  const loading = addDataSourceLayer(cesium, viewer, 'osm-buildings', '', lifetime);
  lifetime.retire();
  resolveTileset(tileset);

  assert.equal(await loading, null);
  assert.equal(released, 1, 'a resolved-but-uninstalled tileset has one standalone owner');
});
