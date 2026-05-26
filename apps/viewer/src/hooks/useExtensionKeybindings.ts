/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo } from 'react';
import { evaluateWhen, parseWhen, type KeybindingContribution } from '@ifc-lite/extensions';
import { useSlotContributions } from './useSlotContributions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';

export function useExtensionKeybindings() {
  const host = useOptionalExtensionHost();
  const contributions = useSlotContributions<KeybindingContribution>('keybindings');
  const modelCount = useViewerStore((s) => s.models.size);
  const selectedCount = useViewerStore((s) => s.selectedEntityIds.size);
  const bindings = useMemo(() => contributions.map((c) => c.payload), [contributions]);

  useEffect(() => {
    if (!host || bindings.length === 0) return;
    const context = {
      'model.loaded': modelCount > 0,
      'model.count': modelCount,
      'selection.count': selectedCount,
      'viewer.open': true,
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;
      const match = bindings.find((binding) => {
        if (!matchesKey(event, binding.key)) return false;
        if (!binding.when) return true;
        const parsed = parseWhen(binding.when);
        return parsed.ok && evaluateWhen(parsed.value, context);
      });
      if (!match) return;
      event.preventDefault();
      void host.dispatcher
        .fire(`onCommand:${match.command}` as `onCommand:${string}`)
        .then(() => host.runCommand(match.command));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bindings, host, modelCount, selectedCount]);
}

function matchesKey(event: KeyboardEvent, keySpec: string): boolean {
  const parts = keySpec.toLowerCase().split('+').map((part) => part.trim()).filter(Boolean);
  const key = parts[parts.length - 1];
  const wantsCtrl = parts.includes('ctrl') || parts.includes('cmd') || parts.includes('meta');
  const wantsShift = parts.includes('shift');
  const wantsAlt = parts.includes('alt') || parts.includes('option');
  if (wantsCtrl !== (event.ctrlKey || event.metaKey)) return false;
  if (wantsShift !== event.shiftKey) return false;
  if (wantsAlt !== event.altKey) return false;
  return event.key.toLowerCase() === key;
}
