/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One execution boundary for commands owned by the shared surface registry (#5870). */
import { trackUiEvent } from '@/lib/analytics';
import { commandIdForAnalytics, type UiSurface } from '@/lib/analytics-ui-events';
import type { SurfaceCommandContext, SurfaceCommandDefinition } from './surface-commands';

/** Dynamic palette rows use the same privacy-safe event boundary. */
export function trackCommandExecution(id: string, surface: UiSurface): void {
  trackUiEvent('command_executed', {
    command_id: commandIdForAnalytics(id),
    surface,
  });
}

export function runSurfaceCommand(command: SurfaceCommandDefinition, context: SurfaceCommandContext): void {
  trackCommandExecution(command.id, context.surface);
  command.run(context);
}
