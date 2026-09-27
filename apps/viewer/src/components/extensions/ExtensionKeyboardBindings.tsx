/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Install contributed shortcuts after reserving the built-in command chords (#5841). */
import { useEffect } from 'react';
import { evaluateWhen, parseWhen, type KeybindingContribution, type WhenContext } from '@ifc-lite/extensions';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';
import { registerKeyboardBinding } from '@/lib/commands/dispatcher';
import { extensionKeyCollision, parseExtensionKey } from '@/lib/commands/extension-keybindings';
import { toast } from '@/components/ui/toast';
import { describeRunCommandError } from '@/services/extensions/runtime-errors';

function liveWhenContext(): WhenContext {
  const state = useViewerStore.getState();
  return {
    'model.loaded': state.models.size > 0,
    'model.count': state.models.size,
    'selection.count': state.selectedEntityIds.size,
    'viewer.open': true,
    desktop: false,
    embed: false,
  };
}

export function ExtensionKeyboardBindings(): null {
  const host = useOptionalExtensionHost();
  const contributions = useSlotContributions<KeybindingContribution>('keybindings');

  useEffect(() => {
    if (!host) return;
    const removers: Array<() => void> = [];
    for (const { extensionId, payload } of contributions) {
      const chord = parseExtensionKey(payload.key);
      if (!chord) {
        console.warn(`[keyboard] Ignoring invalid extension shortcut ${extensionId}:${payload.command}: ${payload.key}`);
        continue;
      }
      const collision = extensionKeyCollision(chord);
      if (collision) {
        console.warn(`[keyboard] Ignoring ${extensionId}:${payload.command} (${payload.key}); ${collision} owns that chord.`);
        continue;
      }
      const when = payload.when ? parseWhen(payload.when) : null;
      if (when && !when.ok) {
        console.warn(`[keyboard] Ignoring invalid when clause for ${extensionId}:${payload.command}: ${payload.when}`);
        continue;
      }
      removers.push(registerKeyboardBinding({
        id: `${extensionId}:${payload.command}`,
        when: 'global', layer: 'global', keys: [chord],
        active: () => !when || (when.ok && evaluateWhen(when.value, liveWhenContext())),
        run: () => {
          void host.dispatcher.fire(`onCommand:${payload.command}` as `onCommand:${string}`)
            .then(() => host.runCommand(payload.command, extensionId))
            .catch((error: unknown) => toast.error(describeRunCommandError(payload.command, error)));
        },
      }));
    }
    return () => { for (const remove of removers) remove(); };
  }, [host, contributions]);

  return null;
}
