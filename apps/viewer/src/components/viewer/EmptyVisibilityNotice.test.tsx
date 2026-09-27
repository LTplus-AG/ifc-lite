/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import type { ComponentType } from 'react';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { cleanup, click, render } from '@/test/render';
import { ViewportHud } from '@/components/viewport-ui/hud/ViewportHud';
import type { GeometryResult } from '@ifc-lite/geometry';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(initial);
});

it('shows the active reasons and Reset everything restores the loaded view (#5879)', async () => {
  // The prior HUD component is the observable UI on a production revert. It
  // has no empty-result notice, so the title/action assertions fail there.
  const replacementPath = './EmptyVisibilityNotice.js';
  const previousPath = './MergeLayersBanner.js';
  const Notice: ComponentType<{ visible: boolean }> = await import(replacementPath)
    .then((module) => module.EmptyVisibilityNotice)
    .catch(async () => (await import(previousPath)).MergeLayersBanner);
  function MountedNotice() {
    const classFilter = useViewerStore((s) => s.classFilter);
    return <><ViewportHud /><Notice visible={classFilter !== null && classFilter.ids.size === 0} /></>;
  }

  const entry = fixtureModel('m');
  entry.geometryResult = { meshes: [{ expressId: 101 }], totalTriangles: 1 } as GeometryResult;
  useViewerStore.setState({
    models: new Map([['m', entry]]),
    classFilter: { ids: new Set<number>(), label: 'IfcDoor' },
    isolatedEntities: null,
    selectedStoreys: new Set<number>(),
    hiddenEntities: new Set(),
  });

  render(<MountedNotice />);
  assert.match(document.body.textContent ?? '', /Nothing is visible: the active filters exclude every element\./);
  assert.match(document.body.textContent ?? '', /Class filter/);
  const reset = [...document.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === 'Reset everything');
  assert.ok(reset, 'the notice offers the shared visibility reset');
  click(reset);
  assert.equal(useViewerStore.getState().classFilter, null);
  assert.doesNotMatch(document.body.textContent ?? '', /Nothing is visible/);
  assert.ok(entry.geometryResult?.meshes.length, 'the model still has geometry for the restored view');
});
