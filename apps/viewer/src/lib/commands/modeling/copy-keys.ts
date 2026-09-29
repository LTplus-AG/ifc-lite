/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Copy and paste keys of the Model workspace (#6232 C3), bound with the
 * workspace's other keys (`keys-workspace.ts`). Copy fills the workspace's
 * copy buffer; paste runs `element.paste`, at the cursor or, for paste in
 * place, committed at once at the copied plan position on the current
 * storey: copy on one storey, switch storey, paste in place.
 */

import { toast } from '@/components/ui/toast';
import { resolve as translate } from '@/i18n/registry';
import { useViewerStore } from '@/store';
import { copySelectionToClipboard, readCopyClipboard } from './copy-clipboard.js';
import { commitCommand, updateCommandGesture } from './runtime.js';
import type { PasteGesture } from './commands/element-paste.js';

/** Copy the selection. Declines (false) with nothing selected or with page text selected, so the browser copies that. */
export function copyShortcut(options: { hasTextSelection?: () => boolean } = {}): boolean {
  const s = useViewerStore.getState();
  const modelId = s.session?.modelId;
  const hasText = options.hasTextSelection ?? (() => Boolean(globalThis.getSelection?.()?.toString()));
  if (!modelId || hasText()) return false;
  const verdict = copySelectionToClipboard(s, modelId);
  if (verdict.ok) {
    toast.success(translate('copyArray.copied', { count: verdict.count, countDisplay: String(verdict.count) }));
    return true;
  }
  if (verdict.reason === null) return false;
  toast.error(verdict.reason);
  return true;
}

/** Start a paste; `inPlace` commits it at once. */
export function pasteShortcut(launch: (id: string) => boolean, inPlace: boolean): boolean {
  if (!readCopyClipboard()) {
    toast.info(translate('copyArray.paste.empty'));
    return true;
  }
  if (!launch('element.paste') || !inPlace) return true;
  updateCommandGesture((g) => ({ ...(g as PasteGesture), inPlace: true }));
  commitCommand();
  return true;
}
