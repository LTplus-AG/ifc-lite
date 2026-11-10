/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CommandContribution, SlotContribution } from '@ifc-lite/extensions';
import { resolveExtensionIcon } from '@/components/extensions/icon-registry';
import { toast } from '@/components/ui/toast';
import { resolve } from '@/i18n/registry';
import type { ExtensionHostService } from '@/services/extensions/host';
import { describeRunCommandError } from '@/services/extensions/runtime-errors';
import type { Command } from './commandPaletteSearch';
import type { PaletteAvailability } from './palette-availability';

type CommandHost = Pick<ExtensionHostService, 'runCommand' | 'slotRegistry'>;

/** A new namespace deliberately drops legacy ambiguous `ext:<command>` recents.
 * Encoding a tuple also prevents delimiter collisions and keeps dynamic data
 * outside analytics' plain-code-id grammar (which collapses it to the prefix).
 */
export function paletteExtensionCommandId(owner: string, command: string): string {
  return `ext-command:${encodeURIComponent(JSON.stringify([owner, command]))}`;
}

export function buildPaletteExtensionCommands(
  contributions: readonly SlotContribution<CommandContribution>[],
  host: CommandHost | null,
  hostIsCurrent: () => boolean = () => true,
): Command[] {
  return contributions.filter(c => c.payload?.id && c.payload.title).map<Command>(contribution => {
    const { payload, extensionId } = contribution;
    const checkAvailability = (): PaletteAvailability => {
      if (!host || !hostIsCurrent()) return { status: 'disabled', reasonKey: 'commandPalette.availability.host' };
      // getAll copies the array, preserving each contribution's identity. An
      // uninstall/reinstall with identical ids must invalidate a captured row.
      if (!host.slotRegistry.getAll('commandPalette').includes(contribution)) {
        return { status: 'disabled', reasonKey: 'commandPalette.availability.feature' };
      }
      // Bundle loading, enabled records, handlers and grants remain host checks.
      return { status: 'available' };
    };
    return {
      id: paletteExtensionCommandId(extensionId, payload.id),
      runtimeSource: 'extension-command',
      label: payload.title,
      keywords: `${payload.id} ${payload.description ?? ''} ${extensionId} ${payload.paletteCategory ?? ''} extension command`,
      category: 'Extensions',
      icon: resolveExtensionIcon(payload.icon),
      detail: [extensionId, payload.paletteCategory].filter(Boolean).join(' · '),
      availability: checkAvailability(),
      checkAvailability,
      action: () => {
        const availability = checkAvailability();
        if (availability.status === 'disabled') {
          toast.error(resolve(availability.reasonKey));
          return;
        }
        if (host) {
          // Canonical run owns activation; a pre-fire here activates twice.
          void host.runCommand(payload.id, extensionId, undefined, () => checkAvailability().status === 'available').catch((error: unknown) => {
            toast.error(describeRunCommandError(`${payload.id} (${extensionId})`, error));
          });
        }
      },
    };
  });
}
