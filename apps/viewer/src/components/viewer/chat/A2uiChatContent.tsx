/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The A2UI part of an assistant message (lazy chunk). Feeds the reply into the
 * message's session as it streams, renders text and surfaces in order, turns
 * surface events into follow-up turns, and records the parsed reply on the
 * message once it is final so a reload replays it.
 */

import { useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { useViewerStore } from '@/store';
import type { ChatMessage } from '@/lib/llm/types';
import { followUpToChat } from '@/lib/a2ui/actions';
import { sessionFor, syncSession, STREAMING_MESSAGE_ID } from '@/lib/a2ui/chat-sessions';
import { SegmentsView, useViewerHost } from '@/components/a2ui/SegmentsView';

export interface A2uiChatContentProps {
  message: ChatMessage;
  isStreaming: boolean;
  renderText: (text: string, codeStart: number, key: string) => { node: ReactNode; codeCount: number };
  /** Shown when there is no viewer host (outside a BimProvider). */
  fallback: ReactNode;
}

export default function A2uiChatContent({ message, isStreaming, renderText, fallback }: A2uiChatContentProps) {
  const host = useViewerHost();
  const { id, content, a2ui } = message;
  // Looking a session up (or replaying a record) notifies nobody, so it is safe while rendering.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the session is per message id
  const initial = useMemo(() => (host ? sessionFor({ id, content, a2ui }, host) : null), [host, id]);
  const [replaced, setReplaced] = useState<{ id: string; session: ReturnType<typeof syncSession> } | null>(null);
  const synced = replaced?.id === id ? replaced.session : initial;

  // Feeding notifies the rendered segments, so it runs after render, before paint.
  useLayoutEffect(() => {
    if (!host) return;
    const session = syncSession({ id, content, a2ui }, host, isStreaming);
    if (session !== synced) setReplaced({ id, session });
    if (!isStreaming && id !== STREAMING_MESSAGE_ID && !a2ui && session.closed && session.hasSurfaces()) {
      useViewerStore.getState().setChatMessageA2ui(id, session.toRecord());
    }
  }, [host, id, content, a2ui, isStreaming, synced]);

  if (!host || !synced) return <>{fallback}</>;
  return <SegmentsView session={synced} host={host} onFollowUp={followUpToChat} renderText={renderText} />;
}
