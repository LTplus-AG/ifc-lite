/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Request capture for the live evaluation (#6928). Seeds a task's real-model
 * scene and records the exact request the Assistant would send through a
 * `fetch` stub, so `scripts/ai-eval/run-live-eval.mjs` re-sends the production
 * system prompt and frozen evidence. No network.
 */

import { replaceEvidence } from '@/lib/assistant/conversation';
import { sendAssistant } from '@/lib/assistant/request';
import { clearApiKeys, getApiKeys, updateApiKeys } from '@/services/api-keys';
import { comparableEvidence, isAiEvalScene, seedScene } from './ai-eval-scenes';

export interface CaptureTask { id: string; scene: string; prompt: string }
export interface NeutralRequest {
  system: string;
  messages: unknown[];
  maxOutputTokens: number;
  /** Whether the Assistant sent a temperature: current frontier models reject one with a 400. */
  acceptsTemperature: boolean;
}
export type CapturedTask =
  | { taskId: string; skipped: string }
  | { taskId: string; scene: string; evidence: Record<string, unknown>; request: NeutralRequest };

/** Proxy and Anthropic system prompts may be cache-marked blocks; the runner needs the plain text. */
function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map(block => (block as { text?: unknown }).text).filter(text => typeof text === 'string').join('');
  throw new Error('Captured request has no system prompt');
}

/**
 * The route-neutral request the runner re-sends, from whichever wire body the
 * Assistant built: proxy (`maxOutputTokens`), Anthropic (`max_tokens`),
 * OpenAI Chat Completions (`max_completion_tokens`, leading system message) or
 * OpenAI Responses (`max_output_tokens`, `input` with a leading developer entry).
 */
function neutralRequest(body: Record<string, unknown>): NeutralRequest {
  const messages = (body.messages ?? body.input) as Array<{ role: string; content: unknown }>;
  if (!Array.isArray(messages)) throw new Error('Captured request has no messages or input');
  const leading = messages[0]?.role === 'system' || messages[0]?.role === 'developer' ? messages[0] : undefined;
  const maxOutputTokens = body.maxOutputTokens ?? body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
  if (typeof maxOutputTokens !== 'number') throw new Error('Captured request has no output ceiling');
  return { system: systemText(body.system ?? leading?.content), messages: leading ? messages.slice(1) : messages, maxOutputTokens,
    acceptsTemperature: body.temperature !== undefined };
}

export async function captureRequest(task: CaptureTask, model: string): Promise<CapturedTask> {
  if (!isAiEvalScene(task.scene)) throw new Error(`${task.id}: unknown scene ${task.scene}`);
  const scene = await seedScene(task.scene);
  if (scene.kind === 'missing') return { taskId: task.id, skipped: scene.message };
  replaceEvidence(scene.evidence);
  let body: Record<string, unknown> | null = null;
  const originalFetch = globalThis.fetch;
  const stored = getApiKeys();
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('data: {"choices":[{"delta":{"content":"captured"},"finish_reason":"stop"}]}\n\n');
    }) as typeof fetch;
    // A BYOK model routes direct only with a stored key. The stub answers every
    // request, so this placeholder never leaves the process.
    updateApiKeys({ anthropicKey: 'capture-only', openaiKey: 'capture-only' });
    await sendAssistant(task.prompt, model, '/api/chat');
  } finally {
    globalThis.fetch = originalFetch;
    if (Object.values(stored).some(Boolean)) updateApiKeys(stored); else clearApiKeys();
  }
  const captured = body as Record<string, unknown> | null;
  if (!captured) throw new Error(`${task.id}: the Assistant refused to send (check prompt and scene)`);
  return { taskId: task.id, scene: task.scene, evidence: comparableEvidence(scene.evidence), request: neutralRequest(captured) };
}
