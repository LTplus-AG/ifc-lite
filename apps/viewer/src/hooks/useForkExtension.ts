/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useForkExtension` — wraps the fork-an-installed-extension flow.
 *
 * Looks up the bundle from the loader, formats it as a chat-prompt
 * fenced bundle via `formatBundleForPrompt`, queues the prompt and
 * opens the chat. Pure side-effects; UI calls `fork(id)` and reacts
 * to toasts.
 */

import { useCallback } from 'react';
import { formatBundleForPrompt } from '@ifc-lite/extensions';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import * as toastText from '@/components/extensions/toast-helpers';

export function useForkExtension(): (id: string) => void {
  const host = useExtensionHost();
  const queueChatPrompt = useViewerStore((s) => s.queueChatPrompt);
  const setChatPanelVisible = useViewerStore((s) => s.setChatPanelVisible);

  return useCallback(
    (id: string) => {
      try {
        const bundle = host.loader.getBundle(id);
        if (!bundle) {
          toast.error(`Bundle for ${id} not loaded.`);
          return;
        }
        const formatted = formatBundleForPrompt(bundle);
        const prompt = [
          `Fork the installed extension ${bundle.manifest.id} (v${bundle.manifest.version}).`,
          '',
          formatted.text,
          '',
          'What would you like to change?',
        ].join('\n');
        queueChatPrompt(prompt);
        setChatPanelVisible(true);
        toast.success(`Routed ${bundle.manifest.id} to chat for editing`);
      } catch (err) {
        toast.error(toastText.failed('Fork', err));
      }
    },
    [host, queueChatPrompt, setChatPanelVisible],
  );
}
