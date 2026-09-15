/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as Cesium from 'cesium';
import { CesiumViewerLifetime } from '../../components/viewer/cesium/cesium-viewer-lifetime';
import { SunPathDome } from './cesium-sun';

function createDome() {
  const dataSources = new Cesium.DataSourceCollection();
  let renders = 0;
  let destroyed = false;
  const viewer = {
    get dataSources() {
      if (destroyed) throw new Error('Viewer.destroy() invalidated dataSources');
      return dataSources;
    },
    scene: { requestRender() { renders += 1; } },
  } as unknown as InstanceType<typeof Cesium.Viewer>;
  const lifetime = new CesiumViewerLifetime(viewer);
  const dome = new SunPathDome(Cesium, viewer, {
    origin: { longitude: 8.5, latitude: 47.4, height: 400 }, radius: 40,
    date: new Date('2026-01-01T12:00:00Z'), showAnalemmas: false,
  }, lifetime);
  return { dataSources, dome, lifetime, renders: () => renders, destroyViewer: () => { destroyed = true; } };
}

it('removes a late-added SunPathDome datasource after viewer retirement (#4807)', async () => {
  const { dataSources, lifetime, renders, destroyViewer } = createDome();
  const rendersBeforeRetire = renders();
  destroyViewer();
  lifetime.retire();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(dataSources.length, 0, 'a retired dome must not remain in a live collection');
  assert.equal(renders(), rendersBeforeRetire, 'late attachment must not request a retired scene render');
});

it('retires SunPathDome repeatedly without a second datasource operation (#4807)', async () => {
  const { dataSources, dome, lifetime } = createDome();
  await Promise.resolve();
  dome.destroy();
  dome.destroy();
  lifetime.retire();
  await Promise.resolve();
  assert.equal(dataSources.length, 0);
});
