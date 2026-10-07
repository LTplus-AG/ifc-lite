/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolve a parsed deep link against this browser's native content
 * libraries and open the right panel (#6927). A missing or unreadable
 * artifact still opens its panel and reports why, so a stale link degrades
 * to "here is where it would have been" instead of failing silently.
 */

import { useLinkedReceipt } from './linked-receipt';
import type { StoreApi } from 'zustand';
import type { ViewerState } from '@/store';
import { assistantLibrary, openConversation, useAssistantLibrary } from '@/lib/assistant/library';
import { useAssistant } from '@/lib/assistant/conversation';
import { modelChangeLibrary, useModelChangeReceipts } from '@/lib/actions/receipts';
import { bcfDraftLibrary, useBcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import type { ArtifactKind, ParsedDeepLink } from './artifact-link';

export type DeepLinkOutcome =
  | { status: 'opened'; panel: ViewerState['sidebarActivePanel']; kind: ArtifactKind | null }
  | { status: 'missing' | 'unavailable'; panel: ViewerState['sidebarActivePanel']; kind: ArtifactKind }
  | { status: 'busy'; panel: ViewerState['sidebarActivePanel']; kind: 'conversation' }
  | { status: 'refused'; reason: 'unknown-panel' | 'conflicting-target' | 'invalid-id' };

async function present(initialize: () => Promise<boolean>, has: () => boolean): Promise<'found' | 'missing' | 'unavailable'> {
  if (!(await initialize())) return 'unavailable';
  return has() ? 'found' : 'missing';
}

export async function resolveDeepLink(store: StoreApi<ViewerState>, link: ParsedDeepLink): Promise<DeepLinkOutcome> {
  if (!link.ok) return { status: 'refused', reason: link.reason };
  const { panel, artifact } = link;
  store.getState().showWorkspacePanel(panel, 'programmatic');
  if (!artifact) return { status: 'opened', panel, kind: null };
  switch (artifact.kind) {
    case 'conversation': {
      const found = await present(assistantLibrary.initialize,
        () => useAssistantLibrary.getState().entries.some((entry) => entry.id === artifact.id));
      if (found !== 'found') return { status: found, panel, kind: artifact.kind };
      // Never replace a conversation in progress to follow a link.
      const current = useAssistant.getState();
      if (current.status === 'streaming' || (current.messages.length > 0 && !current.archived)) {
        return { status: 'busy', panel, kind: 'conversation' };
      }
      const entry = useAssistantLibrary.getState().entries.find((candidate) => candidate.id === artifact.id);
      if (!entry) return { status: 'missing', panel, kind: artifact.kind };
      openConversation(entry);
      return { status: 'opened', panel, kind: artifact.kind };
    }
    case 'receipt': {
      const found = await present(modelChangeLibrary.initialize,
        () => useModelChangeReceipts.getState().entries.some((entry) => entry.id === artifact.id));
      if (found !== 'found') return { status: found, panel, kind: artifact.kind };
      useLinkedReceipt.setState({ id: artifact.id });
      return { status: 'opened', panel, kind: artifact.kind };
    }
    case 'bcfDraft': {
      const found = await present(bcfDraftLibrary.initialize,
        () => useBcfDraftLibrary.getState().entries.some((entry) => entry.id === artifact.id));
      if (found !== 'found') return { status: found, panel, kind: artifact.kind };
      useBcfDraftLibrary.setState({ activeId: artifact.id, dialogOpen: true });
      return { status: 'opened', panel, kind: artifact.kind };
    }
  }
}
