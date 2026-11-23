/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renders A2UI messages produced outside the chat (script output, agent-bridge
 * pushes). Untrusted until `validateIfcMessages` accepts them; a rejected
 * payload shows why instead of rendering part of it.
 */

import { useEffect, useMemo, useState } from 'react';
import { validateIfcMessages, type AgentToRendererMessage } from '@ifc-lite/a2ui/agent';
import { useTranslation } from '@/i18n';
import type { FollowUpHandler } from '@/lib/a2ui/actions';
import { A2uiMessageSession } from '@/lib/a2ui/session';
import { Note } from './notes';
import { SegmentsView, useViewerHost } from './SegmentsView';

export interface A2uiMessagesViewProps {
  messages: AgentToRendererMessage[];
  onFollowUp?: FollowUpHandler;
}

const noText = (_text: string, _codeStart: number, key: string) => ({ node: <span key={key} />, codeCount: 0 });

export default function A2uiMessagesView({ messages, onFollowUp }: A2uiMessagesViewProps) {
  const { t } = useTranslation();
  const host = useViewerHost();
  const problems = useMemo(() => validateIfcMessages(messages), [messages]);
  // Built in an effect so each replayed processor is disposed when the payload changes or the view unmounts.
  const [session, setSession] = useState<A2uiMessageSession | null>(null);
  useEffect(() => {
    if (!host || problems.length > 0) {
      setSession(null);
      return;
    }
    const replayed = A2uiMessageSession.replay(host, { v: 1, segments: [{ messages }] }, '', true);
    setSession(replayed);
    return () => replayed.dispose();
  }, [host, problems, messages]);
  if (problems.length > 0) {
    return <Note tone="warn"><div className="font-medium">{t('a2ui.error.title')}</div>{problems.join(' ')}</Note>;
  }
  if (!host || !session) return null;
  return <SegmentsView session={session} host={host} onFollowUp={onFollowUp} renderText={noText} />;
}
