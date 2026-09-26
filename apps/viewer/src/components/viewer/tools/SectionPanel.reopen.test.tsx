/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reopening the MOUNTED Section tool (#4910).
 *
 * SectionPanel re-applies the persisted last cardinal mode when it mounts, and
 * those setters enable the cut. So the store alone cannot say whether a cut
 * comes back: leaving the tool must bring it back on reopen, and an explicit
 * clear (SDK `clearSection()`, a BCF viewpoint without planes) must not.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { createViewerAdapter } from '@/sdk/adapters/viewer-adapter.js';
import { ToolOverlays } from '../ToolOverlays.js';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';

const s = () => useViewerStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  useViewerStore.setState({
    activeTool: 'select',
    sectionPlane: getDefaultSectionPlane(),
    sectionPickMode: false,
    sectionPickPreview: null,
    drawing2DPanelVisible: false,
    drawing2D: null,
  });
  render(<SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot>);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

async function tool(name: string): Promise<void> {
  await act(async () => {
    s().setActiveTool(name);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function cutAt(axis: 'down' | 'front' | 'side', position: number): Promise<void> {
  await tool('section');
  await act(async () => {
    s().setSectionPlaneAxis(axis);
    s().setSectionPlanePosition(position);
  });
}

describe('Section tool reopen (#4910)', () => {
  it('leaving the tool hides the cut and reopening it shows the same cut', async () => {
    await cutAt('front', 35);
    await tool('select');
    assert.equal(s().sectionPlane.enabled, false, 'BUG: the cut is still reported after leaving the tool');
    await tool('section');
    assert.equal(s().sectionPlane.enabled, true);
    assert.equal(s().sectionPlane.axis, 'front');
    assert.equal(s().sectionPlane.position, 35);
  });

  it('an explicit clear stays cleared when the Section tool reopens', async () => {
    await cutAt('down', 40);
    await tool('select');
    await act(async () => createViewerAdapter(useViewerStore).setSection(null));
    await tool('section');
    assert.equal(s().sectionPlane.enabled, false, 'BUG: the cleared cut came back on reopen');
  });
});
