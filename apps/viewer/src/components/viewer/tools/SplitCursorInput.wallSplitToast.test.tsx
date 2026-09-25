/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A wall split can be committed from TWO places: the canvas click handler
 * (`selectionHandlers.ts`, covered by `selectionHandlers.wallSplitToast.test.ts`)
 * and the cursor-anchored distance entry's Enter key. Both call the same
 * `MutationSlice.splitWallAtDistance`, so both see the same `openings.skipped`
 * count — openings that stay attached to the source wall the split has just
 * tombstoned, and can end up orphaned.
 *
 * #3023 taught only the click handler to surface that count, leaving the
 * typed path with its own inlined copy of the success wording and no warning
 * at all, so typing a distance instead of clicking hid a data problem that
 * clicking reported. These tests drive the real input through the real store
 * and assert the EXACT strings the click path's test asserts, so the two
 * commit paths cannot come apart again.
 *
 * Since #5503 the entry is the scene kernel's `CursorInput`, so it needs the
 * scene harness (`renderScene`: real portal layers, a stub projector) and
 * one projector flush before the input is visible.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { blur, cleanup, type } from '@/test/render';
import { renderScene } from '../../viewport-ui/scene/test/scene-test-support.js';
import { SplitCursorInput, parseCutDistance } from './SplitCursorInput.js';

/** The mounted entry, after one projector flush so the anchor has projected. */
function mountInput(): HTMLInputElement {
  const scene = renderScene(<SplitCursorInput />);
  scene.flush();
  const input = scene.container.querySelector('[data-scene-primitive="cursor-input"] input');
  assert.ok(input, 'expected the cursor input to render in the aiming state');
  return input as HTMLInputElement;
}

function pressEnter(input: HTMLInputElement) {
  act(() => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

/** Stub `splitWallAtDistance` with a successful split reporting `openings`; records the distance it was asked for. */
function seedSplit(openings: { toLeft: number; toRight: number; skipped: number }, distances: number[] = []) {
  useViewerStore.setState({
    splitWallAtDistance: (_m: string, _e: number, distance: number) => {
      distances.push(distance);
      return {
        ok: true,
        left: { expressId: 1, globalId: 101 },
        right: { expressId: 2, globalId: 102 },
        openings,
      };
    },
  } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
}

describe('parseCutDistance', () => {
  it('reads metres, a % of the element length, and blank as the live cursor distance', () => {
    assert.equal(parseCutDistance('1.2', 1.5, 3), 1.2);
    assert.equal(parseCutDistance('50%', 1.5, 3), 1.5);
    assert.equal(parseCutDistance(' 25 % '.replace(' %', '%'), 1.5, 4), 1);
    assert.equal(parseCutDistance('', 1.5, 3), 1.5);
    assert.equal(parseCutDistance('abc', 1.5, 3), null);
    assert.equal(parseCutDistance('%', 1.5, 3), null);
  });
});

describe('SplitCursorInput: wall-split notices', () => {
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
      clearSplitHover: () => {},
      setSelectedEntityId: () => {},
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
  });

  afterEach(() => {
    cleanup();
    (toast as { info: (m: string) => void }).info = original.info;
    (toast as { success: (m: string) => void }).success = original.success;
    useViewerStore.setState({ splitWallAtDistance: original.splitWallAtDistance, activeTool: 'select', splitMode: 'idle' });
  });

  it('warns about openings the split could not reassign', () => {
    seedSplit({ toLeft: 1, toRight: 0, skipped: 2 });

    const input = mountInput();
    type(input, '1.2');
    pressEnter(input);

    assert.deepEqual(successCalls, ['Wall split (1 opening reassigned) — Ctrl+Z to undo']);
    assert.ok(
      infoCalls.some((m) => m.includes('2 openings could not be reassigned')),
      `expected a skipped-openings notice, got: ${JSON.stringify(infoCalls)}`,
    );
  });

  it('stays silent about skipped openings when none were skipped', () => {
    seedSplit({ toLeft: 1, toRight: 1, skipped: 0 });

    const input = mountInput();
    type(input, '1.2');
    pressEnter(input);

    assert.deepEqual(successCalls, ['Wall split (2 openings reassigned) — Ctrl+Z to undo']);
    assert.deepEqual(infoCalls, []);
  });

  it('cuts at a % of the element length, and at the cursor distance when blank (#5503)', () => {
    const distances: number[] = [];
    seedSplit({ toLeft: 0, toRight: 0, skipped: 0 }, distances);

    const input = mountInput();
    type(input, '25%');
    pressEnter(input);
    assert.deepEqual(distances, [0.75], '25% of a 3 m element is 0.75 m');

    // Blank + Enter is the same edit as a click: the live cursor distance.
    const input2 = mountInput();
    pressEnter(input2);
    assert.deepEqual(distances, [0.75, 1.5]);
  });

  it('does not cut on blur — the canvas click that blurs it is itself the click-split (#5503)', () => {
    const distances: number[] = [];
    seedSplit({ toLeft: 0, toRight: 0, skipped: 0 }, distances);

    const input = mountInput();
    type(input, '1.2');
    blur(input);
    assert.deepEqual(distances, []);
  });
});
