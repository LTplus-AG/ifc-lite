/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A wall split can be committed from TWO places: the canvas click handler
 * (`selectionHandlers.ts`, covered by `selectionHandlers.wallSplitToast.test.ts`)
 * and this panel's Cut button / Enter key. Both call the same
 * `MutationSlice.splitWallAtDistance`, so both see the same `openings.skipped`
 * count — openings that stay attached to the source wall the split has just
 * tombstoned, and can end up orphaned.
 *
 * #3023 taught only the click handler to surface that count, leaving this panel
 * with its own inlined copy of the success wording and no warning at all, so
 * typing a distance instead of clicking hid a data problem that clicking
 * reported. These tests drive the real panel through the real store and assert
 * the EXACT strings the click path's test asserts, so the two commit paths
 * cannot come apart again: against the pre-fix panel `toast.info` is never
 * called.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { render, cleanup, click } from '@/test/render';
import { SplitNumericInput } from './SplitNumericInput.js';

/** The panel's commit control. Labelled "Cut" — the Enter key runs the same `commitAt`. */
function cutButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Cut',
  );
  assert.ok(button, 'expected the panel to render its Cut button');
  return button as HTMLButtonElement;
}

/** Stub `splitWallAtDistance` with a successful split reporting `openings`. */
function seedSplit(openings: { toLeft: number; toRight: number; skipped: number }) {
  useViewerStore.setState({
    splitWallAtDistance: () => ({
      ok: true,
      left: { expressId: 1, globalId: 101 },
      right: { expressId: 2, globalId: 102 },
      openings,
    }),
  } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
}

describe('SplitNumericInput: wall-split notices', () => {
  const original = {
    splitWallAtDistance: useViewerStore.getState().splitWallAtDistance,
    info: toast.info,
    success: toast.success,
  };
  let infoCalls: string[];
  let successCalls: string[];

  beforeEach(() => {
    infoCalls = [];
    successCalls = [];
    (toast as { info: (m: string) => void }).info = (m: string) => infoCalls.push(m);
    (toast as { success: (m: string) => void }).success = (m: string) => successCalls.push(m);
    useViewerStore.setState({
      activeTool: 'split',
      splitMode: 'aiming',
      splitHoverPoint: [0, 0, 0],
      splitHoverDistance: 1.5,
      splitHoverLength: 3,
      splitTargetModelId: 'm1',
      splitTargetExpressId: 42,
      cameraCallbacks: { projectToScreen: () => ({ x: 10, y: 10 }) },
      clearSplitHover: () => {},
      setSelectedEntityId: () => {},
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
  });

  afterEach(() => {
    cleanup();
    (toast as { info: (m: string) => void }).info = original.info;
    (toast as { success: (m: string) => void }).success = original.success;
    useViewerStore.setState({ splitWallAtDistance: original.splitWallAtDistance });
  });

  it('warns about openings the split could not reassign', () => {
    seedSplit({ toLeft: 1, toRight: 0, skipped: 2 });

    const container = render(<SplitNumericInput />);
    click(cutButton(container));

    assert.deepEqual(successCalls, ['Wall split (1 opening reassigned) — Ctrl+Z to undo']);
    assert.ok(
      infoCalls.some((m) => m.includes('2 openings could not be reassigned')),
      `expected a skipped-openings notice, got: ${JSON.stringify(infoCalls)}`,
    );
  });

  it('stays silent about skipped openings when none were skipped', () => {
    seedSplit({ toLeft: 1, toRight: 1, skipped: 0 });

    const container = render(<SplitNumericInput />);
    click(cutButton(container));

    assert.deepEqual(successCalls, ['Wall split (2 openings reassigned) — Ctrl+Z to undo']);
    assert.deepEqual(infoCalls, []);
  });
});
