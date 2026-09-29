/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keyboard bindings of a running modeling command (charter #6232, WP2). The
 * chords live in `KEY_COMMANDS` (`command` context, plus `command.<id>` rows
 * for per-command keys); this registers their live actions on the shared
 * dispatcher's tool layer for as long as the command runs.
 */

import { registerKeyboardCommand } from '@/lib/commands/dispatcher';
import type { CommandContext, CommandSignal, ModelingCommand } from './types.js';

export interface CommandKeyActions {
  isActive(): boolean;
  commit(): boolean;
  cancel(): boolean;
  undoPoint(): boolean;
  nextField(): boolean;
  typeValue(draft: string): boolean;
  toggleSnap(): boolean;
  runKey(run: (g: unknown, ctx: CommandContext) => unknown | CommandSignal): boolean;
}

export function bindCommandKeys(command: ModelingCommand, actions: CommandKeyActions): () => void {
  const active = actions.isActive;
  const disposers = [
    registerKeyboardCommand('command.commit', () => actions.commit(), { active }),
    registerKeyboardCommand('command.cancel', () => actions.cancel(), { active }),
    registerKeyboardCommand('command.undoPoint', () => actions.undoPoint(), { active }),
    registerKeyboardCommand('command.nextField', () => actions.nextField(), { active }),
    registerKeyboardCommand('command.typeValue', (event) => actions.typeValue(event.key), { active }),
    registerKeyboardCommand('command.toggleSnap', () => actions.toggleSnap(), { active }),
    ...(command.keys ?? []).map((key) => registerKeyboardCommand(
      key.commandKey,
      () => actions.runKey(key.run),
      { active },
    )),
  ];
  return () => { for (const dispose of disposers) dispose(); };
}
