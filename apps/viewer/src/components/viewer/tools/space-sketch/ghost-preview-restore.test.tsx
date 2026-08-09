/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Space Sketch close path: the ghost preview must not outlive the view restore.
 *
 * `useSpaceGhostPreview` and `useSpaceSceneFraming` both write the visibility
 * slice, and they run on different clocks — the framing hook restores the prior
 * view synchronously when `enabled` flips, while the ghost hook rebuilt from an
 * 80 ms debounce. A teardown rebuild that touched `ghostExceptEntities` therefore
 * landed AFTER the restore and undid it.
 *
 * That is not a cosmetic race: `setGhostExceptEntities(null)` also nulls
 * `isolatedEntities` (visibilitySlice.ts:227), so the late clear wiped the user's
 * restored ISOLATION as well as their prior X-ray. Opening Space Sketch on a
 * clash-focused or isolated view and closing it dropped that view a frame later.
 *
 * Both hooks are rendered together here, in the same order the overlay calls
 * them, because the bug lives in their interaction rather than in either one.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store/index.js';
import { useSpaceGhostPreview, type GhostSpec } from './useSpaceGhostPreview.js';
import { useSpaceSceneFraming } from './useSpaceSceneFraming.js';

/** The user's view BEFORE Space Sketch opened (e.g. a focused clash). */
const PRIOR_XRAY = new Set([4001, 4002]);
/** Existing IfcSpace ids the tool keeps solid while drafting. */
const CONTEXT_IDS = [11, 12];
const GHOSTS: GhostSpec[] = [
  { corners: [[0, 0], [4, 0], [4, 3]], floorElev: 0, height: 3 },
];

/** Mirrors the overlay: ghost preview first, then scene framing. */
function Harness({ enabled }: { enabled: boolean }) {
  useSpaceGhostPreview({ enabled, ghosts: enabled ? GHOSTS : [], contextIds: CONTEXT_IDS });
  useSpaceSceneFraming({ enabled, existingSpaceIds: CONTEXT_IDS });
  return null;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(enabled: boolean): void {
  act(() => {
    root!.render(<Harness enabled={enabled} />);
  });
}

/** Let the 80 ms ghost debounce fire (and anything it schedules) before asserting. */
async function pastDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 160));
  });
}

beforeEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useViewerStore.setState({
    isolatedEntities: null,
    hiddenEntities: new Set<number>(),
    ghostExceptEntities: new Set(PRIOR_XRAY),
  });
});

describe('Space Sketch teardown vs. the restored view', () => {
  it('leaves the restored X-ray in place instead of clearing it a debounce later', async () => {
    render(true);
    await pastDebounce();
    // While open the tool owns the X-ray channel, keyed on its own ids.
    const during = useViewerStore.getState().ghostExceptEntities;
    assert.ok(during, 'the tool must X-ray the model while drafting');
    assert.ok(during.has(11), 'existing spaces stay solid');

    render(false);
    // Synchronously after the flip, the framing hook has already restored.
    assert.deepEqual(
      [...(useViewerStore.getState().ghostExceptEntities ?? [])].sort(),
      [...PRIOR_XRAY].sort(),
      'restore must replay the prior X-ray on the enabled transition',
    );

    await pastDebounce();
    // RED before the fix: the debounced teardown called setGhostExceptEntities(null)
    // here and the prior view was gone one frame after it came back.
    assert.deepEqual(
      [...(useViewerStore.getState().ghostExceptEntities ?? [])].sort(),
      [...PRIOR_XRAY].sort(),
      'and nothing may clear it afterwards',
    );
  });

  it('does not wipe restored isolation, which shares the same setter', async () => {
    // Isolation and X-ray are mutually exclusive in the slice, so a prior
    // ISOLATED view is the other half of the same bug: the late
    // setGhostExceptEntities(null) nulls isolatedEntities too.
    useViewerStore.setState({
      isolatedEntities: new Set([9001]),
      ghostExceptEntities: null,
      hiddenEntities: new Set<number>(),
    });
    render(true);
    await pastDebounce();
    render(false);
    await pastDebounce();
    assert.deepEqual(
      [...(useViewerStore.getState().isolatedEntities ?? [])],
      [9001],
      'the isolation the user had before the tool opened must survive the close',
    );
  });

  /**
   * Bounding control. Removing the teardown X-ray clear must not leave the
   * TOOL'S OWN X-ray applied when there was no prior view to restore — the
   * model would stay ghosted after the tool closed. `restore` clears it via
   * `setIsolatedEntities`, which nulls `ghostExceptEntities` unconditionally.
   */
  it('still clears the tool X-ray when there was no prior view', async () => {
    useViewerStore.setState({
      isolatedEntities: null,
      ghostExceptEntities: null,
      hiddenEntities: new Set<number>(),
    });
    render(true);
    await pastDebounce();
    assert.ok(useViewerStore.getState().ghostExceptEntities, 'tool X-ray applied while open');

    render(false);
    await pastDebounce();
    assert.equal(
      useViewerStore.getState().ghostExceptEntities,
      null,
      'the model must render normally again after close',
    );
  });
});
