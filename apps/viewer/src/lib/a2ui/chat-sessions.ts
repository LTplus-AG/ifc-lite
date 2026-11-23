/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sessions keyed by chat message id, kept outside React so a surface keeps its
 * state (sort order, applied colours) across re-renders. The chat renders the
 * reply in flight as a message with id `streaming`; when that turn is
 * finalised under its real id with the same text, the final message adopts the
 * streaming session instead of building the surfaces again.
 */

import type { PersistedA2ui } from '@/lib/llm/types';
import { MAX_MESSAGES } from '@/store/slices/chatPersistence';
import type { A2uiViewerHost } from './host.js';
import { A2uiMessageSession } from './session.js';

export const STREAMING_MESSAGE_ID = 'streaming';
// One per message the chat keeps, plus the reply in flight: a retained message never loses its live surface.
const MAX_SESSIONS = MAX_MESSAGES + 1;

const sessions = new Map<string, A2uiMessageSession>();

function remember(id: string, session: A2uiMessageSession): void {
  sessions.delete(id);
  sessions.set(id, session);
  while (sessions.size > MAX_SESSIONS) {
    const [oldestId, oldest] = sessions.entries().next().value as [string, A2uiMessageSession];
    sessions.delete(oldestId);
    oldest.dispose();
  }
}

export interface SessionMessage {
  id: string;
  content: string;
  a2ui?: PersistedA2ui;
}

/**
 * The session for a message, created on first use: replayed from its record
 * when it has one, adopted from the streaming session when the text matches,
 * otherwise new (and fed by {@link syncSession}).
 */
export function sessionFor(message: SessionMessage, host: A2uiViewerHost): A2uiMessageSession {
  const existing = sessions.get(message.id);
  if (existing) return existing;
  let session: A2uiMessageSession;
  const streaming = sessions.get(STREAMING_MESSAGE_ID);
  if (message.a2ui) {
    session = A2uiMessageSession.replay(host, message.a2ui, message.content);
  } else if (message.id !== STREAMING_MESSAGE_ID && streaming && streaming.content === message.content) {
    sessions.delete(STREAMING_MESSAGE_ID);
    session = streaming;
  } else {
    session = new A2uiMessageSession(host);
  }
  remember(message.id, session);
  return session;
}

/**
 * Bring a session up to the message text. Returns the session to use: a new
 * one when the text no longer extends what was fed (a new turn reusing the
 * streaming id, or an edited reply).
 */
export function syncSession(message: SessionMessage, host: A2uiViewerHost, streaming: boolean): A2uiMessageSession {
  let session = sessionFor(message, host);
  if (!session.feed(message.content)) {
    sessions.delete(message.id);
    session.dispose();
    session = sessionFor({ id: message.id, content: message.content }, host);
    session.feed(message.content);
  }
  if (!streaming) session.close();
  return session;
}

/** Test seam: forget every session. */
export function resetChatSessions(): void {
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
}
