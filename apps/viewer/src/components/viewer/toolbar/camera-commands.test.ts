/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared camera command list is what both toolbar styles render, so a
 * command that dispatches to the wrong camera callback is wrong in both at
 * once. These assert the dispatch table itself; that each surface renders
 * the list is asserted by `components/viewer/toolbar-parity.test.ts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CameraCallbacks } from '@/store/types.js';
import { buildCameraCommands, type CameraCommandId } from './camera-commands.js';

/** Records which camera callback fired, and with what. */
function recordingCallbacks() {
  const calls: string[] = [];
  const callbacks: CameraCallbacks = {
    zoomIn: () => calls.push('zoomIn'),
    zoomOut: () => calls.push('zoomOut'),
    fitAll: () => calls.push('fitAll'),
    rotateLeft: () => calls.push('rotateLeft'),
    rotateRight: () => calls.push('rotateRight'),
    setPresetView: (view) => calls.push(`setPresetView:${view}`),
    frameSelection: () => calls.push('frameSelection'),
  };
  return { calls, callbacks };
}

/** What each command must do when pressed. */
const EXPECTED_DISPATCH: Record<CameraCommandId, string> = {
  home: 'goHome',
  zoomIn: 'zoomIn',
  zoomOut: 'zoomOut',
  fitAll: 'fitAll',
  viewTop: 'setPresetView:top',
  viewBottom: 'setPresetView:bottom',
  viewFront: 'setPresetView:front',
  viewBack: 'setPresetView:back',
  viewLeft: 'setPresetView:left',
  viewRight: 'setPresetView:right',
  rotateLeft: 'rotateLeft',
  rotateRight: 'rotateRight',
};

describe('shared camera command list', () => {
  it('dispatches every command to its own camera callback', () => {
    for (const [id, expected] of Object.entries(EXPECTED_DISPATCH) as [CameraCommandId, string][]) {
      const { calls, callbacks } = recordingCallbacks();
      const command = buildCameraCommands({ callbacks, goHome: () => calls.push('goHome') })
        .find((candidate) => candidate.id === id);
      assert.ok(command, `no command with id ${id}`);
      command.run();
      assert.deepEqual(calls, [expected], `${id} dispatched wrongly`);
    }
  });

  it('offers exactly the camera commands both toolbars are expected to host', () => {
    const ids = buildCameraCommands({ callbacks: {}, goHome: () => {} }).map((command) => command.id);
    assert.deepEqual(ids.slice().sort(), Object.keys(EXPECTED_DISPATCH).sort());
    // Rotate-90° existed only in the ribbon and zoom only outside the classic
    // strip until this list; naming them keeps a future trim honest (#1829).
    for (const id of ['rotateLeft', 'rotateRight', 'zoomIn', 'zoomOut'] as CameraCommandId[]) {
      assert.ok(ids.includes(id), `${id} dropped from the shared camera commands`);
    }
  });

  it('survives a camera that has not registered its callbacks yet', () => {
    // Before the Viewport mounts, `cameraCallbacks` is empty; pressing a
    // toolbar button then must no-op rather than throw.
    const commands = buildCameraCommands({ callbacks: {}, goHome: () => {} });
    for (const command of commands) assert.doesNotThrow(() => command.run());
  });

  it('marks the press-repeatedly commands so menu surfaces stay open', () => {
    const repeatable = buildCameraCommands({ callbacks: {}, goHome: () => {} })
      .filter((command) => command.repeatable)
      .map((command) => command.id)
      .sort();
    assert.deepEqual(repeatable, ['rotateLeft', 'rotateRight', 'zoomIn', 'zoomOut']);
  });
});
