/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { TranslationKey } from '@/i18n';
import { createAnthropicClient, type AnthropicCredentials } from '@/lib/llm/anthropic-client';
import { dispatch, type AnthropicToolDef, type DispatchContext, type LoadedPlaygroundModel, type ToolDispatchResult } from './playground-dispatcher';

const MAX_TOOL_CALLS = 25;
const MAX_TOKENS = 16_384; // Opus 5 thinks by default; 4096 truncated the tool loop. Under the SDK's non-streaming cap.
const SYSTEM_PROMPT = `You are a BIM/IFC analyst driving @ifc-lite/mcp tools against a pre-loaded model. Be terse — the user is technical and time-pressed.

Voice rules (strict):
- NO greetings, preambles, sign-offs, or apologies. Skip "Sure!", "Done!", "Here's…", "Let me know if…".
- NO emojis. Ever.
- NO unprompted follow-up menus ("Would you like to…?", "I can also…"). The user will ask if they want more.
- Aim for 1-3 short lines per reply unless the user asked for analysis.
- When a tool call already prints the result inline, your text reply can be empty or one short sentence at most.
- Markdown is fine for tables / data, but skip it for short confirmations.

Tool etiquette:
- Prefer tool calls over guessing — query_entities, get_entity, properties_unique, materials_list, geometry_volume/area, model_audit, bsdd_* are all available.
- MUTATION IS ALLOWED. The full read+write surface is wired here, not just read-only. When the user asks to set, change, add, delete, create, batch-edit, etc., go ahead — call entity_set_property, entity_set_attribute, entity_create, entity_delete, entity_delete_property, mutation_batch directly. Don't refuse, don't ask "are you sure?", don't suggest they "run this in the stdio MCP instead". Browser-local model, undo via mutation_undo, save via model_save.
- BCF authoring is also live: bcf_topic_create, bcf_topic_update, bcf_topic_close, bcf_viewpoint_create. The .bcf auto-stages after every BCF call — the user just clicks the pill.
- Clash detection: for a general "find/run clashes" request on the single loaded model, call clash_check with NO a/b (every element vs every other). clash_matrix is INTER-discipline only (MEP×structure, HVAC×arch, …) and returns nothing on a single-discipline or architectural model — use it ONLY when the user explicitly asks for the discipline matrix. To turn clashes into BCF, call clash_bcf_export (rich topics: framed viewpoint + clashing components + severity/distance metadata) — NOT bcf_topic_create. It stages its own .bcf pill, so don't call bcf_export after.
- The 3D viewer is INLINE on this page. When the user asks any 3D action (open, isolate, colorize, section, fly to, etc.), call viewer_open / viewer_* DIRECTLY. Do NOT call viewer_ask first. viewer_ask is only for when YOU are proactively suggesting the viewer.
- Quote real GlobalIds + values when you cite something. Don't paraphrase.

File attachments (IDS specs etc.):
- The user can drag-drop .ids files (or any text file) onto the chat. When they do, a system note appears in their message: "[Attached file: foo.ids …]". Use ids_validate / ids_explain with ids_path: "foo.ids" — the playground resolves the upload behind the scenes. Do NOT ask the user to paste raw XML.
- If the user mentions "this IDS" / "validate against the spec" but no attachment is in this turn, ask them to drop the .ids file onto the chat (don't ask for raw XML).

Downloads (very important):
- When a tool produces a file (bcf_export, model_save, export_ifc/csv/json, ids_validate), the playground UI automatically renders an inline "Get .bcf" / "Save IFC" / etc. button under that tool call. The user clicks it explicitly — files NEVER download automatically.
- Don't tell the user "the file is in the Downloads panel" or "click the download button" — the button is right there, redundant. Just confirm what was produced in 1 line.
- BCF auto-stages: every bcf_topic_* / bcf_viewpoint_create call already produces a fresh .bcf pill. DO NOT call bcf_export afterwards just to "create" the download — it's already there. Only call bcf_export if the user explicitly asks to re-export with custom settings.
- After mutations, if the user is wrapping up, suggest model_save ONCE so they can grab the edited IFC. Don't keep re-suggesting.`;

// ── message model ──────────────────────────────────────────────────────────

export interface ChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: ToolDispatchResult;
  startedAt: number;
  finishedAt?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  displayTextKey?: TranslationKey;
  toolCalls?: ChatToolCall[];
  /** True while we're still streaming + looping tool calls. */ pending?: boolean;
}

// ── conversation runner ───────────────────────────────────────────────────

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
type AnthropicAssistantBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface RunOpts {
  signal: AbortSignal;
  credentials: AnthropicCredentials;
  /** Anthropic model id (e.g. `claude-sonnet-4-6`, `claude-opus-4-7`). */
  modelId: string;
  tools: AnthropicToolDef[];
  history: ChatMessage[];
  model: LoadedPlaygroundModel;
  assistantId: string;
  getDispatchContext: () => DispatchContext;
  onUpdate: (patch: Partial<ChatMessage>) => void;
}

type ApiMessage =
  | { role: 'user'; content: string | Array<AnthropicToolResultBlock | { type: 'text'; text: string }> }
  | { role: 'assistant'; content: AnthropicAssistantBlock[] };

/**
 * Rebuild the Anthropic message list from React state.
 *
 * Anthropic's hard contract: every `tool_use` block in an assistant message
 * MUST be followed by a user message whose first blocks are matching
 * `tool_result`s. The naive shape (assistant turn → standalone user
 * tool_result message → standalone user text message) breaks that contract
 * the moment the user asks a follow-up after a tool round, because the
 * NEW user text lands AFTER the tool_result, separating it from the
 * tool_use by an extra turn (and yielding a double-user pair, which the
 * Messages API now merges into one turn rather than rejecting — the
 * tool_result-must-come-first ordering below is the part that still
 * matters, and the model-swap notice at #2471 deliberately relies on
 * consecutive user turns being accepted).
 *
 * Fix: merge an assistant turn's pending tool_results into the very next
 * user turn as combined blocks (`[tool_result_*…, { type:'text', text }]`).
 * If no next user turn exists yet (mid-conversation, agent still wrapping
 * up), fall through to a standalone tool_result user message — that is
 * the in-loop intermediate shape and Anthropic accepts it.
 */
function buildApiMessages(history: ChatMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  let i = 0;
  while (i < history.length) {
    const m = history[i];
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
      i += 1;
      continue;
    }

    // role === 'assistant'
    //
    // CRITICAL block ordering: Anthropic's tool-use protocol expects
    // `text` (and `thinking`) blocks BEFORE `tool_use` blocks within an
    // assistant turn. If a `text` block follows a `tool_use` block in the
    // same turn, the API treats the tool_use as cancelled by the model's
    // subsequent reasoning and rejects the next user message's
    // tool_result with "tool_use ids were found without tool_result
    // blocks immediately after". We were building [tool_use, text] which
    // tripped exactly that check; the docs example sequences as
    // [text, tool_use_1, tool_use_2, …]. Mirror that here.
    const blocks: AnthropicAssistantBlock[] = [];
    if (m.text) blocks.push({ type: 'text', text: m.text });
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
    }
    if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });

    // Anthropic requires every tool_use to be paired with a tool_result in
    // the next user message. Synthesise a stub for any that finished
    // without a recorded result (HMR cleared state, dispatch interrupted,
    // etc.) so we never emit a malformed sequence.
    const results: AnthropicToolResultBlock[] = (m.toolCalls ?? []).map((tc) => ({
      type: 'tool_result',
      tool_use_id: tc.id,
      content: tc.result?.text ?? '(tool call did not complete in this session — ignore and continue)',
      is_error: tc.result?.isError ?? true,
    }));

    if (results.length === 0) {
      i += 1;
      continue;
    }

    // Try to fold the next user turn's text into the same user message
    // so we never create a double-user pair (which Anthropic also rejects).
    const next = history[i + 1];
    if (next && next.role === 'user') {
      out.push({
        role: 'user',
        content: [...results, { type: 'text', text: next.text }],
      });
      i += 2;
    } else {
      out.push({ role: 'user', content: results });
      i += 1;
    }
  }
  return out;
}

/**
 * Walk the apiMessages list and confirm every `tool_use` block has a
 * matching `tool_result` block in the immediately-following user message.
 * Throws (caught by runConversation) if not. This exists so we fail in
 * code we can fix instead of mysteriously erroring at Anthropic.
 */
function assertToolUseShape(messages: ApiMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const toolUseIds: string[] = [];
    for (const block of m.content) {
      if (typeof block === 'object' && block.type === 'tool_use') toolUseIds.push((block as { id: string }).id);
    }
    if (toolUseIds.length === 0) continue;
    const next = messages[i + 1];
    if (!next || next.role !== 'user' || typeof next.content === 'string') {
      throw new Error(`assistant turn ${i} has tool_use but next turn isn't a user-with-blocks message`);
    }
    const resultIds = new Set<string>();
    for (const block of next.content) {
      if (typeof block === 'object' && block.type === 'tool_result') {
        resultIds.add((block as { tool_use_id: string }).tool_use_id);
      }
    }
    const missing = toolUseIds.filter((id) => !resultIds.has(id));
    if (missing.length > 0) {
      throw new Error(`tool_use without matching tool_result at turn ${i}: ${missing.join(', ')}`);
    }
  }
}

export async function runConversation(opts: RunOpts): Promise<void> {
  const client = createAnthropicClient(opts.credentials);
  const apiMessages = buildApiMessages(opts.history);

  // Compact, opt-in diagnostic logging. The previous version dumped the
  // full apiMessages payload (including raw user prompts, attachment text,
  // tool args, and tool results) on every request — fine for development,
  // but a privacy footgun for a BYOK feature where users own the API key
  // and don't expect their conversation to land in browser devtools.
  // Anything heavier than the one-line summary is now gated behind a
  // localStorage flag the user has to set explicitly.
  const wantsVerbose = (() => {
    try {
      return typeof window !== 'undefined' && window.localStorage?.getItem('ifclite-playground-debug') === '1';
    } catch (error) {
      console.warn('[playground-chat] Debug preference unavailable', error);
      return false;
    }
  })();
  // eslint-disable-next-line no-console
  console.debug(`[playground-chat] → ${apiMessages.length} messages`);
  if (wantsVerbose) {
    // eslint-disable-next-line no-console
    console.groupCollapsed('[playground-chat] full payload (debug)');
    // eslint-disable-next-line no-console
    console.log(JSON.parse(JSON.stringify(apiMessages)));
    // eslint-disable-next-line no-console
    console.groupEnd();
  }

  try {
    assertToolUseShape(apiMessages);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[playground-chat] FAILED tool-use shape assertion before sending:', err);
    throw err;
  }

  const accumulated: { text: string; toolCalls: ChatToolCall[] } = { text: '', toolCalls: [] };
  let toolCallCount = 0;

  // Loop: each iteration is a single Anthropic round-trip. Stops when the
  // assistant finishes without requesting more tools, or when we hit the cap.
  while (true) {
    const res = await client.messages.create({
      model: opts.modelId,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: opts.tools as unknown as Parameters<typeof client.messages.create>[0]['tools'],
      messages: apiMessages as Parameters<typeof client.messages.create>[0]['messages'],
    }, { signal: opts.signal });
    opts.signal.throwIfAborted();

    const blocks = res.content as AnthropicAssistantBlock[];
    const newToolCalls: ChatToolCall[] = [];
    let newText = '';
    for (const block of blocks) {
      if (block.type === 'text') newText += block.text;
      else if (block.type === 'tool_use') {
        newToolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input ?? {},
          startedAt: Date.now(),
        });
      }
    }

    if (newText) accumulated.text += (accumulated.text ? '\n' : '') + newText;
    if (newToolCalls.length > 0) accumulated.toolCalls.push(...newToolCalls);
    opts.onUpdate({ text: accumulated.text, toolCalls: accumulated.toolCalls });

    // Push the assistant turn into the rolling history regardless of whether
    // there are more tools — Anthropic requires the full assistant block list.
    apiMessages.push({ role: 'assistant', content: blocks });

    if (newToolCalls.length === 0 || res.stop_reason !== 'tool_use') {
      // Done.
      opts.onUpdate({ text: accumulated.text, toolCalls: accumulated.toolCalls, pending: false });
      return;
    }

    if (toolCallCount + newToolCalls.length > MAX_TOOL_CALLS) {
      // Cap reached — synthesise an error tool_result so Claude can wrap up.
      const cap: AnthropicToolResultBlock[] = newToolCalls.map((tc) => ({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: `Stopped: this playground caps at ${MAX_TOOL_CALLS} tool calls per request. Summarise what you have so far.`,
        is_error: true,
      }));
      apiMessages.push({ role: 'user', content: cap });
      for (const tc of newToolCalls) {
        tc.result = {
          text: `Stopped at cap (${MAX_TOOL_CALLS}).`,
          structured: null,
          isError: true,
          errorCode: 'CAP_REACHED',
        };
        tc.finishedAt = Date.now();
      }
      opts.onUpdate({ toolCalls: accumulated.toolCalls });
      // Continue once more so Claude can produce a final text answer.
      continue;
    }

    // Run each tool, build tool_result blocks. Re-pull the dispatch context
    // every iteration so the viewer controller stays fresh if the user
    // mounts/unmounts the panel mid-conversation.
    const results: AnthropicToolResultBlock[] = [];
    for (const tc of newToolCalls) {
      const ctx = opts.getDispatchContext();
      const dispatched = await dispatch(opts.model, tc.name, tc.args, ctx);
      opts.signal.throwIfAborted();
      tc.result = dispatched;
      tc.finishedAt = Date.now();
      results.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: dispatched.text,
        is_error: dispatched.isError,
      });
    }
    toolCallCount += newToolCalls.length;
    opts.onUpdate({ toolCalls: accumulated.toolCalls });
    apiMessages.push({ role: 'user', content: results });
  }
}
