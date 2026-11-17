/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, Suspense, useLayoutEffect } from 'react';
import { cleanup, render } from '@/test/render';
import { useViewerStore } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice';
import { useSectionPaletteHost } from './section-palette-host';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial); });

test('#8947 section host retains committed identity while a replacement render suspends', async () => {
  useViewerStore.setState({ models: new Map(), geometryResult: null, modelPlacement: initial.modelPlacement,
    sectionPlane: getDefaultSectionPlane(), inactiveSectionPlanes: [],
    cameraCallbacks: { selectionBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 4, z: 8 } }) } });
  const committed: { host?: ReturnType<typeof useSectionPaletteHost> } = {};
  let suspend = false, renders = 0, commits = 0;
  let resume: () => void = () => {};
  const pending = new Promise<void>(resolve => { resume = resolve; });
  function Probe() {
    const host = useSectionPaletteHost();
    renders++;
    useLayoutEffect(() => { committed.host = host; commits++; });
    if (suspend) throw pending;
    return <span>Committed section host</span>;
  }
  render(<Suspense fallback={<span data-testid="section-host-pending" /> }><Probe /></Suspense>);
  const host = committed.host; assert.ok(host);
  assert.equal(host.sectionAddUnavailable('box'), undefined);
  const priorRenders = renders, priorCommits = commits;
  try {
    suspend = true;
    act(() => useViewerStore.setState({ models: new Map() }));
    assert.ok(renders > priorRenders, 'the real hook rendered the replacement snapshot');
    assert.equal(commits, priorCommits, 'the replacement render has not committed');
    assert.ok(document.querySelector('[data-testid="section-host-pending"]'));
    assert.equal(host.sectionAddUnavailable('box'), 'commandPalette.availability.loading',
      'an uncommitted replacement cannot publish its model identity to the live host');
    suspend = false;
    await act(async () => { resume(); await pending; });
    assert.ok(commits > priorCommits);
    assert.equal(committed.host, host, 'the mounted adapter retains its identity');
    assert.equal(host.sectionAddUnavailable('box'), undefined, 'the committed replacement is available');
    act(() => { assert.equal(host.addSectionPlane('box'), true); });
    assert.equal(useViewerStore.getState().activeTool, 'section');
    assert.ok(useViewerStore.getState().sectionPlane.box, 'activation reaches the real section-box action');
  } finally { suspend = false; resume(); }
});
