/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's own keys (charter #6232, M2): the `workspace.model`
 * rows of `KEY_COMMANDS`, live on the dispatcher's tool layer while the
 * workspace is open, so W draws a wall there and nowhere else. Walking keeps
 * W for itself. Each tool PR adds its row here beside its rail entry.
 */

import { registerKeyboardCommand } from '@/lib/commands/dispatcher';
import { useViewerStore } from '@/store';
import type { CommandId } from './types.js';
import { sessionWorkplaneBlock, stepSessionStorey } from './workspace-storeys.js';
import { copyShortcut, pasteShortcut } from './copy-keys.js';

/**
 * Start a modeling command from the workspace (rail, key, palette, welcome
 * card), entering the workspace first if needed. A drawing command needs a
 * plane to draw on; without one it is refused (false) and the rail says why.
 */
export function launchModelCommand(id: CommandId, opts: { drawsOnWorkplane?: boolean } = {}): boolean {
  const s = useViewerStore.getState();
  if (s.workspaceMode !== 'model' && !s.enterModelWorkspace()) return false;
  const now = useViewerStore.getState();
  if ((opts.drawsOnWorkplane ?? true) && sessionWorkplaneBlock(now)) return false;
  now.startCommand(id);
  return useViewerStore.getState().session?.activeCommandId === id;
}

function workspaceKeysLive(): boolean {
  const s = useViewerStore.getState();
  return s.workspaceMode === 'model' && s.activeTool !== 'walk';
}

export function bindModelWorkspaceKeys(): () => void {
  const active = workspaceKeysLive;
  const disposers = [
    registerKeyboardCommand('model.wall', () => launchModelCommand('wall.place'), { active }),
    registerKeyboardCommand('model.slab', () => launchModelCommand('slab.place'), { active }),
    registerKeyboardCommand('model.column', () => launchModelCommand('column.place'), { active }),
    registerKeyboardCommand('model.beam', () => launchModelCommand('beam.place'), { active }),
    registerKeyboardCommand('model.room', () => launchModelCommand('room.place'), { active }),
    registerKeyboardCommand('model.opening', () => launchModelCommand('opening.place'), { active }),
    registerKeyboardCommand('model.door', () => launchModelCommand('door.place'), { active }),
    registerKeyboardCommand('model.window', () => launchModelCommand('window.place'), { active }),
    registerKeyboardCommand('model.splitMulti', () => launchModelCommand('split.multi'), { active }),
    registerKeyboardCommand('model.storeyUp', () => stepSessionStorey(useViewerStore.getState(), 1), { active }),
    registerKeyboardCommand('model.storeyDown', () => stepSessionStorey(useViewerStore.getState(), -1), { active }),
    registerKeyboardCommand('model.copy', () => copyShortcut(), { active }),
    registerKeyboardCommand('model.paste', () => pasteShortcut(launchModelCommand, false), { active }),
    registerKeyboardCommand('model.pasteInPlace', () => pasteShortcut(launchModelCommand, true), { active }),
    registerKeyboardCommand('model.array', () => launchModelCommand('element.array'), { active }),
    registerKeyboardCommand('model.move', () => launchModelCommand('element.move'), { active }),
    registerKeyboardCommand('model.rotate', () => launchModelCommand('element.rotate'), { active }),
    registerKeyboardCommand('model.stair', () => launchModelCommand('stair.place'), { active }),
    registerKeyboardCommand('model.railing', () => launchModelCommand('railing.place'), { active }),
    registerKeyboardCommand('model.pushPull', () => launchModelCommand('element.pushPull', { drawsOnWorkplane: false }), { active }),
    registerKeyboardCommand('model.align', () => launchModelCommand('element.align'), { active }),
  ];
  return () => { for (const dispose of disposers) dispose(); };
}
