/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "What was sent" (FR-F08, IDS-086): the exact payload of every request of a
 * run, as view data a UI renders without interpretation.
 *
 * The loop records, before each request, the system prompt, the context
 * block, the tools offered and how many conversation messages went with it.
 * The conversation is append-only, so request N sent messages
 * `transcript[0..count)`; the view shows each request's NEW messages and
 * states that earlier ones were resent. Tool results are attributed to the
 * tool that produced them, so the view can say plainly whether any data from
 * the loaded models left the browser.
 */

import type { ContentBlock, ToolTurnMessage } from '@ifc-lite/ai';

export interface SentRequest {
  index: number;
  /** Epoch ms. */
  at: number;
  model: string;
  route: string;
  promptVersion: string;
  system: string;
  /** The context block, by part (document summary, each attachment), joined in order when sent. */
  context: readonly ContextPart[];
  /** Messages of the transcript sent with this request (a prefix of it). */
  messageCount: number;
  toolNames: string[];
}

export interface ContextPart {
  source: 'document' | 'attachments' | 'model-data';
  label: string;
  text: string;
}

export type PrivacySource = 'instructions' | 'document' | 'request' | 'attachments' | 'model-data' | 'schema' | 'bsdd' | 'assistant' | 'other';

export interface PrivacyEntry {
  source: PrivacySource;
  label: string;
  chars: number;
  /** The exact text that was sent. */
  text: string;
}

export interface PrivacyRequestView {
  index: number;
  at: number;
  model: string;
  route: string;
  promptVersion: string;
  /** Entries sent for the first time with this request. */
  entries: PrivacyEntry[];
  /** Messages resent from earlier requests (the API is stateless). */
  resentMessages: number;
  toolNames: string[];
}

export interface PrivacyView {
  requests: PrivacyRequestView[];
  /** Characters sent per source, counting each piece once. */
  totals: Record<PrivacySource, number>;
  /** True when any model-tool result (counts, values, class statistics) was sent. */
  modelDataSent: boolean;
  payloadDigest: string;
}

function sourceOfTool(name: string | undefined): PrivacySource {
  if (!name) return 'other';
  if (name.startsWith('model_')) return 'model-data';
  if (name.startsWith('schema_')) return 'schema';
  if (name.startsWith('bsdd_')) return 'bsdd';
  if (name.startsWith('ids_')) return 'document';
  return 'other';
}

function blockText(block: ContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'tool_call') return `${block.name}(${block.rawInput ?? JSON.stringify(block.input)})`;
  return `[${block.provider} block sent back unchanged]`;
}

function entriesOf(message: ToolTurnMessage, toolNames: ReadonlyMap<string, string>, first: boolean): PrivacyEntry[] {
  if (message.role === 'user') {
    return [{ source: 'request', label: first ? 'Your request' : 'Message', chars: message.content.length, text: message.content }];
  }
  if (message.role === 'assistant') {
    const text = message.content.map(blockText).join('\n');
    return [{ source: 'assistant', label: 'Earlier model output (sent back)', chars: text.length, text }];
  }
  return message.results.map((r) => {
    const name = toolNames.get(r.callId);
    return { source: sourceOfTool(name), label: `Result of ${name ?? 'a tool'}${r.isError ? ' (error)' : ''}`, chars: r.content.length, text: r.content };
  });
}

/** Build the privacy view of a run from what the loop recorded. */
export function privacyView(run: { sent: readonly SentRequest[]; transcript: readonly ToolTurnMessage[]; proposal: { receipt: { payloadDigest: string } } }): PrivacyView {
  const toolNames = new Map<string, string>();
  for (const m of run.transcript) {
    if (m.role === 'assistant') for (const b of m.content) if (b.type === 'tool_call') toolNames.set(b.id, b.name);
  }
  const totals: Record<PrivacySource, number> = {
    instructions: 0, document: 0, request: 0, attachments: 0, 'model-data': 0, schema: 0, bsdd: 0, assistant: 0, other: 0,
  };
  let previous: SentRequest | null = null;
  const requests = run.sent.map((sent) => {
    const entries: PrivacyEntry[] = [];
    if (!previous || previous.system !== sent.system) {
      entries.push({ source: 'instructions', label: `System prompt (${sent.promptVersion})`, chars: sent.system.length, text: sent.system });
    }
    if (!previous || previous.context !== sent.context) {
      for (const part of sent.context) entries.push({ source: part.source, label: part.label, chars: part.text.length, text: part.text });
    }
    const from = previous?.messageCount ?? 0;
    run.transcript.slice(from, sent.messageCount).forEach((m, i) => entries.push(...entriesOf(m, toolNames, from + i === 0)));
    for (const e of entries) totals[e.source] += e.chars;
    const view: PrivacyRequestView = {
      index: sent.index, at: sent.at, model: sent.model, route: sent.route, promptVersion: sent.promptVersion,
      entries, resentMessages: from, toolNames: sent.toolNames,
    };
    previous = sent;
    return view;
  });
  return { requests, totals, modelDataSent: totals['model-data'] > 0, payloadDigest: run.proposal.receipt.payloadDigest };
}
