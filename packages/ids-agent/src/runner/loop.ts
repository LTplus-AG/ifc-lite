/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The agent loop (`06-ai-agent.md` §4, ADR-008).
 *
 * request → model turn → tool calls → results → next turn, until one of:
 * the model ends its turn, the root budget is exhausted, the same failure
 * signature comes back twice in a row (no progress), the caller cancels, a
 * request times out, the wall-clock cap passes, the model refuses, or it is
 * cut off without a usable answer.
 *
 * Every turn goes through `runToolTurn` from `@ifc-lite/ai` (budget,
 * deadline, cancel, receipt). Tools run one at a time, in the order the model
 * called them, against the sandbox; their results go back in one message.
 * Whatever the stop reason, the run returns the proposal built so far.
 */

import { createRootBudget, runToolTurn, type ContentBlock, type RootBudget, type ToolResult, type ToolTurnMessage, type ToolTurnTransport, type UsageReceipt } from '@ifc-lite/ai';
import { uuidv7, type GateContext, type LintContext, type StudioDocument, type Uuid } from '@ifc-lite/ids-authoring';
import { firstChoice, type AskUserHandler, type BsddClient, type FunnelCounts, type ModelBridge } from '../bridges.js';
import { MODES } from '../modes.js';
import { SYSTEM_PROMPT_VERSION, systemPrompt, type AgentMode } from '../prompts/system-v1.js';
import type { AgentRunStatus, AskedQuestion, Proposal } from '../proposal/proposal.js';
import { brief, createSandbox, type Sandbox } from '../sandbox/sandbox.js';
import { registryFor } from '../tools/index.js';
import { buildContext, joinContext, type Attachment } from './context.js';
import type { SentRequest } from './privacy.js';
import { costOf, sha256Hex, totalsOf, type ModelPricing, type RunReceipt, type ToolCallRecord } from './receipt.js';

/** The model the agent uses unless the host chooses another (D3: the viewer assistant's default). */
export const DEFAULT_AGENT_MODEL = 'claude-opus-5-5';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'request'; index: number }
  | { type: 'receipt'; receipt: UsageReceipt }
  | { type: 'tool-call'; callId: string; name: string }
  | { type: 'tool-result'; callId: string; name: string; ok: boolean; summary: string }
  | { type: 'stopped'; status: AgentRunStatus; message?: string };

export interface AgentRunOptions {
  transport: ToolTurnTransport;
  /** Default `DEFAULT_AGENT_MODEL`. */
  model?: string;
  /** Recorded on receipts, e.g. `anthropic`, `openai`, `replay`. */
  route?: string;
  mode: AgentMode;
  request: string;
  attachments?: readonly Attachment[];
  doc: StudioDocument;
  gate: GateContext;
  lint: LintContext;
  modelBridge?: ModelBridge;
  bsdd?: BsddClient;
  /** Default: the first choice (headless, non-interactive). */
  askUser?: AskUserHandler;
  /** Default: the mode's root budget. Pass a restored budget to resume spending from it. */
  budget?: RootBudget;
  limits?: {
    /** Whole-run cap. Default 10 minutes. */
    wallClockMs?: number;
    /** Per-request deadline. Default 5 minutes. */
    requestTimeoutMs?: number;
    /** The route's hard output ceiling. Default 64k. */
    routeCeiling?: number;
    /** Tool results longer than this are cut (with a note). Default 16k characters. */
    maxResultChars?: number;
  };
  pricing?: ModelPricing;
  signal?: AbortSignal;
  runId?: Uuid;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentRun {
  runId: Uuid;
  status: AgentRunStatus;
  message?: string;
  proposal: Proposal;
  /** Every message of the conversation, in order (requests sent prefixes of it). */
  transcript: ToolTurnMessage[];
  /** What each request carried, for the privacy view. */
  sent: SentRequest[];
}

function serialise(data: unknown, max: number): string {
  const text = JSON.stringify(data);
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated: ${text.length - max} more characters; narrow the request]`;
}

async function previewsFor(sandbox: Sandbox, bridge: ModelBridge | undefined, signal: AbortSignal): Promise<Record<Uuid, FunnelCounts>> {
  const previews: Record<Uuid, FunnelCounts> = {};
  if (!bridge || signal.aborted) return previews;
  const touched = [...new Set(sandbox.batches.flatMap((b) => b.specIds))].slice(0, 20);
  for (const specId of touched) {
    const index = sandbox.doc.nodes.specs.findIndex((s) => s.id === specId);
    if (index < 0) continue;
    const spec = sandbox.doc.ids.specifications[index];
    previews[specId] = await bridge.count({
      applicability: spec.applicability.facets, requirements: spec.requirements.map((r) => r.facet), ifcVersions: spec.ifcVersions,
    }, signal);
  }
  return previews;
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRun> {
  const mode = MODES[options.mode];
  const model = options.model ?? DEFAULT_AGENT_MODEL;
  const route = options.route ?? 'agent';
  const runId = options.runId ?? uuidv7();
  const limits = { wallClockMs: 600_000, requestTimeoutMs: 300_000, routeCeiling: 64_000, maxResultChars: 16_000, ...options.limits };
  const emit = options.onEvent ?? (() => undefined);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });

  const sandbox = createSandbox({ doc: options.doc, gate: options.gate, lint: options.lint, runId, model, ...(mode.opGuard ? { opGuard: mode.opGuard } : {}) });
  const registry = registryFor(mode, { model: Boolean(options.modelBridge), bsdd: Boolean(options.bsdd) });
  const tools = registry.specs();
  const system = systemPrompt(options.mode);
  const contextParts = buildContext(options.doc, options.attachments ?? []);
  const context = joinContext(contextParts);
  const budget = options.budget ?? createRootBudget(mode.budget);
  const questions: AskedQuestion[] = [];
  const askUser = options.askUser ?? firstChoice;
  const recordingAskUser: AskUserHandler = async (question, signal) => {
    const picked = await askUser(question, signal);
    questions.push({ id: question.id, question: question.question, choices: question.choices.map((c) => c.label), picked });
    return picked;
  };

  const transcript: ToolTurnMessage[] = [{ role: 'user', content: options.request }];
  const sent: SentRequest[] = [];
  const receipts: UsageReceipt[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const startedAt = Date.now();
  let status: AgentRunStatus = 'completed';
  let message: string | undefined;
  let finalText = '';
  let lastSignature = '';

  try {
    if (mode.needsModel && !options.modelBridge) {
      status = 'error';
      message = `${options.mode} mode needs a loaded model.`;
    }
    while (status === 'completed') {
      if (controller.signal.aborted) { status = 'cancelled'; break; }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= limits.wallClockMs) { status = 'wall-clock'; break; }
      const index = sent.length;
      sent.push({ index, at: Date.now(), model, route, promptVersion: SYSTEM_PROMPT_VERSION, system, context: contextParts,
        messageCount: transcript.length, toolNames: tools.map((t) => t.name) });
      emit({ type: 'request', index });
      const outcome = await runToolTurn({
        model, route, transport: options.transport, system, context, messages: [...transcript], tools,
        effort: mode.effort, taskBudget: mode.taskBudget, maxOutputTokens: mode.maxOutputTokens, routeCeiling: limits.routeCeiling,
        budget, signal: controller.signal, timeoutMs: Math.min(limits.requestTimeoutMs, limits.wallClockMs - elapsed),
        onText: (delta) => emit({ type: 'text', delta }), onThinking: (delta) => emit({ type: 'thinking', delta }),
      }, { onReceipt: (receipt) => { receipts.push(receipt); emit({ type: 'receipt', receipt }); } });
      if (outcome.kind === 'refused') { sent.pop(); status = 'budget-exhausted'; break; }
      if (outcome.kind === 'cancelled') { status = 'cancelled'; break; }
      if (outcome.kind === 'timeout') { status = 'timeout'; break; }
      if (outcome.kind === 'error') { status = 'error'; message = outcome.message; break; }

      const { turn } = outcome;
      transcript.push({ role: 'assistant', content: turn.content });
      const text = turn.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');
      if (text.trim()) finalText = text;
      if (turn.stopReason === 'refusal') {
        status = 'refused';
        message = turn.refusal?.explanation ?? turn.refusal?.category ?? undefined;
        break;
      }
      if (turn.stopReason === 'pause_turn') continue;
      const calls = turn.content.filter((b): b is Extract<ContentBlock, { type: 'tool_call' }> => b.type === 'tool_call');
      if (calls.length === 0) {
        if (turn.stopReason === 'max_tokens') status = 'truncated';
        break;
      }

      const results: ToolResult[] = [];
      const signature: string[] = [];
      for (const call of calls) {
        emit({ type: 'tool-call', callId: call.id, name: call.name });
        const started = Date.now();
        // A call cut off at the output ceiling may parse as a silently shortened object: never run it.
        const result = turn.stopReason === 'max_tokens'
          ? { ok: false, summary: `${call.name}: cut off`, data: { ok: false, error: 'Your output was cut off before this call was complete; it was not run. Send a smaller batch.' }, signature: [`TRUNCATED:${call.name}`] }
          : await registry.call(call.name, call.input, call.rawInput, {
            sandbox, gate: options.gate, askUser: recordingAskUser, signal: controller.signal, callId: call.id,
            ...(options.modelBridge ? { model: options.modelBridge } : {}), ...(options.bsdd ? { bsdd: options.bsdd } : {}),
          });
        toolCalls.push({ turn: index, name: call.name, ok: result.ok, summary: result.summary, ms: Date.now() - started });
        emit({ type: 'tool-result', callId: call.id, name: call.name, ok: result.ok, summary: result.summary });
        results.push({ callId: call.id, content: serialise(result.data, limits.maxResultChars), isError: !result.ok });
        signature.push(...(result.signature ?? []));
      }
      transcript.push({ role: 'tool', results });
      const key = [...new Set(signature)].sort().join('|');
      if (key && key === lastSignature) {
        status = 'no-progress';
        message = `The same problems came back twice: ${[...new Set(signature)].slice(0, 5).join(', ')}`;
        break;
      }
      lastSignature = key;
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }

  const previews = status === 'completed' ? await previewsFor(sandbox, options.modelBridge, controller.signal) : {};
  const totals = totalsOf(receipts);
  const receipt: RunReceipt = {
    runId, mode: options.mode, model, promptVersion: SYSTEM_PROMPT_VERSION, requests: receipts, toolCalls, totals,
    ...(options.pricing ? { costUsd: costOf(totals, options.pricing) } : {}),
    payloadDigest: await sha256Hex(JSON.stringify(sent.map((s) => ({ ...s, messages: transcript.slice(0, s.messageCount) })))),
  };
  emit({ type: 'stopped', status, ...(message ? { message } : {}) });
  return {
    runId, status, ...(message ? { message } : {}), transcript, sent,
    proposal: {
      runId, mode: options.mode, model, promptVersion: SYSTEM_PROMPT_VERSION, status, summary: finalText,
      base: { docId: options.doc.docId, specs: options.doc.nodes.specs.map((s, i) => ({ specId: s.id, name: options.doc.ids.specifications[i].name })) },
      batches: [...sandbox.batches], unresolved: [...sandbox.unresolved], questions,
      diagnostics: sandbox.diagnostics().filter((d) => d.severity !== 'info').map(brief),
      draft: sandbox.doc, previews, receipt,
    },
  };
}
