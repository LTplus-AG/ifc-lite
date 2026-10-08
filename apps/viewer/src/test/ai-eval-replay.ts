/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Recorded-response replay (#6928). A recording is one provider response as
 * SSE events, captured live by `scripts/ai-eval/run-live-eval.mjs` or authored
 * for a refusal case. Replay seeds the recording's real-model scene, serves
 * the events to the real Assistant request path (`sendAssistant`, request
 * service, SSE client) through a `fetch` stub, then classifies the completed
 * answer with the same typed-proposal parser the conversation renders. This
 * tests IFClite behaviour on a fixed answer, never model quality.
 *
 * Format: `tests/ai-eval/recordings/*.json`, validated by
 * `scripts/ai-eval/lib/recording.mjs` (the Node side reads the same files).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { useAssistant, replaceEvidence } from '@/lib/assistant/conversation';
import { sendAssistant } from '@/lib/assistant/request';
import type { EvidenceSnapshot } from '@/lib/assistant/evidence';
import { clearApiKeys, updateApiKeys } from '@/services/api-keys';
import { useRequestReceipts, type UsageReceipt } from '@/lib/llm/request-receipts';
import { proposalOf } from '@/components/viewer/assistant/AssistantConversation';
import { isAiEvalScene, seedScene, type AiEvalScene } from './ai-eval-scenes';

export type ProposalKind = 'clash.groups' | 'flow.patch' | 'model.changes' | 'model.authoring';
export interface Recording {
  version: 1;
  id: string;
  task: string;
  scene: AiEvalScene;
  corpus: 'release' | 'negative';
  prompt: string;
  route: { kind: 'proxy' | 'anthropic' | 'openai'; model: string };
  provenance: { kind: 'authored' | 'live'; recordedAt: string; note: string };
  response: { status: number; events?: unknown[]; done?: boolean; body?: string };
  evidence: Record<string, unknown>;
  expect: { outcome: 'completed' | 'truncated' | 'error'; error?: string; proposal: null | { kind: ProposalKind; valid: boolean; reason?: string };
    violations: string[]; review?: Record<string, unknown>;
    /** Provider-reported usage the request receipt must carry; `reported: false` means the stream had none and nothing is estimated. */
    usage?: { reported: boolean; inputTokens?: number; outputTokens?: number } };
}

export const RECORDINGS_DIR = new URL('../../../../tests/ai-eval/recordings/', import.meta.url);

export function loadRecordings(dir: URL = RECORDINGS_DIR): Recording[] {
  return readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => {
    const value = JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as Recording;
    if (value.version !== 1 || !isAiEvalScene(value.scene)) throw new Error(`${name}: not a version 1 recording with a known scene`);
    return value;
  });
}

/**
 * SSE wire text for the recorded events, exactly as a provider or the proxy
 * streams it. Anthropic frames carry an `event:` line naming their type, which
 * the official SDK requires.
 */
export function sseBody(response: Recording['response'], route: Recording['route']['kind'] = 'proxy'): string {
  if (response.body !== undefined) return response.body;
  const frame = (event: unknown) => {
    const type = route === 'anthropic' ? (event as { type?: unknown }).type : undefined;
    return `${typeof type === 'string' ? `event: ${type}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
  };
  return (response.events ?? []).map(frame).join('') + (response.done ? 'data: [DONE]\n\n' : '');
}

export interface ReplayResult {
  evidence: EvidenceSnapshot;
  /** What left the viewer: URL and JSON body of the single provider request. */
  sent: Array<{ url: string; body: Record<string, unknown> }>;
  completed: boolean;
  answer: string | null;
  error: string | null;
  proposal: ReturnType<typeof proposalOf>;
  /** The usage receipt the viewer recorded for the request (none when it never reached a provider). */
  receipt: UsageReceipt | null;
}

/** BYOK routes resolve only with a key present; replay uses an inert placeholder, never a real credential. */
const PLACEHOLDER_KEY = 'replay-placeholder-key';

export async function replayRecording(recording: Recording): Promise<ReplayResult | { missing: string }> {
  const scene = await seedScene(recording.scene);
  if (scene.kind === 'missing') return { missing: scene.message };
  replaceEvidence(scene.evidence);
  useRequestReceipts.setState({ receipts: [] });
  const sent: ReplayResult['sent'] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(sseBody(recording.response, recording.route.kind), { status: recording.response.status,
      headers: { 'Content-Type': recording.response.status === 200 ? 'text/event-stream' : 'application/json' } });
  }) as typeof fetch;
  if (recording.route.kind === 'anthropic') updateApiKeys({ anthropicKey: PLACEHOLDER_KEY });
  if (recording.route.kind === 'openai') updateApiKeys({ openaiKey: PLACEHOLDER_KEY });
  try {
    const completed = await sendAssistant(recording.prompt, recording.route.model, '/api/chat');
    const state = useAssistant.getState();
    const last = state.messages.at(-1);
    const answer = completed && last?.role === 'assistant' ? last.content : null;
    return { evidence: scene.evidence, sent, completed, answer, error: state.error, proposal: answer === null ? null : proposalOf(answer),
      receipt: useRequestReceipts.getState().receipts.at(-1) ?? null };
  } finally {
    globalThis.fetch = originalFetch;
    if (recording.route.kind !== 'proxy') clearApiKeys();
  }
}
