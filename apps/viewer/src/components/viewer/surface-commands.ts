/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Palette projection of the canonical registry, loaded with the palette (#8947).
 * Eager ribbon/context/mobile callers import surface-command-registry directly.
 * Keep their startup graph independent of palette-only availability inspection.
 */
import { useViewerStore } from '@/store';
import { bindLoadRecovery } from '@/hooks/loadRecoveryActions';
import type { Command } from './commandPaletteSearch';
import { paletteAvailability, paletteToggleState } from './palette-availability';
import { SURFACE_COMMANDS, commandRowFromDefinition } from './surface-command-registry';
import type { SurfaceCommandContext, SurfaceCommandState } from './surface-command-types';
export * from './surface-command-registry';

export function paletteSurfaceCommands(
  state: SurfaceCommandState,
  execute: (code: string) => void,
  context: Omit<SurfaceCommandContext, 'surface' | 'execute'> = {},
): Command[] {
  const loadRecovery = bindLoadRecovery();
  return SURFACE_COMMANDS
    .filter((command) => command.surfaces.some((surface) => surface === 'palette') && (command.enabled(state) || (!state.canEditInSession && command.enabled({ ...state, canEditInSession: true }))))
    .map((command) => {
      const fullContext: SurfaceCommandContext = { ...context, surface: 'palette', execute, loadRecovery };
      const checkAvailability = () => paletteAvailability(command, fullContext, undefined, state);
      return { ...commandRowFromDefinition(command, fullContext),
        availability: checkAvailability(), checkAvailability,
        stateKey: paletteToggleState(command.id, useViewerStore.getState()) };
    });
}
