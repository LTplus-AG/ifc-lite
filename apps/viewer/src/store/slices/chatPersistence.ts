/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Chat history persistence: what the chat slice writes to localStorage and
 * how a stored message is validated on the way back in.
 */

import type { ChatMessage, CodeExecResult, FileAttachment, PersistedA2ui } from '../../lib/llm/types.js';

const MESSAGES_STORAGE_KEY = 'ifc-lite-chat-messages';
export const MAX_MESSAGES = 200;

export function getMessagesStorageKey(userId: string | null): string {
  return userId ? `${MESSAGES_STORAGE_KEY}:${userId}` : `${MESSAGES_STORAGE_KEY}:anonymous`;
}

/** Load persisted messages from localStorage. */
export function loadStoredMessages(userId: string | null): ChatMessage[] {
  try {
    const raw = localStorage.getItem(getMessagesStorageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    return trimChatMessages(parsed.flatMap(deserializeStoredMessage));
  } catch {
    return [];
  }
}

/** One-shot latch for the persist-failure warning (see persistMessages). */
let persistWarned = false;

/** Reset the persist-failure latch. Test-only seam. */
export function __resetChatPersistWarningForTests(): void {
  persistWarned = false;
}

/** Persist messages to localStorage. */
export function persistMessages(messages: ChatMessage[], userId: string | null) {
  try {
    // Only keep last 50 messages in storage to avoid quota issues
    const toStore = trimChatMessages(messages).slice(-50).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      codeBlocks: m.codeBlocks,
      attachments: m.attachments,
      // Serialize Map as array of entries
      // Script surfaces (up to 256 KiB a run) stay in memory: storing them would fill the quota and lose the history.
      execResults: m.execResults ? Array.from(m.execResults.entries(), ([i, r]) => [i, withoutSurfaces(r)]) : undefined,
      a2ui: m.a2ui,
    }));
    localStorage.setItem(getMessagesStorageKey(userId), JSON.stringify(toStore));
  } catch (err) {
    // Non-fatal: the in-memory conversation is unaffected, but nothing will
    // survive a reload. Latched to once per session — this runs on EVERY
    // message add / exec-result update, so an unlatched log would flood the
    // console for the whole session once the quota is full.
    if (!persistWarned) {
      persistWarned = true;
      console.warn(
        '[chat] Could not persist chat history to localStorage (quota exceeded or storage blocked); '
        + 'this conversation will not survive a reload. Further failures are not logged.',
        err,
      );
    }
  }
}

export function trimChatMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_MESSAGES) return messages;
  return messages.slice(-MAX_MESSAGES);
}

function deserializeStoredMessage(value: Record<string, unknown>): ChatMessage[] {
  const id = typeof value.id === 'string' ? value.id : null;
  const role = value.role;
  const content = typeof value.content === 'string' ? value.content : null;
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : null;
  if (!id || content === null || createdAt === null || !isValidRole(role)) {
    return [];
  }
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.filter(isValidAttachment)
    : undefined;
  const execResults = Array.isArray(value.execResults)
    ? new Map((value.execResults as Array<[number, CodeExecResult]>).filter(
      (entry): entry is [number, CodeExecResult] => Array.isArray(entry) && typeof entry[0] === 'number',
    ))
    : undefined;
  return [{
    id,
    role,
    content,
    createdAt,
    codeBlocks: value.codeBlocks as ChatMessage['codeBlocks'],
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
    execResults,
    a2ui: isPersistedA2ui(value.a2ui) ? value.a2ui : undefined,
  }];
}

function isPersistedA2ui(value: unknown): value is PersistedA2ui {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.v === 1 && Array.isArray(record.segments) && record.segments.every((seg: unknown) => {
    if (!seg || typeof seg !== 'object') return false;
    const s = seg as Record<string, unknown>;
    return typeof s.text === 'string' || typeof s.error === 'string' || Array.isArray(s.messages);
  });
}

function isValidRole(value: unknown): value is ChatMessage['role'] {
  return value === 'user' || value === 'assistant' || value === 'system';
}

function isValidAttachment(value: unknown): value is FileAttachment {
  if (!value || typeof value !== 'object') return false;
  const attachment = value as Record<string, unknown>;
  return typeof attachment.id === 'string'
    && typeof attachment.name === 'string'
    && typeof attachment.type === 'string'
    && typeof attachment.size === 'number';
}

function withoutSurfaces(result: CodeExecResult): CodeExecResult {
  const { surfaces: _surfaces, ...rest } = result;
  return rest;
}
