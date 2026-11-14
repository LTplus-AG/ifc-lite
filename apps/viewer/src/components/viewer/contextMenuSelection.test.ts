/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { openContextMenuAt } from './contextMenuSelection.js';

describe('context menu during geometry restore', () => {
  afterEach(() => useViewerStore.getState().resetViewerState());

  it('#10218 consumes a right-click during restore and resumes after release', async () => {
    let picks = 0;
    let menus = 0;
    const canvas = { getBoundingClientRect: () => ({ left: 40, top: 30, width: 400, height: 300 }) } as unknown as HTMLCanvasElement;
    const renderer = { pick: async () => { picks++; return { expressId: 12 }; } };
    const args = { canvas, renderer, getPickOptions: () => ({}), openContextMenu: () => { menus++; } } as unknown as Parameters<typeof openContextMenuAt>[0];
    useViewerStore.setState({ models: new Map([['restore', { geometryRestorePending: true }]]) as never });

    await openContextMenuAt(args, 50, 60);
    assert.equal(picks, 0);
    assert.equal(menus, 0);

    useViewerStore.setState({ models: new Map([['restore', { geometryRestorePending: false }]]) as never });
    await openContextMenuAt(args, 50, 60);
    assert.equal(picks, 1);
    assert.equal(menus, 1);

    useViewerStore.setState({ geometryStreamingActive: true, loading: true });
    await openContextMenuAt(args, 50, 60);
    assert.equal(picks, 2, 'a cold streaming load keeps the existing path');
    assert.equal(menus, 2);
  });

  it('#10218 ignores a pick that resolves after the geometry restore hold starts', async () => {
    let resolvePick!: (value: { expressId: number }) => void;
    let menus = 0;
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }) } as unknown as HTMLCanvasElement;
    const renderer = { pick: () => new Promise<{ expressId: number }>((resolve) => { resolvePick = resolve; }) };
    const args = { canvas, renderer, getPickOptions: () => ({}), openContextMenu: () => { menus++; } } as unknown as Parameters<typeof openContextMenuAt>[0];
    useViewerStore.setState({ selectedEntityId: 7, models: new Map([['restore', { geometryRestorePending: false }]]) as never });

    const opening = openContextMenuAt(args, 50, 60);
    useViewerStore.setState({ models: new Map([['restore', { geometryRestorePending: true }]]) as never });
    resolvePick({ expressId: 12 });
    await opening;
    assert.equal(menus, 0);
    assert.equal(useViewerStore.getState().selectedEntityId, 7);

    useViewerStore.setState({ models: new Map([['restore', { geometryRestorePending: false }]]) as never });
    await openContextMenuAt({ ...args, renderer: { pick: async () => ({ expressId: 12 }) } } as never, 50, 60);
    assert.equal(menus, 1);
  });
});
