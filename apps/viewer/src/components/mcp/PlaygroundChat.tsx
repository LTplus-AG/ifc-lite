/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PlaygroundChat — chat panel that streams from Anthropic with the MCP
 * tool catalogue exposed via Claude's native `tools` parameter.
 *
 * Loop:
 *   1. User submits a prompt.
 *   2. We POST history + tools[] to Anthropic via @anthropic-ai/sdk
 *      (dangerouslyAllowBrowser: true; key from BYOK localStorage).
 *   3. While the response contains `tool_use` blocks AND we're under the
 *      25-call hard cap: run each tool through `dispatch()`, push the
 *      paired `tool_result` blocks back as a new user message, ask
 *      Anthropic to continue.
 *   4. When the response has no more tool_use blocks (or we hit the cap),
 *      flush the assistant message + render.
 *
 * Tool calls are rendered inline as collapsible cards so the agent's
 * reasoning trail is the page's main signal.
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Anthropic from '@anthropic-ai/sdk';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, Check, ChevronDown, ChevronRight, Download, KeyRound, Loader2, RefreshCcw, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getApiKeys, subscribeApiKeys, type ApiKeyConfig } from '@/services/api-keys';
import {
  getPlaygroundModel,
  setPlaygroundModel,
  subscribePlaygroundModel,
} from '@/services/playground-model';
import { getByokModelsForSource } from '@/lib/llm/models';
import { ByokKeyModal } from '@/components/viewer/chat/ByokKeyModal';
import {
  anthropicToolDefinitions,
  dispatch,
  type AnthropicToolDef,
  type DispatchContext,
  type LoadedPlaygroundModel,
  type ToolDispatchResult,
} from './playground-dispatcher';
import { playgroundFiles, formatBytes as formatFileBytes } from './playground-files';
import { playgroundUploads, usePlaygroundUploads, type UploadedFile } from './playground-uploads';
import { Paperclip, X } from 'lucide-react';

const MAX_TOOL_CALLS = 25;
const MAX_TOKENS = 4096;
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
- BCF authoring is also live: bcf_topic_create, bcf_topic_update, bcf_topic_close, bcf_viewpoint_create. The .bcfzip auto-stages after every BCF call — the user just clicks the pill.
- The 3D viewer is INLINE on this page. When the user asks any 3D action (open, isolate, colorize, section, fly to, etc.), call viewer_open / viewer_* DIRECTLY. Do NOT call viewer_ask first. viewer_ask is only for when YOU are proactively suggesting the viewer.
- Quote real GlobalIds + values when you cite something. Don't paraphrase.

File attachments (IDS specs etc.):
- The user can drag-drop .ids files (or any text file) onto the chat. When they do, a system note appears in their message: "[Attached file: foo.ids …]". Use ids_validate / ids_explain with ids_path: "foo.ids" — the playground resolves the upload behind the scenes. Do NOT ask the user to paste raw XML.
- If the user mentions "this IDS" / "validate against the spec" but no attachment is in this turn, ask them to drop the .ids file onto the chat (don't ask for raw XML).

Downloads (very important):
- When a tool produces a file (bcf_export, model_save, export_ifc/csv/json, ids_validate), the playground UI automatically renders an inline "Get .bcf" / "Save IFC" / etc. button under that tool call. The user clicks it explicitly — files NEVER download automatically.
- Don't tell the user "the file is in the Downloads panel" or "click the download button" — the button is right there, redundant. Just confirm what was produced in 1 line.
- BCF auto-stages: every bcf_topic_* / bcf_viewpoint_create call already produces a fresh .bcfzip pill. DO NOT call bcf_export afterwards just to "create" the download — it's already there. Only call bcf_export if the user explicitly asks to re-export with custom settings.
- After mutations, if the user is wrapping up, suggest model_save ONCE so they can grab the edited IFC. Don't keep re-suggesting.`;

// ── message model ──────────────────────────────────────────────────────────

interface ChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: ToolDispatchResult;
  startedAt: number;
  finishedAt?: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolCalls?: ChatToolCall[];
  /** True while we're still streaming + looping tool calls. */
  pending?: boolean;
}

// ── component ──────────────────────────────────────────────────────────────

export function PlaygroundChat({
  model,
  dispatchContext,
}: {
  model: LoadedPlaygroundModel | null;
  /** Lets the chat thread the live viewer controller (etc.) into every
   *  tool call so viewer_* tools can drive the inline canvas. */
  dispatchContext?: () => DispatchContext;
}): ReactNode {
  const [keys, setKeys] = useState<ApiKeyConfig>(() => getApiKeys());
  useEffect(() => subscribeApiKeys(() => setKeys(getApiKeys())), []);

  // Selected Claude model (Anthropic only — the playground driver uses
  // Anthropic's native tools API). Persisted to localStorage separately
  // from the viewer's chatActiveModel so the two pages can default
  // differently.
  const [selectedModel, setSelectedModel] = useState<string>(() => getPlaygroundModel());
  useEffect(() => subscribePlaygroundModel(() => setSelectedModel(getPlaygroundModel())), []);
  const anthropicModels = useMemo(() => getByokModelsForSource('anthropic'), []);

  // Shared BYOK key entry modal — same component the viewer chat uses.
  const [keyModalOpen, setKeyModalOpen] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // Files attached since the last send. They land in the playgroundUploads
  // store (so the dispatcher can resolve them by name) AND get listed in
  // a "to send" array we drain on each submit.
  const uploads = usePlaygroundUploads();
  const [pendingAttachments, setPendingAttachments] = useState<UploadedFile[]>([]);

  // Auto-scroll on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const tools = useMemo(() => anthropicToolDefinitions(), []);

  const send = useCallback(
    async (prompt: string, attached: UploadedFile[]) => {
      if (!model) {
        setError('Load a sample model first.');
        return;
      }
      if (!keys.anthropicKey) {
        setError('Set an Anthropic key (top right).');
        return;
      }
      setError(null);
      setStreaming(true);

      // Prepend a tiny system-note prefix when files were attached so the
      // agent knows the upload exists and how to reference it. Per-kind
      // hints so the agent picks the right tool without guessing.
      const attachNote = attached.length > 0
        ? attached.map((u) => describeAttachment(u)).join('\n') + '\n\n'
        : '';
      const fullPrompt = attachNote + prompt;

      const userMessage: ChatMessage = { id: rid(), role: 'user', text: fullPrompt };
      const assistantMessage: ChatMessage = {
        id: rid(),
        role: 'assistant',
        text: '',
        toolCalls: [],
        pending: true,
      };
      setMessages((m) => [...m, userMessage, assistantMessage]);

      try {
        await runConversation({
          apiKey: keys.anthropicKey,
          modelId: selectedModel,
          tools,
          history: [...messages, userMessage],
          model,
          assistantId: assistantMessage.id,
          getDispatchContext: dispatchContext ?? (() => ({})),
          onUpdate: (patch) => {
            setMessages((m) =>
              m.map((msg) => (msg.id === assistantMessage.id ? { ...msg, ...patch } : msg)),
            );
          },
        });
      } catch (err) {
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantMessage.id
              ? { ...msg, pending: false, text: msg.text || '— request failed —' }
              : msg,
          ),
        );
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setStreaming(false);
      }
    },
    [keys.anthropicKey, selectedModel, model, tools, messages, dispatchContext],
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if ((!trimmed && pendingAttachments.length === 0) || isStreaming) return;
    const attachedThisTurn = pendingAttachments;
    setInput('');
    setPendingAttachments([]);
    void send(trimmed || '(see attached file)', attachedThisTurn);
  };

  const attachFiles = useCallback(async (files: FileList | File[]) => {
    const list: UploadedFile[] = [];
    for (const f of Array.from(files)) {
      // 25 MB cap so a small IFC fits, but blocks rogue gigabyte drops.
      if (f.size > 25 * 1024 * 1024) {
        setError(`${f.name} is over 25 MB — too large for chat attachments. Use the sample picker instead.`);
        continue;
      }
      try {
        const entry = await playgroundUploads.add(f);
        list.push(entry);
      } catch (err) {
        setError(`Failed to read ${f.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (list.length > 0) setPendingAttachments((prev) => [...prev, ...list]);
  }, []);

  /** Per-kind system note so the agent knows what to do with the file
   *  without having to guess from the extension. */
  function describeAttachment(u: UploadedFile): string {
    const ext = u.name.toLowerCase().split('.').pop() ?? '';
    const head = `[Attached: ${u.name} · ${formatFileBytes(u.size)}]`;
    switch (ext) {
      case 'ids':
        return `${head} — IDS spec. Call ids_validate / ids_explain with ids_path: "${u.name}".`;
      case 'csv':
      case 'tsv': {
        // Inline a small preview so the agent can summarise without a
        // dedicated read_file tool. Cap at ~16 lines / 2 KB.
        const preview = u.text.split('\n').slice(0, 16).join('\n').slice(0, 2048);
        return `${head} — CSV data. First lines:\n\`\`\`\n${preview}\n\`\`\``;
      }
      case 'json': {
        const preview = u.text.slice(0, 2048);
        return `${head} — JSON. Preview:\n\`\`\`json\n${preview}${u.text.length > 2048 ? '\n…' : ''}\n\`\`\``;
      }
      case 'ifc':
        return `${head} — IFC file. The playground's loaded model is the primary one; treat this as background reference. Don't try to ingest it as a second model in v1.`;
      case 'bcf':
      case 'bcfzip':
        return `${head} — BCF bundle. The playground can only WRITE BCF in v1; tell the user this is read-only context.`;
      case 'xml':
        return `${head} — XML. If it looks like IDS, call ids_validate with ids_path: "${u.name}".`;
      default: {
        const preview = u.text.slice(0, 1024);
        return `${head}\n\`\`\`\n${preview}${u.text.length > 1024 ? '\n…' : ''}\n\`\`\``;
      }
    }
  }

  // ── render ──────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0f0f12] text-[#ede4d3]">
      <PlaygroundHeader
        hasKey={Boolean(keys.anthropicKey)}
        maskedKey={
          keys.anthropicKey
            ? `${keys.anthropicKey.slice(0, 7)}…${keys.anthropicKey.slice(-4)}`
            : ''
        }
        onOpenKeyModal={() => setKeyModalOpen(true)}
        selectedModel={selectedModel}
        anthropicModels={anthropicModels}
        onChangeModel={setPlaygroundModel}
      />
      <ByokKeyModal open={keyModalOpen} onOpenChange={setKeyModalOpen} initialProvider="anthropic" />

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5">
        {messages.length === 0 ? (
          <Welcome model={model} onPickPrompt={(p) => setInput(p)} />
        ) : (
          <ul className="flex flex-col gap-5">
            {messages.map((m) => (
              <li key={m.id}>
                <MessageView msg={m} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <div className="mx-5 mb-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
          {error}
        </div>
      )}

      <form
        onSubmit={onSubmit}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) void attachFiles(e.dataTransfer.files);
        }}
        className={cn('relative border-t p-3 transition-colors', dragOver ? 'border-[#d6ff3f]/60 bg-[#d6ff3f]/5' : 'border-white/10')}
      >
        {/* Pending attachment chips */}
        {pendingAttachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pendingAttachments.map((f) => (
              <span
                key={f.name}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#d6ff3f]/30 bg-[#d6ff3f]/10 px-2 py-1 text-[11px]"
                style={{ ...{ fontFamily: '"JetBrains Mono", monospace' }, color: '#d6ff3f' }}
              >
                <Paperclip size={11} />
                <span className="max-w-[180px] truncate" title={f.name}>{f.name}</span>
                <span className="text-white/40">{formatFileBytes(f.size)}</span>
                <button
                  type="button"
                  onClick={() => {
                    playgroundUploads.remove(f.name);
                    setPendingAttachments((prev) => prev.filter((x) => x.name !== f.name));
                  }}
                  className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-white/50 hover:bg-white/10 hover:text-white"
                  aria-label={`Remove ${f.name}`}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 rounded-md border border-white/15 bg-white/[0.03] px-2.5 py-2">
          {/* Attach */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-white/55 hover:bg-white/5 hover:text-white"
            title="Attach a file (.ids, .xml, …)"
          >
            <Paperclip size={14} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".ids,.xml,.json,.csv,.txt,.ifc,.bcf,.bcfzip,.md"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) {
                void attachFiles(e.target.files);
                e.target.value = ''; // allow re-attaching the same file
              }
            }}
          />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSubmit(e);
              }
            }}
            placeholder={
              !model
                ? 'Load a sample model first.'
                : !keys.anthropicKey
                  ? 'Set an Anthropic key first.'
                  : pendingAttachments.length > 0
                    ? 'Add a note (or just send to validate the attached file)…'
                    : 'Ask the agent — drop a .ids onto the chat to validate it.'
            }
            disabled={!model || isStreaming}
            rows={1}
            className="min-h-[28px] max-h-32 flex-1 resize-none bg-transparent text-[14px] outline-none placeholder:text-white/30"
            style={{ fontFamily: '"Bricolage Grotesque", system-ui, sans-serif' }}
          />
          <button
            type="submit"
            disabled={(!input.trim() && pendingAttachments.length === 0) || isStreaming || !model || !keys.anthropicKey}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[#d6ff3f] text-[#0a0a0c] transition-opacity disabled:opacity-30"
            aria-label="Send"
          >
            {isStreaming ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={14} strokeWidth={2.5} />}
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-white/40">
          BYOK · {tools.length} tools · {uploads.length > 0 ? `${uploads.length} attached file${uploads.length === 1 ? '' : 's'} · ` : ''}enter to send · ⇧+enter for newline · drop files to attach
        </p>
        {dragOver && (
          <div
            className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-md border-2 border-dashed text-[12px]"
            style={{ borderColor: '#d6ff3f', color: '#d6ff3f', background: 'rgba(214,255,63,0.05)', fontFamily: '"JetBrains Mono", monospace' }}
          >
            release to attach
          </div>
        )}
      </form>
    </div>
  );
}

// ── header / key entry + model picker ─────────────────────────────────────

function PlaygroundHeader({
  hasKey,
  maskedKey,
  onOpenKeyModal,
  selectedModel,
  anthropicModels,
  onChangeModel,
}: {
  hasKey: boolean;
  maskedKey: string;
  onOpenKeyModal: () => void;
  selectedModel: string;
  anthropicModels: ReturnType<typeof getByokModelsForSource>;
  onChangeModel: (modelId: string) => void;
}): ReactNode {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#d6ff3f]"
          aria-hidden
        />
        <span
          className="text-[10px] uppercase tracking-[0.22em] text-white/60"
          style={{ fontFamily: '"JetBrains Mono", monospace' }}
        >
          ifc-lite/mcp · agent
        </span>
      </div>

      <div className="flex items-center gap-2">
        {/* Model picker — Anthropic-only because the playground driver uses
            Anthropic's native tools API. The dropdown's styling mirrors the
            key-status pill so the two affordances read as a single cluster. */}
        <label
          className="inline-flex items-center gap-1 rounded border border-white/15 bg-white/[0.03] px-1.5 py-1 text-[10.5px] text-white/70"
          style={{ fontFamily: '"JetBrains Mono", monospace' }}
          title="Anthropic model used for tool-calling agent loops"
        >
          <span className="text-white/40">model</span>
          <select
            value={selectedModel}
            onChange={(e) => onChangeModel(e.target.value)}
            className="bg-transparent text-[10.5px] outline-none [&>option]:bg-[#0a0a0c] [&>option]:text-white"
            style={{ fontFamily: '"JetBrains Mono", monospace' }}
            aria-label="Select Claude model"
          >
            {anthropicModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>

        {/* Key-status pill — opens the shared BYOK modal so the playground
            and the viewer chat share one trust-focused entry surface. */}
        <button
          onClick={onOpenKeyModal}
          className={cn(
            'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[10.5px]',
            hasKey
              ? 'border-[#d6ff3f]/40 text-[#d6ff3f] hover:bg-[#d6ff3f]/5'
              : 'border-orange-400/40 text-orange-300 hover:bg-orange-400/5',
          )}
          style={{ fontFamily: '"JetBrains Mono", monospace' }}
          aria-label={hasKey ? 'Manage Anthropic API key' : 'Add Anthropic API key'}
        >
          <KeyRound size={11} />
          {hasKey ? `key set · ${maskedKey}` : 'set Anthropic key'}
        </button>
      </div>
    </div>
  );
}

// ── welcome ───────────────────────────────────────────────────────────────

const STARTER_PROMPTS = [
  'Run model_audit and tell me the score. Then list any issues.',
  'How many IfcWall vs IfcWindow vs IfcDoor are in this model?',
  'Find every IfcWall where Pset_WallCommon.IsExternal = true. Tell me their GlobalIds.',
  'Look up Pset_WallCommon in bSDD and list its canonical properties.',
  'Group the entities by storey. Which storey has the most elements?',
];

function Welcome({
  model,
  onPickPrompt,
}: {
  model: LoadedPlaygroundModel | null;
  onPickPrompt: (p: string) => void;
}): ReactNode {
  return (
    <div className="flex h-full flex-col items-start justify-center gap-4">
      <div>
        <h2
          className="text-[28px] leading-none tracking-tight"
          style={{ fontFamily: '"Instrument Serif", serif', fontStyle: 'italic' }}
        >
          {model ? `Ask the agent about ${model.name}.` : 'Load a model. Ask the agent.'}
        </h2>
        <p className="mt-2 max-w-md text-[13.5px] leading-snug text-white/60">
          Claude drives the same {anthropicToolDefinitions().length} tools the stdio MCP exposes — query, mutate, validate, BCF, export. Tool calls render inline.
        </p>
      </div>
      {model && (
        <div className="mt-2 flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.22em] text-white/40" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
            try
          </span>
          <div className="flex flex-col gap-1.5">
            {STARTER_PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => onPickPrompt(p)}
                className="text-left text-[12.5px] leading-snug text-white/80 underline-offset-4 hover:text-[#d6ff3f] hover:underline"
              >
                ↳ {p}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── message render ────────────────────────────────────────────────────────

function MessageView({ msg }: { msg: ChatMessage }): ReactNode {
  if (msg.role === 'user') {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[85%] rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-[13.5px] leading-snug">
          {msg.text}
        </div>
      </div>
    );
  }
  // The auto-staged BCF bundle reuses ONE fileId across many tool calls
  // (topic_create → topic_update → viewpoint_create → bcf_export all bump
  // the same blob). Render the inline `Get .bcfzip` pill only on the LAST
  // call that produced each fileId, otherwise we get a wall of duplicate
  // download buttons that all point at the same artifact.
  const lastDownloadIdx = new Map<string, number>();
  msg.toolCalls?.forEach((tc, i) => {
    const fid = tc.result?.download?.fileId;
    if (fid) lastDownloadIdx.set(fid, i);
  });
  return (
    <div className="flex flex-col items-start gap-2">
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <ul className="flex w-full flex-col gap-1.5">
          {msg.toolCalls.map((tc, i) => {
            const fid = tc.result?.download?.fileId;
            const showDownload = !fid || lastDownloadIdx.get(fid) === i;
            return (
              <li key={tc.id}>
                <ToolCallView call={tc} showDownload={showDownload} />
              </li>
            );
          })}
        </ul>
      )}
      {msg.text && (
        <div className="prose-playground max-w-[95%] text-[13.5px] leading-relaxed text-white/95">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
            {msg.text}
          </ReactMarkdown>
          {msg.pending && <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-[#d6ff3f]" />}
        </div>
      )}
      {msg.pending && !msg.text && msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="text-[11px] text-white/40">… composing answer …</div>
      )}
      {msg.pending && !msg.text && (!msg.toolCalls || msg.toolCalls.length === 0) && (
        <div className="text-[11px] text-white/40">… thinking …</div>
      )}
    </div>
  );
}

function ToolCallView({ call, showDownload = true }: { call: ChatToolCall; showDownload?: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const isErr = call.result?.isError;
  const ms = call.finishedAt ? call.finishedAt - call.startedAt : null;
  const download = showDownload ? call.result?.download : undefined;
  return (
    <div
      className={cn(
        'rounded-md border text-[12.5px]',
        isErr ? 'border-red-500/40 bg-red-500/[0.04]' : 'border-white/10 bg-white/[0.025]',
      )}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={12} className={isErr ? 'text-red-400' : 'text-[#d6ff3f]'} />
        <code className="font-mono text-[12px]" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
          {call.name}
        </code>
        <span className="ml-auto inline-flex items-center gap-2 text-[10.5px] text-white/40">
          {call.result == null ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            <>
              {ms != null && <span style={{ fontFamily: '"JetBrains Mono", monospace' }}>{ms} ms</span>}
              <span
                className={cn(
                  'rounded px-1 py-px uppercase tracking-[0.15em]',
                  isErr ? 'bg-red-500/15 text-red-300' : 'bg-[#d6ff3f]/15 text-[#d6ff3f]',
                )}
                style={{ fontFamily: '"JetBrains Mono", monospace' }}
              >
                {isErr ? call.result.errorCode ?? 'error' : 'ok'}
              </span>
            </>
          )}
        </span>
      </button>
      {/* Inline download offer — present whenever the tool produced an
          artifact. Lives between the header and the collapsible details so
          it's never hidden behind a "click to expand" gesture. The
          download is opt-in: it ONLY fires when this button is clicked. */}
      {download && <InlineDownload download={download} />}
      {open && (
        <div className="border-t border-white/10 px-3 py-2.5">
          {Object.keys(call.args).length > 0 && (
            <>
              <div className="mb-1 text-[10px] uppercase tracking-[0.22em] text-white/40" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
                args
              </div>
              <pre
                className="mb-3 overflow-x-auto rounded bg-black/40 p-2 text-[11px]"
                style={{ fontFamily: '"JetBrains Mono", monospace' }}
              >
                {JSON.stringify(call.args, null, 2)}
              </pre>
            </>
          )}
          {call.result && (
            <>
              <div className="mb-1 text-[10px] uppercase tracking-[0.22em] text-white/40" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
                result
              </div>
              <pre
                className={cn(
                  'overflow-x-auto whitespace-pre-wrap rounded p-2 text-[11px] leading-snug',
                  isErr ? 'bg-red-500/10 text-red-200' : 'bg-black/40 text-white/85',
                )}
                style={{ fontFamily: '"JetBrains Mono", monospace' }}
              >
                {call.result.text}
              </pre>
              {call.result.hint && (
                <p className="mt-1.5 text-[10.5px] italic text-white/50">{call.result.hint}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
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
  apiKey: string;
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
 * tool_use by an extra turn (and yielding a double-user pair Anthropic
 * also rejects).
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

async function runConversation(opts: RunOpts): Promise<void> {
  const client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });
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
    } catch {
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
    });

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

function rid(): string {
  return Math.random().toString(36).slice(2, 11);
}

/**
 * InlineDownload — chartreuse "Get .bcf" / "Save IFC" pill that surfaces
 * directly under the tool-call header whenever a tool produced a file. The
 * file is already in the playgroundFiles store (so the sidebar Downloads
 * panel mirrors it); this is the discoverable, in-context offer right next
 * to the action that produced it.
 *
 * UX rules baked in:
 *   • The artifact NEVER auto-downloads. The user has to click.
 *   • After a click, the button shows "Saved" for ~2s so the user has
 *     visible feedback without losing the affordance to re-download.
 *   • Re-clicking re-runs the download — useful if the user closed the
 *     prompt by accident.
 */
function InlineDownload({
  download,
}: {
  download: NonNullable<ToolDispatchResult['download']>;
}): ReactNode {
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const justSaved = savedAt != null && Date.now() - savedAt < 2000;
  useEffect(() => {
    if (savedAt == null) return;
    const t = setTimeout(() => setSavedAt(null), 2000);
    return () => clearTimeout(t);
  }, [savedAt]);

  return (
    <div className="border-t border-white/5 px-3 py-2">
      <button
        onClick={() => {
          playgroundFiles.download(download.fileId);
          setSavedAt(Date.now());
        }}
        className={cn(
          'group flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left transition-colors',
          justSaved ? 'bg-white/10' : 'bg-[#d6ff3f] hover:bg-[#e6ff66]',
        )}
        style={justSaved ? { color: '#d6ff3f' } : { color: '#0a0a0c' }}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded',
              justSaved ? 'bg-white/10' : 'bg-black/10',
            )}
          >
            {justSaved ? <Check size={14} strokeWidth={2.6} /> : <Download size={14} strokeWidth={2.4} />}
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span
              className="truncate text-[13px] font-semibold"
              style={{ fontFamily: '"Bricolage Grotesque", system-ui, sans-serif' }}
            >
              {justSaved ? 'Saved — click again to re-download' : download.label}
            </span>
            <span
              className={cn('truncate text-[10.5px]', justSaved ? 'text-white/50' : 'text-black/55')}
              style={{ fontFamily: '"JetBrains Mono", monospace' }}
            >
              {download.filename} · {formatFileBytes(download.size)}
            </span>
          </span>
        </span>
      </button>
    </div>
  );
}

// ── markdown rendering ────────────────────────────────────────────────────
//
// Tailwind utility set scoped to the chat. Headings stay quiet (the chat
// already structures the conversation). Tables get hairline borders.
// Inline code + code blocks pick up JetBrains Mono so they read like the
// tool-call cards.

const MARKDOWN_COMPONENTS = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h1: (props: any) => <h3 className="mt-3 mb-1 text-[16px] font-semibold" {...props} />,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h2: (props: any) => <h4 className="mt-3 mb-1 text-[14.5px] font-semibold" {...props} />,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h3: (props: any) => <h5 className="mt-2 mb-1 text-[13.5px] font-semibold" {...props} />,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p: (props: any) => <p className="my-1.5 first:mt-0 last:mb-0" {...props} />,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ul: (props: any) => <ul className="my-1.5 ml-4 list-disc space-y-0.5" {...props} />,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ol: (props: any) => <ol className="my-1.5 ml-4 list-decimal space-y-0.5" {...props} />,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  li: (props: any) => <li className="leading-snug" {...props} />,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  strong: (props: any) => <strong className="font-semibold text-white" {...props} />,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  em: (props: any) => <em className="italic text-white/95" {...props} />,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  a: (props: any) => (
    <a className="text-[#d6ff3f] underline-offset-2 hover:underline" target="_blank" rel="noreferrer" {...props} />
  ),
  // react-markdown v9 dropped the legacy `inline` prop, so we infer block
  // vs inline from className (fenced blocks get `language-…`) and content
  // (block code carries trailing newlines). When it's a block we render
  // a raw <code> here and let the `pre` override below own the wrapper —
  // doing the wrapping ourselves used to nest <pre> inside the <p>
  // react-markdown emits for surrounding text, tripping React's DOM
  // nesting validator.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  code: ({ className, children, ...props }: any) => {
    const cls = typeof className === 'string' ? className : '';
    const text = Array.isArray(children) ? children.join('') : String(children ?? '');
    const isBlock = cls.startsWith('language-') || /\n/.test(text);
    if (isBlock) {
      return (
        <code className={cn(cls, 'block')} style={{ fontFamily: '"JetBrains Mono", monospace' }} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className={cn(
          'rounded bg-white/10 px-1 py-0.5 text-[12px] text-[#d6ff3f]',
          cls,
        )}
        style={{ fontFamily: '"JetBrains Mono", monospace' }}
        {...props}
      >
        {children}
      </code>
    );
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pre: (props: any) => (
    <pre className="my-2 overflow-x-auto rounded bg-black/40 p-3 text-[12px] leading-snug" style={{ fontFamily: '"JetBrains Mono", monospace' }} {...props} />
  ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: (props: any) => (
    <div className="my-2 overflow-x-auto rounded border border-white/10">
      <table className="w-full border-collapse text-[12.5px]" {...props} />
    </div>
  ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  thead: (props: any) => <thead className="bg-white/[0.04]" {...props} />,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  th: (props: any) => (
    <th
      className="border-b border-white/10 px-2.5 py-1.5 text-left text-[10.5px] uppercase tracking-[0.18em] text-white/70"
      style={{ fontFamily: '"JetBrains Mono", monospace' }}
      {...props}
    />
  ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  td: (props: any) => <td className="border-b border-white/5 px-2.5 py-1.5 align-top" {...props} />,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blockquote: (props: any) => (
    <blockquote className="my-2 border-l-2 border-white/20 pl-3 italic text-white/70" {...props} />
  ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hr: (props: any) => <hr className="my-3 border-white/10" {...props} />,
};

// Tiny re-export so the playground page can show an empty-state CTA.
export { RefreshCcw };
