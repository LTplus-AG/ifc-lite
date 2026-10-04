/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ContentDefinition } from '../storage/content-migration';
import type { AssistantSource } from './evidence';
import { isAssistantSource } from './sources';

export interface AssistantMessage { role: 'user' | 'assistant'; content: string; model?: string }
export interface SavedConversation {
  version: 1;
  id: string;
  name: string;
  savedAt: string;
  model: string;
  evidence: { source: AssistantSource; capturedAt: string; payload: string; totalRows: number; includedRows: number; projectionTruncated: boolean };
  messages: AssistantMessage[];
}
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Exact portable shape: never revive runtime stores, credentials or freshness stamps. */
export function decodeConversation(value: unknown): SavedConversation | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || !string(item.id, 200) || !string(item.name, 200) || !string(item.model, 200)
    || !string(item.savedAt, 50) || !Number.isFinite(Date.parse(item.savedAt))
    || !item.evidence || typeof item.evidence !== 'object' || !Array.isArray(item.messages)
    || item.messages.length > 20 || item.messages.length % 2 !== 0) return null;
  const e = item.evidence as Record<string, unknown>;
  if (!isAssistantSource(e.source)
    || !string(e.capturedAt, 50) || !Number.isFinite(Date.parse(e.capturedAt)) || !string(e.payload, 48_000)
    || !count(e.totalRows) || !count(e.includedRows) || e.includedRows > e.totalRows
    || typeof e.projectionTruncated !== 'boolean') return null;
  let payload: unknown;
  try { payload = JSON.parse(e.payload); }
  catch (error) { console.debug('[Assistant] Invalid saved evidence JSON', error); return null; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (p.source !== e.source || p.capturedAt !== e.capturedAt || p.totalRows !== e.totalRows
    || p.includedRows !== e.includedRows || p.projectionTruncated !== e.projectionTruncated) return null;
  const messages: SavedConversation['messages'] = [];
  for (const [index, raw] of item.messages.entries()) {
    if (!raw || typeof raw !== 'object') return null;
    const m = raw as Record<string, unknown>;
    const role = index % 2 === 0 ? 'user' : 'assistant';
    if (m.role !== role || !string(m.content, role === 'user' ? 8000 : 32_000)
      || (role === 'assistant' && !string(m.model, 200)) || (role === 'user' && m.model !== undefined)) return null;
    messages.push({ role, content: m.content, ...(role === 'assistant' ? { model: m.model as string } : {}) });
  }
  if (JSON.stringify(messages).length + e.payload.length > 150_000) return null;
  return { version: 1, id: item.id, name: item.name, model: item.model, savedAt: item.savedAt,
    evidence: { source: e.source as AssistantSource, capturedAt: e.capturedAt, payload: e.payload,
      totalRows: e.totalRows, includedRows: e.includedRows, projectionTruncated: e.projectionTruncated }, messages };
}
export const assistantContent: ContentDefinition<SavedConversation> = {
  kind: 'assistant', legacyKey: 'ifc-lite-assistant-conversations-v1', decode: decodeConversation,
};
