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
import { modelSwapNotice, type SwapModelRef } from './playground-model-swap.js';
import { anthropicErrorMessage } from '@/lib/llm/anthropic-client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, Check, ChevronDown, ChevronRight, Download, RefreshCcw, Square, Wrench } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { useAsyncRun } from '@/hooks/useAsyncRun';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { resolveLiveMessage, type LiveTranslationMessage } from '@/i18n/live-message';
import { getApiKeys, subscribeApiKeys, type ApiKeyConfig } from '@/services/api-keys';
import {
  getPlaygroundModel,
  setPlaygroundModel,
  subscribePlaygroundModel,
} from '@/services/playground-model';
import { getByokModelsForSource } from '@/lib/llm/models';
import { ByokKeyModal } from '@/components/viewer/chat/ByokKeyModal';
import { PLAYGROUND_REQUEST_SOURCE } from '@/components/viewer/chat/byok-audit-sources';
import {
  anthropicToolDefinitions,
  type DispatchContext,
  type LoadedPlaygroundModel,
  type ToolDispatchResult,
} from './playground-dispatcher';
import { playgroundFiles, formatBytes as formatFileBytes } from './playground-files';
import {
  playgroundUploads,
  usePlaygroundUploads,
  mergeAttachmentNames,
  resolveAttachments,
  type UploadedFile,
} from './playground-uploads';
import { Paperclip, X } from 'lucide-react';
import { runConversation, type ChatMessage, type ChatToolCall } from './playground-conversation';
import { MARKDOWN_COMPONENTS } from './playground-markdown';
import { PlaygroundHeader } from './playground-chat-header';
export type { ChatToolCall } from './playground-conversation';

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
  const { t } = useTranslation(); const [keys, setKeys] = useState<ApiKeyConfig>(() => getApiKeys());
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
  const { busy: isStreaming, start, reset } = useAsyncRun({ key: model, label: 'playground conversation' });
  useEffect(() => {
    setMessages(prior => prior.map(message => message.pending ? { ...message, pending: false } : message));
  }, [model]);
  const [error, setError] = useState<LiveTranslationMessage | null>(null); const errorText = resolveLiveMessage(t, error);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // Files attached since the last send. They land in the playgroundUploads
  // store (so the dispatcher can resolve them by name); we track only the
  // NAMES pending this turn and project them through the store's current
  // contents on every render. That projection is what keeps the chip list
  // structurally unable to disagree with the store: the store already
  // collapses same-basename uploads to one entry (last-wins), so a name
  // list can never show two chips — or stale content — for one basename.
  const uploads = usePlaygroundUploads();
  const [pendingNames, setPendingNames] = useState<string[]>([]);
  const pendingAttachments = useMemo(
    () => resolveAttachments(uploads, pendingNames),
    [uploads, pendingNames],
  );

  // Swapping the loaded model invalidates every expressId already in the
  // transcript: they are unique inside ONE STEP file, not across files. The
  // conversation is deliberately kept (losing the user's thread on a file swap
  // would be worse), so the boundary is stated in-band instead — the agent
  // re-reads the whole transcript every turn, and this notice is the only
  // thing standing between it and confidently acting on a stale id (#2471).
  //
  // `lastLoaded` is NOT cleared when the model is closed. It has to survive
  // that, or load A -> close -> load B reads as a first load and says nothing
  // — and the close button sits in the same toolbar as the file picker.
  const lastLoaded = useRef<SwapModelRef | null>(null);
  const loadCounter = useRef(0);
  const nextRef = useRef<SwapModelRef | null>(null);
  const currentModelObject = useRef<LoadedPlaygroundModel | null>(null);
  if (model !== currentModelObject.current) {
    currentModelObject.current = model;
    // A new model OBJECT is a new load. The id is a slug of the filename, so
    // re-dropping a revised `model.ifc` keeps the id while every expressId may
    // have moved — the load counter is what distinguishes them.
    loadCounter.current += 1;
    nextRef.current = model ? { loadId: loadCounter.current, name: model.name } : null;
  }
  const next = nextRef.current;
  useEffect(() => {
    setMessages((prior) => {
      const notice = modelSwapNotice(lastLoaded.current, next, prior.length);
      return notice ? [...prior, notice] : prior;
    });
    if (next !== null) lastLoaded.current = next;
  }, [next]);

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
        setError({ key: 'mcp.playgroundChat.placeholderNoModel' });
        return;
      }
      if (!keys.anthropicKey) {
        setError({ key: 'mcp.playgroundChat.anthropicKeyRequired' });
        return;
      }
      return start(async ({ signal, isCurrent }) => {
        setError(null);

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

        const credentials = { apiKey: keys.anthropicKey, workspaceId: keys.anthropicWorkspaceId };
        try {
          await runConversation({
            credentials,
            signal,
            modelId: selectedModel,
            tools,
            history: [...messages, userMessage],
            model,
            assistantId: assistantMessage.id,
            getDispatchContext: dispatchContext ?? (() => ({})),
            onUpdate: (patch) => { if (isCurrent()) setMessages((m) =>
              m.map((msg) => (msg.id === assistantMessage.id ? { ...msg, ...patch } : msg)),
            ); },
          });
        } catch (err) {
          if (!isCurrent()) return;
          setMessages((m) =>
            m.map((msg) =>
              msg.id === assistantMessage.id
                ? msg.text
                  ? { ...msg, pending: false }
                  : {
                      ...msg,
                      pending: false,
                      text: t('mcp.playgroundChat.requestFailed'),
                      displayTextKey: 'mcp.playgroundChat.requestFailed',
                    }
                : msg,
            ),
          );
          setError({ text: anthropicErrorMessage(err, credentials.workspaceId) });
        }
      });
    },
    [start, keys.anthropicKey, keys.anthropicWorkspaceId, selectedModel, model, tools, messages, dispatchContext, t],
  );

  const stop = () => {
    reset();
    setMessages(prior => prior.map(message => message.pending
      ? { ...message, pending: false, ...(message.text ? {} : { displayTextKey: 'mcp.playgroundChat.stopped' as const }) }
      : message));
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if ((!trimmed && pendingAttachments.length === 0) || isStreaming) return;
    const attachedThisTurn = pendingAttachments;
    setInput('');
    setPendingNames([]);
    void send(trimmed || '(see attached file)', attachedThisTurn);
  };

  const attachFiles = useCallback(async (files: FileList | File[]) => {
    const list: UploadedFile[] = [];
    for (const f of Array.from(files)) {
      // 25 MB cap so a small IFC fits, but blocks rogue gigabyte drops.
      if (f.size > 25 * 1024 * 1024) {
        setError({ key: 'mcp.playgroundChat.fileTooLarge', params: { name: f.name } });
        continue;
      }
      try {
        const entry = await playgroundUploads.add(f);
        list.push(entry);
      } catch (err) {
        setError({ key: 'mcp.playgroundChat.failedToReadFile', params: { name: f.name, error: err instanceof Error ? err.message : String(err) } });
      }
    }
    if (list.length > 0) {
      setPendingNames((prev) => mergeAttachmentNames(prev, list.map((e) => e.name)));
    }
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
      <ByokKeyModal open={keyModalOpen} onOpenChange={setKeyModalOpen} initialProvider="anthropic" requestSource={PLAYGROUND_REQUEST_SOURCE} />

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
        <div className="mx-5 mb-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {errorText}
        </div>
      )}

      {/* Dropping files supplements the adjacent keyboard-accessible attach button and file input. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
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
                className="inline-flex items-center gap-1.5 rounded-full border border-[#d6ff3f]/30 bg-[#d6ff3f]/10 px-2 py-1 text-2xs"
                style={{ fontFamily: '"JetBrains Mono", monospace', color: '#d6ff3f' }}
              >
                <Paperclip size={11} />
                <span className="max-w-[180px] truncate" title={f.name}>{f.name}</span>
                <span className="text-white/40">{formatFileBytes(f.size)}</span>
                <button
                  type="button"
                  onClick={() => {
                    playgroundUploads.remove(f.name);
                    setPendingNames((prev) => prev.filter((n) => n !== f.name));
                  }}
                  className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-white/50 hover:bg-white/10 hover:text-white"
                  aria-label={t('mcp.playgroundChat.removeFile', { name: f.name })}
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
            title={t('mcp.playgroundChat.attachFileTitle')}
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
            value={input} aria-label={t('mcp.playgroundChat.messageLabel')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSubmit(e);
              }
            }}
            placeholder={
              !model
                ? t('mcp.playgroundChat.placeholderNoModel')
                : !keys.anthropicKey
                  ? t('mcp.playgroundChat.placeholderNoKey')
                  : pendingAttachments.length > 0
                    ? t('mcp.playgroundChat.placeholderAddNote')
                    : t('mcp.playgroundChat.placeholderDefault')
            }
            disabled={!model || isStreaming}
            rows={1}
            className="min-h-[28px] max-h-32 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-white/30"
            style={{ fontFamily: '"Bricolage Grotesque", system-ui, sans-serif' }}
          />
          <button
            type={isStreaming ? 'button' : 'submit'}
            onClick={isStreaming ? stop : undefined}
            disabled={!isStreaming && ((!input.trim() && pendingAttachments.length === 0) || !model || !keys.anthropicKey)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[#d6ff3f] text-[#0a0a0c] transition-opacity disabled:opacity-30"
            aria-label={t(isStreaming ? 'chat.panel.stopGeneratingTooltip' : 'mcp.playgroundChat.send')}
          >
            {isStreaming ? <Square size={14} fill="currentColor" /> : <ArrowUp size={14} strokeWidth={2.5} />}
          </button>
        </div>
        <p className="mt-1.5 text-2xs text-white/40">
          {uploads.length > 0
            ? t('mcp.playgroundChat.footerHintWithAttachments', { tools: tools.length, count: uploads.length })
            : t('mcp.playgroundChat.footerHintNoAttachments', { tools: tools.length })}
        </p>
        {dragOver && (
          <div
            className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-md border-2 border-dashed text-xs"
            style={{ borderColor: '#d6ff3f', color: '#d6ff3f', background: 'rgba(214,255,63,0.05)', fontFamily: '"JetBrains Mono", monospace' }}
          >
            {t('mcp.playgroundChat.releaseToAttach')}
          </div>
        )}
      </form>
    </div>
  );
}

// ── welcome ───────────────────────────────────────────────────────────────

function Welcome({
  model,
  onPickPrompt,
}: {
  model: LoadedPlaygroundModel | null;
  onPickPrompt: (p: string) => void;
}): ReactNode {
  const { t } = useTranslation();
  const STARTER_PROMPTS = [t('mcp.playgroundChat.starterPrompt1'), t('mcp.playgroundChat.starterPrompt2'), t('mcp.playgroundChat.starterPrompt3'), t('mcp.playgroundChat.starterPrompt4'), t('mcp.playgroundChat.starterPrompt5')];
  return (
    <div className="flex h-full flex-col items-start justify-center gap-4">
      <div>
        <h2
          className="text-3xl leading-none tracking-tight"
          style={{ fontFamily: '"Instrument Serif", serif', fontStyle: 'italic' }}
        >
          {model ? t('mcp.playgroundChat.askAboutModel', { name: model.name }) : t('mcp.playgroundChat.loadModelAskAgent')}
        </h2>
        <p className="mt-2 max-w-md text-sm leading-snug text-white/60">
          {t('mcp.playgroundChat.toolsIntro', { count: anthropicToolDefinitions().length })}
        </p>
      </div>
      {model && (
        <div className="mt-2 flex flex-col gap-1.5">
          <span className="text-2xs uppercase tracking-[0.22em] text-white/40" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
            {t('mcp.playgroundChat.try')}
          </span>
          <div className="flex flex-col gap-1.5">
            {STARTER_PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => onPickPrompt(p)}
                className="text-left text-xs leading-snug text-white/80 underline-offset-4 hover:text-[#d6ff3f] hover:underline"
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
  const { t } = useTranslation(); if (msg.role === 'user') {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[85%] rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-sm leading-snug">
          {msg.text}
        </div>
      </div>
    );
  }
  // The auto-staged BCF bundle reuses ONE fileId across many tool calls
  // (topic_create → topic_update → viewpoint_create → bcf_export all bump
  // the same blob). Render the inline `Get .bcf` pill only on the LAST
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
      {(msg.text || msg.displayTextKey) && (
        <div className="prose-playground max-w-[95%] text-sm leading-relaxed text-white/95">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
            {msg.displayTextKey ? t(msg.displayTextKey) : msg.text}
          </ReactMarkdown>
          {msg.pending && <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-[#d6ff3f]" />}
        </div>
      )}
      {msg.pending && !msg.text && !msg.displayTextKey && msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="text-2xs text-white/40">{t('mcp.playgroundChat.composingAnswer')}</div>
      )}
      {msg.pending && !msg.text && !msg.displayTextKey && (!msg.toolCalls || msg.toolCalls.length === 0) && (
        <div className="text-2xs text-white/40">{t('mcp.playgroundChat.thinking')}</div>
      )}
    </div>
  );
}

export function ToolCallView({ call, showDownload = true }: { call: ChatToolCall; showDownload?: boolean }): ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const isErr = call.result?.isError;
  const ms = call.finishedAt ? call.finishedAt - call.startedAt : null;
  const download = showDownload ? call.result?.download : undefined;
  return (
    <div
      className={cn(
        'rounded-md border text-xs',
        isErr ? 'border-red-500/40 bg-red-500/[0.04]' : 'border-white/10 bg-white/[0.025]',
      )}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={12} className={isErr ? 'text-red-400' : 'text-[#d6ff3f]'} />
        <code className="font-mono text-xs" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
          {call.name}
        </code>
        <span className="ml-auto inline-flex items-center gap-2 text-2xs text-white/40">
          {call.result == null ? (
            <Spinner size="xs" />
          ) : (
            <>
              {ms != null && <span style={{ fontFamily: '"JetBrains Mono", monospace' }}>{t('mcp.playgroundChat.msSuffix', { ms })}</span>}
              <span
                className={cn(
                  'rounded px-1 py-px uppercase tracking-[0.15em]',
                  isErr ? 'bg-red-500/15 text-red-300' : 'bg-[#d6ff3f]/15 text-[#d6ff3f]',
                )}
                style={{ fontFamily: '"JetBrains Mono", monospace' }}
              >
                {isErr ? call.result.errorCode ?? t('mcp.playgroundChat.statusError') : t('mcp.playgroundChat.statusOk')}
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
              <div className="mb-1 text-2xs uppercase tracking-[0.22em] text-white/40" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
                {t('mcp.playgroundChat.argsLabel')}
              </div>
              <pre
                className="mb-3 overflow-x-auto rounded bg-black/40 p-2 text-2xs"
                style={{ fontFamily: '"JetBrains Mono", monospace' }}
              >
                {JSON.stringify(call.args, null, 2)}
              </pre>
            </>
          )}
          {call.result && (
            <>
              <div className="mb-1 text-2xs uppercase tracking-[0.22em] text-white/40" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
                {t('mcp.playgroundChat.resultLabel')}
              </div>
              <pre
                className={cn(
                  'overflow-x-auto whitespace-pre-wrap rounded p-2 text-2xs leading-snug',
                  isErr ? 'bg-red-500/10 text-red-200' : 'bg-black/40 text-white/85',
                )}
                style={{ fontFamily: '"JetBrains Mono", monospace' }}
              >
                {call.result.textKey ? t(call.result.textKey) : call.result.text}
              </pre>
              {(call.result.hint || call.result.hintKey) && (
                <p className="mt-1.5 text-2xs italic text-white/50">
                  {call.result.hintKey ? t(call.result.hintKey) : call.result.hint}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
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
export function InlineDownload({
  download,
}: {
  download: NonNullable<ToolDispatchResult['download']>;
}): ReactNode {
  const { t } = useTranslation();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const justSaved = savedAt != null && Date.now() - savedAt < 2000;
  useEffect(() => {
    if (savedAt == null) return;
    const t = setTimeout(() => setSavedAt(null), 2000);
    return () => clearTimeout(t);
  }, [savedAt]);

  return (
    <div className="border-t border-white/5 px-3 py-2">
      <button aria-label={justSaved ? t('mcp.playgroundChat.savedLabel') : download.label}
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
              className="truncate text-sm font-semibold"
              style={{ fontFamily: '"Bricolage Grotesque", system-ui, sans-serif' }}
            >
              {justSaved ? t('mcp.playgroundChat.savedLabel') : download.label}
            </span>
            <span
              className={cn('truncate text-2xs', justSaved ? 'text-white/50' : 'text-black/55')}
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

// Tiny re-export so the playground page can show an empty-state CTA.
export { RefreshCcw };
