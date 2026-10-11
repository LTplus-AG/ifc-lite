/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anthropic Messages adapter for the tool-turn contract of `@ifc-lite/ai`
 * (`06-ai-agent.md` §3). The host constructs the SDK client (BYOK key in the
 * browser, env or profile in Node) and passes it in; this module never sees a
 * credential.
 *
 * Request shape, per the Claude-first configuration:
 * - streaming (`beta.messages.stream`), text and thinking deltas forwarded;
 * - adaptive thinking with summarized display, `output_config.effort` per mode;
 * - client tools with `strict` where the schema allows it and
 *   `eager_input_streaming` on every tool (inputs are re-validated by the
 *   registry before any tool runs, and a turn cut at `max_tokens` is never run);
 * - prompt caching: a breakpoint after the frozen system prompt (tools render
 *   before it), plus automatic caching of the growing conversation; the run's
 *   context block comes after both;
 * - `output_config.task_budget` (beta `task-budgets-2026-03-13`);
 * - server-side refusal fallbacks (`fallbacks: "default"`, beta
 *   `server-side-fallback-2026-07-01`) on the Claude API; turn off for other
 *   platforms or a proxy that rejects them.
 *
 * Thinking and other provider blocks are returned as opaque blocks and sent
 * back unchanged, so the conversation stays append-only.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { anthropicUsage, type ContentBlock, type ToolTurn, type ToolTurnCall, type ToolTurnMessage, type ToolTurnStopReason, type ToolTurnTransport } from '@ifc-lite/ai';

export interface AnthropicAdapterOptions {
  /** Server-side refusal fallbacks (Claude API only). Default true. */
  fallbacks?: boolean;
  /** Send the task budget beta. Default true. */
  taskBudgets?: boolean;
  /** `eager_input_streaming` on client tools. Turn off behind a proxy that rejects the field. Default true. */
  eagerInputStreaming?: boolean;
  /** Thinking display. Default `summarized` (shown in a collapsible reasoning strip). */
  thinkingDisplay?: 'summarized' | 'omitted';
}

/** The part of the SDK client the adapter uses. */
export type AnthropicMessagesClient = Pick<Anthropic, 'beta'>;

const PROVIDER = 'anthropic';
const TASK_BUDGET_MIN = 20_000;

function assistantBlocks(content: readonly ContentBlock[]): BetaContentBlockParam[] {
  const out: BetaContentBlockParam[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) out.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_call') {
      out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} });
    } else if (block.provider === PROVIDER) {
      // Sent back exactly as the API returned it (thinking signatures must not change).
      out.push(block.value as BetaContentBlockParam);
    }
  }
  return out;
}

export function toAnthropicMessages(messages: readonly ToolTurnMessage[], context: string | undefined): BetaMessageParam[] {
  return messages.map((m, i): BetaMessageParam => {
    if (m.role === 'user') {
      const text: BetaContentBlockParam[] = [];
      if (i === 0 && context) text.push({ type: 'text', text: context });
      text.push({ type: 'text', text: m.content });
      return { role: 'user', content: text };
    }
    if (m.role === 'assistant') return { role: 'assistant', content: assistantBlocks(m.content) };
    return {
      role: 'user',
      content: m.results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.callId, content: r.content, is_error: r.isError })),
    };
  });
}

export function toAnthropicTools(call: Pick<ToolTurnCall, 'tools'>, eager: boolean): BetaToolUnion[] {
  return call.tools.map((t) => ({
    name: t.name,
    description: t.description,
    // `inputSchema` is a JSON Schema object with `type: 'object'` (the registry builds it).
    input_schema: { type: 'object', ...t.inputSchema },
    ...(t.strict ? { strict: true } : {}),
    ...(eager ? { eager_input_streaming: true } : {}),
  }));
}

export function buildAnthropicParams(call: ToolTurnCall, options: AnthropicAdapterOptions = {}): BetaMessageStreamParams {
  const betas: string[] = [];
  const taskBudget = options.taskBudgets !== false && call.taskBudget !== undefined ? Math.max(TASK_BUDGET_MIN, call.taskBudget) : undefined;
  if (taskBudget !== undefined) betas.push('task-budgets-2026-03-13');
  if (options.fallbacks !== false) betas.push('server-side-fallback-2026-07-01');
  return {
    model: call.model,
    max_tokens: call.maxOutputTokens,
    system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
    messages: toAnthropicMessages(call.messages, call.context),
    tools: toAnthropicTools(call, options.eagerInputStreaming !== false),
    tool_choice: { type: 'auto' },
    thinking: { type: 'adaptive', display: options.thinkingDisplay ?? 'summarized' },
    cache_control: { type: 'ephemeral' },
    output_config: {
      ...(call.effort ? { effort: call.effort } : {}),
      ...(taskBudget !== undefined ? { task_budget: { type: 'tokens', total: taskBudget } } : {}),
    },
    ...(options.fallbacks !== false ? { fallbacks: 'default' as const } : {}),
    ...(betas.length ? { betas } : {}),
  };
}

const STOP: Readonly<Record<string, ToolTurnStopReason>> = {
  end_turn: 'end_turn', stop_sequence: 'end_turn', tool_use: 'tool_use', max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens', pause_turn: 'pause_turn', refusal: 'refusal',
};

function fromBlock(block: BetaContentBlock): ContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'tool_use') return { type: 'tool_call', id: block.id, name: block.name, input: block.input };
  return { type: 'opaque', provider: PROVIDER, value: block };
}

export function fromAnthropicMessage(message: BetaMessage): ToolTurn {
  const details = message.stop_details;
  return {
    content: message.content.map(fromBlock),
    stopReason: (message.stop_reason && STOP[message.stop_reason]) || 'other',
    usage: anthropicUsage(message.usage),
    servedModel: message.model,
    ...(message.stop_reason === 'refusal' && details
      ? { refusal: { category: details.category ?? null, explanation: details.explanation ?? null } }
      : {}),
  };
}

/** A tool-turn transport over an Anthropic SDK client. */
export function anthropicTransport(client: AnthropicMessagesClient, options: AnthropicAdapterOptions = {}): ToolTurnTransport {
  return async (call) => {
    const stream = client.beta.messages.stream(buildAnthropicParams(call, options), { signal: call.signal });
    stream.on('text', (delta) => call.onText(delta));
    stream.on('thinking', (delta) => call.onThinking(delta));
    return fromAnthropicMessage(await stream.finalMessage());
  };
}
