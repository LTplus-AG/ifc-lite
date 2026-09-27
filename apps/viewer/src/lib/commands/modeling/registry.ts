/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The modeling command registry (charter #6232, WP2). One row per command
 * id; `startCommand(id)` looks the command up here and the HUD renders its
 * `hud` entry. Built-in commands register from their own module; tests
 * register throwaway commands and remove them again.
 */

import type { ViewerState } from '@/store';
import type { CommandId, ModelingCommand, Workplane, WorkplaneSpec } from './types.js';

const COMMANDS = new Map<CommandId, ModelingCommand>();

/** Register a command; returns the unregister function. Duplicate ids throw. */
export function registerModelingCommand<G>(command: ModelingCommand<G>): () => void {
  if (COMMANDS.has(command.id)) throw new Error(`Modeling command already registered: ${command.id}`);
  const erased = command as unknown as ModelingCommand;
  COMMANDS.set(command.id, erased);
  return () => { if (COMMANDS.get(command.id) === erased) COMMANDS.delete(command.id); };
}

export function getModelingCommand(id: CommandId): ModelingCommand | undefined {
  return COMMANDS.get(id);
}

export type WorkplaneResolver = (s: ViewerState, modelId: string, spec: WorkplaneSpec) => Workplane | { refused: string };

let workplaneResolver: WorkplaneResolver = () => ({ refused: 'No workplane resolver is registered.' });

/**
 * The session builds its workplane through this seam, installed with the
 * built-in commands (`builtin.ts`). The slice cannot import `workplane.ts`
 * itself: its federation-alignment path reaches the store module, which
 * composes the slice — an import cycle.
 */
export function setWorkplaneResolver(resolver: WorkplaneResolver): void {
  workplaneResolver = resolver;
}

export function resolveWorkplane(s: ViewerState, modelId: string, spec: WorkplaneSpec): Workplane | { refused: string } {
  return workplaneResolver(s, modelId, spec);
}
