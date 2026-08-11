/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Space Sketch close path: what happens to IfcSpace visibility.
 *
 * `useSpaceSceneFraming` turns spaces on when the tool opens (IfcSpace is
 * class-hidden by default) and puts the prior visibility back on close —
 * EXCEPT after a confirm, where `keepSpacesVisible` means the freshly created
 * rooms must stay on screen. That exception was written as a skip:
 *
 *     if (!opts.keepSpacesVisible && store.typeVisibility.spaces !== prior…)
 *
 * so `keepSpacesVisible: true` performed no update at all. That is only the
 * same thing as "keep them visible" while nothing else touches the setting —
 * and the file's own sibling comment already concedes that something else may
 * ("Restore against the CAPTURED visibility, not a 'did we flip it' flag").
 * The visibility panel is one click away and the tool is open the whole time,
 * so hiding spaces mid-session and then confirming closed the tool with every
 * space the user had just created invisible: the exact outcome the exception
 * exists to prevent.
 *
 * `keepSpacesVisible` is therefore a FLOOR on the restore target, not a skip.
 * The bounding controls below are what stop the fix from becoming "always
 * leave spaces on": with `keepSpacesVisible: false` the captured prior value
 * must still be replayed in both directions.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store/index.js';
import { useSpaceSceneFraming } from './useSpaceSceneFraming.js';

/** Existing IfcSpace ids the tool frames on open. */
const CONTEXT_IDS = [11, 12];

type Restore = (opts: { keepSpacesVisible: boolean }) => void;

let restoreFn: Restore | null = null;

function Harness({ enabled }: { enabled: boolean }) {
  restoreFn = useSpaceSceneFraming({ enabled, existingSpaceIds: CONTEXT_IDS }).restore;
  return null;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(enabled: boolean): void {
  act(() => {
    root!.render(<Harness enabled={enabled} />);
  });
}

/** Whether IfcSpace is currently shown. */
function spacesVisible(): boolean {
  return useViewerStore.getState().typeVisibility.spaces;
}

/** Flip IfcSpace visibility the way any other surface would (e.g. the visibility panel). */
function setSpacesVisible(next: boolean): void {
  act(() => {
    if (useViewerStore.getState().typeVisibility.spaces !== next) {
      useViewerStore.getState().toggleTypeVisibility('spaces');
    }
  });
  assert.equal(spacesVisible(), next, 'test setup failed to reach the intended visibility');
}

/**
 * Open the tool with spaces starting at `priorVisible`, then confirm/cancel via
 * `restore`. Returns the resulting visibility.
 *
 * `duringSession` runs while the tool is open, standing in for anything that
 * writes the same setting mid-session.
 */
function runSession(opts: {
  priorVisible: boolean;
  duringSession?: () => void;
  keepSpacesVisible: boolean;
}): boolean {
  setSpacesVisible(opts.priorVisible);
  render(true);
  // The open behaviour must reveal spaces regardless of where they started;
  // without this the "hide them mid-session" step below could be vacuous.
  assert.equal(spacesVisible(), true, 'the tool must reveal spaces on open');
  opts.duringSession?.();
  act(() => {
    restoreFn!({ keepSpacesVisible: opts.keepSpacesVisible });
  });
  return spacesVisible();
}

beforeEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  restoreFn = null;
  useViewerStore.setState({
    isolatedEntities: null,
    hiddenEntities: new Set<number>(),
    ghostExceptEntities: null,
    cameraCallbacks: {
      ...useViewerStore.getState().cameraCallbacks,
      frameEntities: () => {},
      frameBuildingExtent: () => {},
    },
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('Space Sketch restore: IfcSpace visibility', () => {
  it('keeps the created spaces visible even when something hid spaces mid-session', () => {
    // RED before the fix: `keepSpacesVisible: true` skipped the update entirely,
    // so the tool closed with every space the confirm had just created hidden.
    const after = runSession({
      priorVisible: false,
      duringSession: () => setSpacesVisible(false),
      keepSpacesVisible: true,
    });
    assert.equal(after, true, 'after a confirm the user must see the spaces they created');
  });

  it('keeps them visible on the ordinary confirm path too', () => {
    // Nothing interferes: the tool already turned spaces on and they stay on.
    const after = runSession({ priorVisible: false, keepSpacesVisible: true });
    assert.equal(after, true);
  });

  /**
   * Bounding control 1. Treating `keepSpacesVisible` as a floor must not become
   * "always leave spaces on" — cancelling with spaces previously OFF has to put
   * them back off, which is the whole point of capturing the prior value.
   */
  it('still re-hides spaces on cancel when they were hidden before the tool opened', () => {
    const after = runSession({ priorVisible: false, keepSpacesVisible: false });
    assert.equal(after, false, 'cancel must replay the captured prior visibility');
  });

  /**
   * Bounding control 2, the other direction: a user who already had spaces on
   * must not have them turned off by closing the tool.
   */
  it('leaves spaces on after cancel when they were already on before the tool opened', () => {
    const after = runSession({ priorVisible: true, keepSpacesVisible: false });
    assert.equal(after, true);
  });

  /**
   * Bounding control 3: the cancel path must also honour the captured value
   * when something moved the setting mid-session — the behaviour the existing
   * `!== prior.spacesVisible` comparison was written for, which the fix must
   * not regress.
   */
  it('replays the captured value on cancel even when spaces were toggled mid-session', () => {
    const after = runSession({
      priorVisible: false,
      duringSession: () => setSpacesVisible(false),
      keepSpacesVisible: false,
    });
    assert.equal(after, false);
  });
});
