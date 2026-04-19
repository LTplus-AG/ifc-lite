/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ChatPanel — Interactive LLM chat with live 3D model generation.
 *
 * Features:
 * - Streaming responses with blinking cursor
 * - Executable code blocks with "Run" and "Fix this" buttons
 * - Drag-and-drop file upload with visual dropzone
 * - Smart auto-scroll with "scroll to bottom" button
 * - Clickable example prompts in empty state
 * - Auto-execute toggle for hands-free workflow
 * - Keyboard shortcuts (Cmd+L focus, Escape close)
 * - Conversation persistence via localStorage
 * - Clear confirmation dialog
 * - Error-to-LLM feedback loop for failed scripts
 */

import { useCallback, useRef, useEffect, useState, type KeyboardEvent, type DragEvent } from 'react';
import {
  X,
  Send,
  Square,
  Trash2,
  Paperclip,
  Loader2,
  ArrowDown,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { buildErrorFeedbackContent } from '@/store/slices/chatSlice';
import { ChatMessageComponent } from './chat/ChatMessage';
import { ModelSelector } from './chat/ModelSelector';
import { fetchUsageSnapshot, streamChat, type StreamMessage, type TextContentPart, type ImageContentPart, type UsageInfo } from '@/lib/llm/stream-client';
import { streamAnthropicChat, streamOpenAiChat } from '@/lib/llm/stream-direct';
import { buildStreamMessagesForModel, filterAttachmentsForModel } from '@/lib/llm/message-capabilities';
import { buildSystemPrompt } from '@/lib/llm/system-prompt';
import { getModelContext, parseCSV } from '@/lib/llm/context-builder';
import { collectActiveFileAttachments } from '@/lib/attachments';
import { extractCodeBlocks } from '@/lib/llm/code-extractor';
import { extractScriptEditOps, filterUnappliedScriptOps } from '@/lib/llm/script-edit-ops';
import { createPatchDiagnostic, getPrimaryRootCause, type RepairScope } from '@/lib/llm/script-diagnostics';
import type { ScriptDiagnostic } from '@/lib/llm/script-diagnostics';
import { buildRepairSessionKey, getEscalatedRepairScope, pruneMessagesForRepair } from '@/lib/llm/repair-loop';
import type { ChatMessage, ChatRepairRequest, FileAttachment } from '@/lib/llm/types';
import { canUsePlainCodeBlockFallback, type ScriptMutationIntent } from '@/lib/llm/script-preservation';
import { Check, Image as ImageIcon, Key, Eye, EyeOff, ExternalLink } from 'lucide-react';
import { hasDesktopFeatureAccess } from '@/lib/desktop-product';
import { getModelById } from '@/lib/llm/models';
import { getApiKeys, updateApiKeys, hasAnyApiKey, hasAnthropicKey, hasOpenaiKey, subscribeApiKeys } from '@/services/api-keys';
import { useSandbox } from '@/hooks/useSandbox';

// Environment variable for the proxy URL
const PROXY_URL = import.meta.env.VITE_LLM_PROXY_URL as string || '/api/chat';

const EXAMPLE_PROMPTS = [
  'Create a 3-story house with walls, slabs, and a gable roof',
  'Color all IfcWalls by their fire rating',
  'Export a quantity takeoff as CSV',
  'Create a skyscraper with 4x4 column grid, 30x40m, concrete shaft',
];

const CONTINUE_PROMPT = 'Continue from exactly where your last response stopped. Do not repeat previously generated text.';
const USAGE_REFRESH_INTERVAL_MS = 15_000;
const EST_CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_COST_EST = 850;
const INPUT_BUDGET_RATIO = 0.72;
const OUTPUT_TOKEN_RESERVE = 9_000;
const MIN_INPUT_BUDGET = 8_000;
const MAX_RECENT_MESSAGES = 48;
const SUMMARY_SNIPPET_LEN = 240;
const MAX_INLINE_IMAGE_DATA_URL_CHARS = 1_200_000;
const MAX_ATTACHMENTS_PER_MESSAGE = 6;
const MAX_TEXT_ATTACHMENT_BYTES = 512_000;
const MAX_IMAGE_ATTACHMENT_BYTES = 8_000_000;

function createAttachmentId(): string {
  return crypto.randomUUID();
}

interface ChatSendOptions {
  continuationBase?: string;
  intent?: ScriptMutationIntent;
  repairDiagnostics?: ScriptDiagnostic[];
  requestedRepairScope?: RepairScope;
  rootCauseKey?: string;
}

/** Convert a File to a base64 data URL */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function imageFileToCompressedBase64(file: File): Promise<string> {
  const raw = await fileToBase64(file);
  return compressDataUrlImage(raw);
}

function compressDataUrlImage(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxSide = 1400;
      const srcW = img.naturalWidth || img.width;
      const srcH = img.naturalHeight || img.height;
      const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
      const outW = Math.max(1, Math.round(srcW * scale));
      const outH = Math.max(1, Math.round(srcH * scale));
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, outW, outH);
      resolve(canvas.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function stripContinuationOverlap(previous: string, continuation: string): string {
  const prev = previous.trimEnd();
  const next = continuation.trimStart();
  if (!prev || !next) return continuation;

  const maxOverlap = Math.min(prev.length, next.length, 1200);
  const minOverlap = Math.min(48, maxOverlap);
  for (let size = maxOverlap; size >= minOverlap; size--) {
    const suffix = prev.slice(-size);
    const prefix = next.slice(0, size);
    if (suffix === prefix) {
      return next.slice(size).trimStart();
    }
  }
  return continuation;
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / EST_CHARS_PER_TOKEN);
}

function estimateContentTokens(content: string | Array<TextContentPart | ImageContentPart>): number {
  if (typeof content === 'string') return estimateTextTokens(content);
  let tokens = 0;
  for (const part of content) {
    if (part.type === 'text') {
      tokens += estimateTextTokens(part.text);
    } else {
      tokens += IMAGE_TOKEN_COST_EST;
    }
  }
  return tokens;
}

function estimateMessagesTokens(messages: Array<{ role: string; content: string | Array<TextContentPart | ImageContentPart> }>): number {
  return messages.reduce((sum, m) => sum + estimateContentTokens(m.content) + 8, 0);
}

function summarizeDroppedMessages(messages: ChatMessage[]): string {
  if (messages.length === 0) return '';
  const summaryParts: string[] = [];
  for (const m of messages.slice(-14)) {
    const body = m.content.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_SNIPPET_LEN);
    if (!body) continue;
    summaryParts.push(`${m.role}: ${body}`);
  }
  return summaryParts.join('\n');
}

interface ChatPanelProps {
  onClose?: () => void;
}

export function ChatPanel({ onClose }: ChatPanelProps) {
  const messages = useViewerStore((s) => s.chatMessages);
  const status = useViewerStore((s) => s.chatStatus);
  const streamingContent = useViewerStore((s) => s.chatStreamingContent);
  const activeModel = useViewerStore((s) => s.chatActiveModel);
  const autoExecute = useViewerStore((s) => s.chatAutoExecute);
  const error = useViewerStore((s) => s.chatError);
  const attachments = useViewerStore((s) => s.chatAttachments);
  const addMessage = useViewerStore((s) => s.addChatMessage);
  const setChatStatus = useViewerStore((s) => s.setChatStatus);
  const updateStreaming = useViewerStore((s) => s.updateLastAssistantMessage);
  const finalizeAssistant = useViewerStore((s) => s.finalizeAssistantMessage);
  const setChatError = useViewerStore((s) => s.setChatError);
  const setChatAbortController = useViewerStore((s) => s.setChatAbortController);
  const setAutoExecute = useViewerStore((s) => s.setChatAutoExecute);
  const addAttachment = useViewerStore((s) => s.addChatAttachment);
  const removeAttachment = useViewerStore((s) => s.removeChatAttachment);
  const clearAttachments = useViewerStore((s) => s.clearChatAttachments);
  const clearMessages = useViewerStore((s) => s.clearChatMessages);
  const resetScriptEditorForNewChat = useViewerStore((s) => s.resetScriptEditorForNewChat);
  const pendingPrompt = useViewerStore((s) => s.chatPendingPrompt);
  const consumePendingPrompt = useViewerStore((s) => s.consumeChatPendingPrompt);
  const pendingRepairRequest = useViewerStore((s) => s.chatPendingRepairRequest);
  const consumePendingRepairRequest = useViewerStore((s) => s.consumeChatPendingRepairRequest);
  const hasByokKey = useViewerStore((s) => s.chatHasByokKey);
  const setChatHasByokKey = useViewerStore((s) => s.setChatHasByokKey);
  const usage = useViewerStore((s) => s.chatUsage);
  const setChatUsage = useViewerStore((s) => s.setChatUsage);
  const desktopEntitlement = useViewerStore((s) => s.desktopEntitlement);
  const { execute } = useSandbox();
  const canUseAiAssistant = hasDesktopFeatureAccess(desktopEntitlement, 'ai_assistant');

  // Sync BYOK key availability into the store and track per-provider state
  const [keyStateAnthropic, setKeyStateAnthropic] = useState(hasAnthropicKey);
  const [keyStateOpenai, setKeyStateOpenai] = useState(hasOpenaiKey);
  useEffect(() => {
    const refresh = () => {
      const a = hasAnthropicKey();
      const o = hasOpenaiKey();
      setKeyStateAnthropic(a);
      setKeyStateOpenai(o);
      setChatHasByokKey(a || o);
    };
    refresh();
    return subscribeApiKeys(refresh);
  }, [setChatHasByokKey]);

  const displayUsage: UsageInfo | null = usage;
  const usageResetLabel = displayUsage?.resetAt && displayUsage.resetAt > 0
    ? new Date(displayUsage.resetAt * 1000).toLocaleDateString()
    : '—';

  const [inputText, setInputText] = useState('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [lastFinishReason, setLastFinishReason] = useState<string | null>(null);
  const promptAiUpgrade = useCallback(() => {
    setChatError('AI assistant is available with Desktop Pro.');
    toast.info('AI assistant is available with Desktop Pro');
  }, [setChatError]);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  const autoRepairAttemptCountsRef = useRef(new Map<string, { attempts: number; lastScope: RepairScope }>());

  const resizeInput = useCallback(() => {
    const target = inputRef.current;
    if (!target) return;
    target.style.height = 'auto';
    target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
  }, []);

  useEffect(() => {
    resizeInput();
  }, [inputText, resizeInput]);

  // ── Smart auto-scroll ──
  // Only auto-scroll if user hasn't scrolled up to read old messages
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!userScrolledUp) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, streamingContent, userScrolledUp]);

  // Detect whether user has scrolled up from the bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      setUserScrolledUp(!isNearBottom);
      setShowScrollBtn(!isNearBottom && (messages.length > 0 || !!streamingContent));
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [messages.length, streamingContent]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setUserScrolledUp(false);
      setShowScrollBtn(false);
    }
  }, []);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep usage meter hydrated even before first prompt and refresh periodically.
  useEffect(() => {
    let cancelled = false;
    const refreshUsage = async () => {
      const snapshot = await fetchUsageSnapshot(PROXY_URL);
      if (!cancelled && snapshot) {
        setChatUsage(snapshot);
      }
    };

    void refreshUsage();
    const timer = window.setInterval(() => {
      void refreshUsage();
    }, USAGE_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [setChatUsage]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      // Cmd+L / Ctrl+L → focus chat input
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      // Escape → close panel (only if chat input isn't focused or is empty)
      if (e.key === 'Escape' && onClose) {
        const isChatFocused = document.activeElement === inputRef.current;
        if (!isChatFocused || !inputText) {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, inputText]);

  const buildRepairPromptFromLiveState = useCallback((request: ChatRepairRequest) => {
    const state = useViewerStore.getState();
    return buildErrorFeedbackContent(state.scriptEditorContent, request.error, {
      diagnostics: request.diagnostics ?? state.scriptLastDiagnostics,
      currentRevision: state.scriptEditorRevision,
      currentSelection: request.includeSelection ? state.scriptEditorSelection : undefined,
      staleCodeBlock: request.staleCodeBlock,
      reason: request.reason,
      requestedRepairScope: request.requestedRepairScope,
    });
  }, []);

  const triggerAutoRepair = (request: ChatRepairRequest) => {
    const state = useViewerStore.getState();
    const diagnostics = request.diagnostics ?? state.scriptLastDiagnostics;
    const primaryRootCause = getPrimaryRootCause(diagnostics);
    const sessionKey = buildRepairSessionKey({
      diagnostics,
      currentCode: state.scriptEditorContent,
    });
    const sessionState = autoRepairAttemptCountsRef.current.get(sessionKey);
    const defaultScope = request.requestedRepairScope ?? primaryRootCause?.repairScope ?? 'local';
    const requestedScope = sessionState
      ? sessionState.attempts >= 1 && sessionState.lastScope === defaultScope
        ? getEscalatedRepairScope(defaultScope) ?? null
        : defaultScope
      : defaultScope;

    if (!requestedScope) {
      setChatError('Auto-repair stopped after the same root cause persisted through escalation. Use Fix with LLM after adjusting the script or make a broader manual change.');
      return;
    }

    autoRepairAttemptCountsRef.current.set(sessionKey, {
      attempts: (sessionState?.attempts ?? 0) + 1,
      lastScope: requestedScope,
    });

    void doSend(buildRepairPromptFromLiveState({
      ...request,
      diagnostics,
      requestedRepairScope: requestedScope,
      rootCauseKey: primaryRootCause?.rootCauseKey,
    }), {
      intent: 'repair',
      repairDiagnostics: diagnostics,
      requestedRepairScope: requestedScope,
      rootCauseKey: primaryRootCause?.rootCauseKey,
    });
  };

  // ── Core send logic ──
  const doSend = useCallback(async (text: string, options?: ChatSendOptions) => {
    if (!text.trim() || status === 'streaming' || status === 'sending') return;
    if (!canUseAiAssistant) {
      setChatError('AI assistant is available with Desktop Pro.');
      return;
    }

    const continuationBase = options?.continuationBase;
    const responseIntent = options?.intent ?? 'create';
    if (responseIntent !== 'repair') {
      autoRepairAttemptCountsRef.current.clear();
    }
    const liveState = useViewerStore.getState();
    const currentMessages = responseIntent === 'repair'
      ? pruneMessagesForRepair(liveState.chatMessages)
      : liveState.chatMessages;
    const liveScriptContext = {
      content: liveState.scriptEditorContent,
      revision: liveState.scriptEditorRevision,
      selection: liveState.scriptEditorSelection,
    };
    const liveDiagnostics = liveState.scriptLastDiagnostics;
    const effectiveDiagnostics = options?.repairDiagnostics ?? liveDiagnostics;
    const primaryRootCause = options?.rootCauseKey
      ? { rootCauseKey: options.rootCauseKey, repairScope: options.requestedRepairScope ?? 'local' }
      : getPrimaryRootCause(effectiveDiagnostics);
    setLastFinishReason(null);

    const activeModelInfo = getModelById(activeModel);
    const supportsImages = activeModelInfo?.supportsImages ?? false;
    const supportsFileAttachments = activeModelInfo?.supportsFileAttachments ?? true;
    const filtered = filterAttachmentsForModel(attachments, supportsImages, supportsFileAttachments);
    const droppedAttachmentWarnings: string[] = [];
    if (filtered.droppedImages > 0) {
      droppedAttachmentWarnings.push('image attachments');
    }
    if (filtered.droppedFiles > 0) {
      droppedAttachmentWarnings.push('file attachments');
    }
    if (droppedAttachmentWarnings.length > 0) {
      setChatError(
        `Selected model does not support ${droppedAttachmentWarnings.join(' and ')}. Unsupported attachments were skipped.`,
      );
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text.trim(),
      createdAt: Date.now(),
      attachments: filtered.accepted.length > 0 ? [...filtered.accepted] : undefined,
    };
    addMessage(userMessage);
    setInputText('');
    setChatStatus('sending');
    setUserScrolledUp(false);

    // Reset textarea height
    resizeInput();

    // Check for auto-captured viewport screenshot to include
    const pendingViewportScreenshot = useViewerStore.getState().chatViewportScreenshot;
    if (pendingViewportScreenshot) {
      useViewerStore.getState().setChatViewportScreenshot(null);
    }
    let viewportScreenshot: string | null = null;
    if (pendingViewportScreenshot && supportsImages) {
      // Normalize legacy/uncompressed screenshots before attaching.
      const normalized = await compressDataUrlImage(pendingViewportScreenshot);
      if (normalized.length <= MAX_INLINE_IMAGE_DATA_URL_CHARS) {
        viewportScreenshot = normalized;
      } else {
        setChatError('Auto-captured screenshot was too large and was skipped.');
      }
    }

    const allMessages = [...currentMessages, userMessage];

    const modelContext = getModelContext();
    const fileAttachments = supportsFileAttachments
      ? collectActiveFileAttachments(allMessages, filtered.accepted)
      : [];
    const systemPrompt = buildSystemPrompt(modelContext, fileAttachments, {
      content: liveScriptContext.content,
      revision: liveScriptContext.revision,
      selection: liveScriptContext.selection,
    }, {
      userPrompt: text.trim(),
      diagnostics: effectiveDiagnostics,
    });
    const contextWindow = activeModelInfo?.contextWindow ?? 128_000;
    const inputBudget = Math.max(
      MIN_INPUT_BUDGET,
      Math.floor(contextWindow * INPUT_BUDGET_RATIO) - OUTPUT_TOKEN_RESERVE,
    );

    let compactedMessages = [...allMessages];
    let droppedMessages: ChatMessage[] = [];
    let streamBuild = buildStreamMessagesForModel(compactedMessages, viewportScreenshot, supportsImages);
    let streamMessages = streamBuild.messages;
    let estimatedInputTokens = estimateTextTokens(systemPrompt) + estimateMessagesTokens(streamMessages);

    while (estimatedInputTokens > inputBudget && compactedMessages.length > 2) {
      const dropCount = Math.min(4, Math.max(1, compactedMessages.length - 2));
      droppedMessages = [...droppedMessages, ...compactedMessages.slice(0, dropCount)];
      compactedMessages = compactedMessages.slice(dropCount);
      if (compactedMessages.length > MAX_RECENT_MESSAGES) {
        const over = compactedMessages.length - MAX_RECENT_MESSAGES;
        droppedMessages = [...droppedMessages, ...compactedMessages.slice(0, over)];
        compactedMessages = compactedMessages.slice(over);
      }
      streamBuild = buildStreamMessagesForModel(compactedMessages, viewportScreenshot, supportsImages);
      streamMessages = streamBuild.messages;
      estimatedInputTokens = estimateTextTokens(systemPrompt) + estimateMessagesTokens(streamMessages);
    }

    if (streamBuild.droppedInlineImages > 0 || streamBuild.droppedViewportScreenshot) {
      setChatError(
        'Selected model does not support image input. Screenshot/image payload was omitted.',
      );
    }

    if (droppedMessages.length > 0) {
      const summary = summarizeDroppedMessages(droppedMessages);
      if (summary) {
        const summaryMessage = {
          role: 'system' as const,
          content: `Conversation summary of earlier turns (for continuity only):\n${summary}`,
        };
        streamMessages = [summaryMessage, ...streamMessages];
        estimatedInputTokens = estimateTextTokens(systemPrompt) + estimateMessagesTokens(streamMessages);
      }
    }

    if (estimatedInputTokens > inputBudget && import.meta.env.DEV) {
      console.info('[llm-budget]', {
        model: activeModel,
        contextWindow,
        inputBudget,
        estimatedInputTokens,
        droppedMessages: droppedMessages.length,
      });
    }

    const abortController = new AbortController();
    setChatAbortController(abortController);
    useViewerStore.getState().beginAssistantScriptTurn();

    let accumulated = '';
    const responseBaseRevision = liveScriptContext.revision;
    const responseBaseContent = liveScriptContext.content;
    const editParseOptions = {
      baseRevision: responseBaseRevision,
      baseContent: responseBaseContent,
      intent: responseIntent,
      requestedRepairScope: options?.requestedRepairScope ?? primaryRootCause?.repairScope,
      targetRootCause: options?.rootCauseKey ?? primaryRootCause?.rootCauseKey,
    } as const;
    const responseEditState = {
      intent: responseIntent,
      appliedOpIds: new Set<string>(),
      acceptedOps: [] as ReturnType<typeof extractScriptEditOps>['operations'],
      appliedAny: false,
      applyFailed: false,
      fallbackApplied: false,
      rolledBack: false,
      applyFailureStatus: null as null | 'revision_conflict' | 'range_error' | 'semantic_error' | 'parse_error',
      applyFailureError: null as string | null,
      applyFailureDiagnostic: null as ReturnType<typeof useViewerStore.getState>['scriptLastDiagnostics'][number] | null,
    };
    let pendingAttachmentsCleared = attachments.length === 0;

    const clearPendingAttachmentsOnce = () => {
      if (pendingAttachmentsCleared) return;
      clearAttachments();
      pendingAttachmentsCleared = true;
    };

    const rollbackAssistantTurnIfNeeded = () => {
      if (responseEditState.rolledBack || !responseEditState.appliedAny) return;
      useViewerStore.getState().rollbackAssistantScriptTurn();
      responseEditState.appliedAny = false;
      responseEditState.fallbackApplied = false;
      responseEditState.rolledBack = true;
    };

    const commitAssistantTurn = () => {
      if (!responseEditState.rolledBack) {
        useViewerStore.getState().commitAssistantScriptTurn();
      }
    };

    // ── Shared stream callbacks ──
    const handleChunk = (chunk: string) => {
        clearPendingAttachmentsOnce();
        accumulated += chunk;
        if (!responseEditState.applyFailed && responseEditState.intent !== 'repair') {
          const parsed = extractScriptEditOps(accumulated, editParseOptions);
          const freshOps = filterUnappliedScriptOps(parsed.operations, responseEditState.appliedOpIds);
          if (freshOps.length > 0) {
            const applyResult = useViewerStore.getState().applyScriptEditOps(freshOps, {
              acceptedBaseRevision: responseBaseRevision,
              baseContentSnapshot: responseBaseContent,
              priorAcceptedOps: responseEditState.acceptedOps,
              intent: responseEditState.intent,
            });
            if (applyResult.ok) {
              applyResult.appliedOpIds.forEach((id) => responseEditState.appliedOpIds.add(id));
              responseEditState.acceptedOps.push(...freshOps);
              responseEditState.appliedAny = true;
              useViewerStore.getState().setScriptPanelVisible(true);
            } else {
              rollbackAssistantTurnIfNeeded();
              responseEditState.applyFailed = true;
              responseEditState.applyFailureStatus = applyResult.status === 'ok' ? 'semantic_error' : (applyResult.status ?? 'semantic_error');
              responseEditState.applyFailureError = applyResult.error ?? 'unknown error';
              responseEditState.applyFailureDiagnostic = applyResult.diagnostic ?? null;
              setChatError(
                applyResult.status === 'revision_conflict'
                  ? `Incremental edit apply hit a revision conflict: ${applyResult.error ?? 'unknown error'}`
                  : `Incremental edit apply failed: ${applyResult.error ?? 'unknown error'}`,
              );
            }
          }
        }
        setChatStatus('streaming');
        updateStreaming(accumulated);
    };
    const handleComplete = (fullText: string) => {
        clearPendingAttachmentsOnce();
        const normalizedText = continuationBase
          ? stripContinuationOverlap(continuationBase, fullText)
          : fullText;
        const messageId = finalizeAssistant(normalizedText || fullText);

        if (!responseEditState.applyFailed) {
          const parsed = extractScriptEditOps(fullText, editParseOptions);
          if (parsed.parseErrors.length > 0) {
            if (responseEditState.intent === 'repair') {
              rollbackAssistantTurnIfNeeded();
              responseEditState.applyFailed = true;
              responseEditState.applyFailureDiagnostic = parsed.parseDiagnostics[0] ?? createPatchDiagnostic(
                'patch_semantic_error',
                parsed.parseErrors[0],
                'error',
                {
                  failureKind: 'parse_error',
                  fixHint: 'Return exactly one valid `ifc-script-edits` block for the current script revision and do not mix it with a `js` fence.',
                },
              );
            }
            responseEditState.applyFailureStatus = 'parse_error';
            responseEditState.applyFailureError = parsed.parseErrors[0];
            setChatError(parsed.parseErrors[0]);
          }
          const canApplyCompletedOps = !(responseEditState.intent === 'repair' && parsed.parseErrors.length > 0);
          const freshOps = canApplyCompletedOps
            ? filterUnappliedScriptOps(parsed.operations, responseEditState.appliedOpIds)
            : [];
          if (freshOps.length > 0) {
            const applyResult = useViewerStore.getState().applyScriptEditOps(freshOps, {
              acceptedBaseRevision: responseBaseRevision,
              baseContentSnapshot: responseBaseContent,
              priorAcceptedOps: responseEditState.acceptedOps,
              intent: responseEditState.intent,
            });
            if (applyResult.ok) {
              applyResult.appliedOpIds.forEach((id) => responseEditState.appliedOpIds.add(id));
              responseEditState.acceptedOps.push(...freshOps);
              responseEditState.appliedAny = true;
              useViewerStore.getState().setScriptPanelVisible(true);
            } else {
              rollbackAssistantTurnIfNeeded();
              responseEditState.applyFailed = true;
              responseEditState.applyFailureStatus = applyResult.status === 'ok' ? 'semantic_error' : (applyResult.status ?? 'semantic_error');
              responseEditState.applyFailureError = applyResult.error ?? 'unknown error';
              responseEditState.applyFailureDiagnostic = applyResult.diagnostic ?? null;
              setChatError(
                applyResult.status === 'revision_conflict'
                  ? `Incremental edit apply hit a revision conflict: ${applyResult.error ?? 'unknown error'}`
                  : `Incremental edit apply failed: ${applyResult.error ?? 'unknown error'}`,
              );
            }
          }
        }

        if (!responseEditState.appliedAny && !responseEditState.applyFailed && canUsePlainCodeBlockFallback(responseEditState.intent)) {
          const blocks = extractCodeBlocks(fullText);
          if (blocks.length > 0) {
            const lastBlock = blocks[blocks.length - 1];
            const fallbackResult = useViewerStore.getState().replaceScriptContentFallback(lastBlock.code, {
              intent: responseEditState.intent,
              source: 'code_block_fallback',
            });
            if (fallbackResult.ok) {
              useViewerStore.getState().setScriptPanelVisible(true);
              responseEditState.fallbackApplied = true;
            } else {
              responseEditState.applyFailed = true;
              responseEditState.applyFailureStatus = fallbackResult.status === 'ok' ? 'semantic_error' : (fallbackResult.status ?? 'semantic_error');
              responseEditState.applyFailureError = fallbackResult.error ?? 'unknown error';
              responseEditState.applyFailureDiagnostic = fallbackResult.diagnostic ?? null;
              setChatError(`Full-script apply blocked: ${fallbackResult.error ?? 'unknown error'}`);
            }
          }
        }

        // Auto-execute if enabled
        const autoExec = useViewerStore.getState().chatAutoExecute;
        if (autoExec) {
          if (responseEditState.appliedAny || responseEditState.fallbackApplied) {
            const currentCode = useViewerStore.getState().scriptEditorContent;
            if (currentCode.trim()) {
              void (async () => {
                const result = await execute(currentCode);
                if (!result) {
                  const { scriptLastError, scriptLastDiagnostics, chatStatus } = useViewerStore.getState();
                  if (
                    scriptLastError &&
                    scriptLastError.startsWith('Preflight validation failed:') &&
                    chatStatus !== 'sending' &&
                    chatStatus !== 'streaming'
                  ) {
                    triggerAutoRepair({
                      error: scriptLastError,
                      diagnostics: scriptLastDiagnostics,
                      reason: 'preflight',
                    });
                  }
                }
              })();
            }
          } else if (!responseEditState.applyFailed && responseEditState.intent !== 'repair') {
            const blocks = extractCodeBlocks(fullText);
            if (blocks.length > 0) {
              const lastBlock = blocks[blocks.length - 1];
              useViewerStore.getState().setCodeExecResult(
                messageId,
                lastBlock.index,
                { status: 'running' },
              );
            }
          }
        }

        if (responseEditState.applyFailureStatus === 'revision_conflict') {
          const {
            chatStatus,
          } = useViewerStore.getState();
          if (chatStatus !== 'sending' && chatStatus !== 'streaming') {
            triggerAutoRepair({
              error: responseEditState.applyFailureError ?? 'Patch revision conflict.',
              diagnostics: responseEditState.applyFailureDiagnostic ? [responseEditState.applyFailureDiagnostic] : [],
              reason: 'patch-conflict',
            });
          }
        } else if (responseEditState.intent === 'repair' && responseEditState.applyFailed) {
          const {
            chatStatus,
          } = useViewerStore.getState();
          if (chatStatus !== 'sending' && chatStatus !== 'streaming') {
            triggerAutoRepair({
              error: responseEditState.applyFailureError ?? 'Patch apply failed.',
              diagnostics: responseEditState.applyFailureDiagnostic ? [responseEditState.applyFailureDiagnostic] : [],
              reason: 'patch-apply',
            });
          }
        }

        commitAssistantTurn();
    };
    const handleUsageInfo = (info: UsageInfo) => {
        setChatUsage(info);
    };
    const handleFinishReason = (reason: string | null) => {
        setLastFinishReason(reason);
        if (reason === 'length') {
          setChatError('Response reached output limit. Click Continue to resume.');
        }
    };
    const handleError = (err: Error) => {
        setChatError(err.message);
        setChatAbortController(null);
        commitAssistantTurn();
    };

    // Route to direct provider streaming for BYOK models, or through the proxy for free models
    const resolvedModelInfo = getModelById(activeModel);
    const modelSource = resolvedModelInfo?.source ?? 'proxy';
    const currentApiKeys = getApiKeys();

    if (modelSource === 'anthropic' && !currentApiKeys.anthropicKey) {
      setChatError('Enter your Anthropic API key above to use this model.');
      setChatStatus('idle');
      setChatAbortController(null);
      commitAssistantTurn();
      return;
    }
    if (modelSource === 'openai' && !currentApiKeys.openaiKey) {
      setChatError('Enter your OpenAI API key above to use this model.');
      setChatStatus('idle');
      setChatAbortController(null);
      commitAssistantTurn();
      return;
    }

    if (modelSource === 'anthropic' && currentApiKeys.anthropicKey) {
      await streamAnthropicChat(currentApiKeys.anthropicKey, {
        model: activeModel,
        messages: streamMessages,
        system: systemPrompt,
        signal: abortController.signal,
        onChunk: handleChunk,
        onComplete: handleComplete,
        onFinishReason: handleFinishReason,
        onError: handleError,
      });
    } else if (modelSource === 'openai' && currentApiKeys.openaiKey) {
      await streamOpenAiChat(currentApiKeys.openaiKey, {
        model: activeModel,
        messages: streamMessages,
        system: systemPrompt,
        signal: abortController.signal,
        onChunk: handleChunk,
        onComplete: handleComplete,
        onFinishReason: handleFinishReason,
        onError: handleError,
      });
    } else {
      await streamChat({
        proxyUrl: PROXY_URL,
        model: activeModel,
        messages: streamMessages,
        system: systemPrompt,
        signal: abortController.signal,
        onChunk: handleChunk,
        onComplete: handleComplete,
        onFinishReason: handleFinishReason,
        onError: handleError,
        onUsageInfo: handleUsageInfo,
      });
    }

    if (abortController.signal.aborted) {
      commitAssistantTurn();
      const currentState = useViewerStore.getState();
      if (currentState.chatAbortController === abortController) {
        setChatStatus('idle');
        setChatAbortController(null);
      }
    }
  }, [
    canUseAiAssistant, status, activeModel, attachments,
    addMessage, setChatStatus, updateStreaming, finalizeAssistant,
    setChatError, setChatAbortController, clearAttachments, setChatUsage, resizeInput,
    buildRepairPromptFromLiveState, triggerAutoRepair, execute,
  ]);

  const handleSend = useCallback(() => {
    if (!canUseAiAssistant) {
      promptAiUpgrade();
      return;
    }
    doSend(inputText);
  }, [canUseAiAssistant, doSend, inputText, promptAiUpgrade]);

  // Allow other panels (e.g. ScriptPanel errors) to trigger a chat repair turn.
  useEffect(() => {
    if (!pendingPrompt) return;
    if (status === 'sending' || status === 'streaming') return;
    consumePendingPrompt();
    const intent: ScriptMutationIntent | undefined = (
      pendingPrompt.startsWith('The script needs a root-cause repair.')
      || pendingPrompt.startsWith('The script needs a targeted fix.')
    )
      ? 'repair'
      : undefined;
    void doSend(pendingPrompt, { intent });
  }, [pendingPrompt, status, consumePendingPrompt, doSend]);

  useEffect(() => {
    if (!pendingRepairRequest) return;
    if (status === 'sending' || status === 'streaming') return;
    consumePendingRepairRequest();
    void doSend(buildRepairPromptFromLiveState(pendingRepairRequest), {
      intent: 'repair',
      repairDiagnostics: pendingRepairRequest.diagnostics,
      requestedRepairScope: pendingRepairRequest.requestedRepairScope,
      rootCauseKey: pendingRepairRequest.rootCauseKey,
    });
  }, [pendingRepairRequest, status, consumePendingRepairRequest, buildRepairPromptFromLiveState, doSend]);

  const handleContinue = useCallback(() => {
    if (!canUseAiAssistant) {
      promptAiUpgrade();
      return;
    }
    const state = useViewerStore.getState();
    const partial = state.chatStreamingContent.trim();
    const lastAssistant = [...state.chatMessages].reverse().find((m) => m.role === 'assistant');
    const continuationBase = partial || lastAssistant?.content || '';
    if (!continuationBase) return;

    // Preserve the partial completion in history, then request continuation.
    if (partial) {
      finalizeAssistant(partial);
    }
    setChatError(null);
    doSend(CONTINUE_PROMPT, { continuationBase });
  }, [canUseAiAssistant, doSend, finalizeAssistant, promptAiUpgrade, setChatError]);

  const handleStop = useCallback(() => {
    const controller = useViewerStore.getState().chatAbortController;
    if (controller) {
      controller.abort();
      const partial = useViewerStore.getState().chatStreamingContent;
      if (partial) {
        finalizeAssistant(partial);
      } else {
        setChatStatus('idle');
        setChatAbortController(null);
      }
    }
  }, [finalizeAssistant, setChatStatus, setChatAbortController]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // ── Error feedback (Fix this) ──
  const handleFixError = useCallback((code: string, errorMsg: string) => {
    if (!canUseAiAssistant) {
      promptAiUpgrade();
      return;
    }
    const diagnostics = useViewerStore.getState().scriptLastDiagnostics;
    const liveCode = useViewerStore.getState().scriptEditorContent;
    const staleCode = code.trim() !== liveCode.trim() ? code : undefined;
    void doSend(buildRepairPromptFromLiveState({
      error: errorMsg,
      diagnostics,
      staleCodeBlock: staleCode,
      reason: 'runtime',
    }), {
      intent: 'repair',
      repairDiagnostics: diagnostics,
      requestedRepairScope: getPrimaryRootCause(diagnostics)?.repairScope,
      rootCauseKey: getPrimaryRootCause(diagnostics)?.rootCauseKey,
    });
  }, [buildRepairPromptFromLiveState, canUseAiAssistant, doSend, promptAiUpgrade]);

  // ── Clickable example prompts ──
  const handleExampleClick = useCallback((prompt: string) => {
    setInputText(prompt);
    inputRef.current?.focus();
  }, []);

  // ── Clear with confirmation ──
  const handleClearClick = useCallback(() => {
    if (messages.length <= 2) {
      resetScriptEditorForNewChat();
      clearMessages();
      setInputText('');
      setLastFinishReason(null);
    } else {
      setShowClearConfirm(true);
    }
  }, [messages.length, clearMessages, resetScriptEditorForNewChat]);

  const confirmClear = useCallback(() => {
    resetScriptEditorForNewChat();
    clearMessages();
    setInputText('');
    setLastFinishReason(null);
    setShowClearConfirm(false);
  }, [clearMessages, resetScriptEditorForNewChat]);

  // ── File upload (button + drag-drop + paste) ──
  const processFiles = useCallback(async (files: FileList | File[]) => {
    if (!canUseAiAssistant) {
      promptAiUpgrade();
      return;
    }
    const model = getModelById(activeModel);
    const supportsImages = model?.supportsImages ?? false;
    const supportsFileAttachments = model?.supportsFileAttachments ?? true;
    let remainingSlots = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - attachments.length);

    for (const file of Array.from(files)) {
      if (remainingSlots <= 0) {
        setChatError(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`);
        break;
      }
      try {
        // Handle image files
        if (file.type.startsWith('image/')) {
          if (!supportsImages) {
            setChatError('Selected model does not support image input. Switch model to attach images.');
            continue;
          }
          if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
            setChatError(`Image attachments must be smaller than ${Math.round(MAX_IMAGE_ATTACHMENT_BYTES / 1_000_000)} MB.`);
            continue;
          }
          const base64 = await imageFileToCompressedBase64(file);
          if (base64.length > MAX_INLINE_IMAGE_DATA_URL_CHARS) {
            setChatError('Image attachment is still too large after compression. Please use a smaller image.');
            continue;
          }
          const attachment: FileAttachment = {
            id: createAttachmentId(),
            name: file.name,
            type: 'image/jpeg',
            size: Math.round((base64.length * 3) / 4),
            imageBase64: base64,
            isImage: true,
          };
          addAttachment(attachment);
          remainingSlots -= 1;
          continue;
        }
        // Only accept text-based files
        if (!file.name.match(/\.(csv|json|txt|tsv)$/i)) continue;
        if (!supportsFileAttachments) {
          setChatError('Selected model does not support file attachments. Switch model to attach files.');
          continue;
        }
        if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
          setChatError(`Text attachments must be smaller than ${Math.round(MAX_TEXT_ATTACHMENT_BYTES / 1024)} KB.`);
          continue;
        }
        const text = await file.text();
        const attachment: FileAttachment = {
          id: createAttachmentId(),
          name: file.name,
          type: file.type || 'text/plain',
          size: file.size,
          textContent: text,
        };
        if (file.name.endsWith('.csv') || file.name.endsWith('.tsv')) {
          const { columns, rows } = parseCSV(text);
          attachment.csvColumns = columns;
          attachment.csvData = rows;
        }
        addAttachment(attachment);
        remainingSlots -= 1;
      } catch (error) {
        setChatError(`Could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [activeModel, addAttachment, attachments.length, canUseAiAssistant, promptAiUpgrade, setChatError]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    await processFiles(files);
    e.target.value = '';
  }, [processFiles]);

  // Drag and drop handlers
  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      await processFiles(files);
    }
  }, [processFiles]);

  // ── Paste handler for images ──
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }

    if (imageFiles.length > 0) {
      e.preventDefault();
      await processFiles(imageFiles);
    }
  }, [processFiles]);

  const isActive = status === 'streaming' || status === 'sending';
  const modelForUi = getModelById(activeModel);
  const modelSupportsImages = modelForUi?.supportsImages ?? false;
  const modelSupportsFiles = modelForUi?.supportsFileAttachments ?? true;
  const attachmentAccept = [
    modelSupportsFiles ? '.csv,.json,.txt,.tsv' : '',
    modelSupportsImages ? 'image/*' : '',
  ].filter(Boolean).join(',');
  const canAttachInput = modelSupportsFiles || modelSupportsImages;
  // Detect when selected model needs a missing BYOK key (reactive state, not raw reads)
  const modelSource = modelForUi?.source ?? 'proxy';
  const needsAnthropicKey = modelSource === 'anthropic' && !keyStateAnthropic;
  const needsOpenaiKey = modelSource === 'openai' && !keyStateOpenai;
  const needsByokKey = needsAnthropicKey || needsOpenaiKey;
  const showSupportEmail = Boolean(error && error.includes('louis@ltplus.com'));
  const canContinue = Boolean(
    !isActive && (streamingContent.trim().length > 0 || lastFinishReason === 'length'),
  );
  return (
    <div
      className="h-full flex flex-col bg-background relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-blue-500/10 border-2 border-dashed border-blue-500 rounded-md flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-blue-500">
            <Paperclip className="h-8 w-8" />
            <span className="text-sm font-medium">Drop files or images</span>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-b shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleClearClick}
              disabled={messages.length === 0}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Clear</TooltipContent>
        </Tooltip>

        <ModelSelector />
        <div className="flex-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setAutoExecute(!autoExecute)}
              className={autoExecute ? 'text-amber-500' : ''}
            >
              <Zap className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Auto-run: {autoExecute ? 'ON' : 'OFF'}</TooltipContent>
        </Tooltip>

        {onClose && (
          <Button variant="ghost" size="icon-xs" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {!canUseAiAssistant && (
        <div className="border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          AI assistant requires Desktop Pro. Core viewing and scripting stay available without it.
        </div>
      )}

      {/* Inline BYOK key prompt — shown when user picks a model without the matching key */}
      {needsByokKey && canUseAiAssistant && (
        <InlineKeyPrompt provider={needsAnthropicKey ? 'anthropic' : 'openai'} />
      )}

      {/* Clear confirmation */}
      {showClearConfirm && (
        <div className="px-3 py-2 bg-destructive/5 border-b flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Clear {messages.length} messages?</span>
          <Button
            variant="destructive"
            size="sm"
            onClick={confirmClear}
            className="h-5 px-2 text-xs"
          >
            Clear
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowClearConfirm(false)}
            className="h-5 px-2 text-xs"
          >
            Cancel
          </Button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto relative" ref={scrollRef}>
        {/* Empty state */}
        {messages.length === 0 && !streamingContent && (
          <div className="flex flex-col justify-end h-full px-3 pb-2">
            <p className="text-xs text-muted-foreground/60 mb-2">Try something:</p>
            <div className="flex flex-col gap-1">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => handleExampleClick(prompt)}
                  className="text-xs text-left px-2.5 py-1.5 rounded border border-transparent hover:border-border hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message list */}
        {messages.map((msg) => (
          <ChatMessageComponent
            key={msg.id}
            message={msg}
            onFixError={handleFixError}
          />
        ))}

        {/* Streaming assistant response */}
        {streamingContent && (
          <ChatMessageComponent
            message={{
              id: 'streaming',
              role: 'assistant',
              content: streamingContent,
              createdAt: Date.now(),
              codeBlocks: extractCodeBlocks(streamingContent),
            }}
            isStreaming
          />
        )}

        {/* Sending indicator */}
        {status === 'sending' && (
          <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="text-xs">Thinking...</span>
          </div>
        )}
      </div>

      {/* Scroll to bottom button */}
      {showScrollBtn && (
        <div className="absolute bottom-[120px] right-4 z-20">
          <Button
            variant="outline"
            size="icon-xs"
            onClick={scrollToBottom}
            className="rounded-full shadow-md bg-background"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="px-3 py-1.5 bg-destructive/10 text-destructive text-xs border-t flex items-center justify-between gap-2">
          <span>{error}</span>
          <div className="flex items-center gap-2">
            {canContinue && (
              <Button
                variant="outline"
                size="sm"
                className="h-5 px-2 text-[10px]"
                onClick={handleContinue}
              >
                Continue
              </Button>
            )}
            {showSupportEmail && (
              <a className="underline text-[10px]" href="mailto:louis@ltplus.com">
                Contact support
              </a>
            )}
          </div>
        </div>
      )}

      {/* Attachments preview */}
      {attachments.length > 0 && (
        <div className="px-2 py-1 border-t flex flex-wrap gap-1">
          {attachments.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-muted text-xs"
            >
              {a.isImage ? (
                <>
                  {a.imageBase64 && (
                    <img
                      src={a.imageBase64}
                      alt={a.name}
                      className="h-6 w-6 object-cover rounded"
                    />
                  )}
                  <ImageIcon className="h-3 w-3" />
                </>
              ) : (
                <Paperclip className="h-3 w-3" />
              )}
              {a.name}
              <button
                className="ml-0.5 hover:text-destructive"
                onClick={() => removeAttachment(a.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input area */}
      <div className="shrink-0 border-t p-2">
        <div className="flex items-end gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept={attachmentAccept}
            multiple
            onChange={handleFileUpload}
            className="hidden"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => fileInputRef.current?.click()}
                disabled={!canAttachInput || !canUseAiAssistant}
                className="shrink-0 mb-0.5"
              >
                <Paperclip className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {!canUseAiAssistant
                ? 'AI assistant not available'
                : canAttachInput
                ? 'Attach file or image (paste, drag & drop)'
                : 'Selected model does not support attachments'}
            </TooltipContent>
          </Tooltip>

          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => {
              setInputText(e.target.value);
              resizeInput();
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={!canUseAiAssistant ? 'AI assistant not available' : needsByokKey ? `Enter your ${needsAnthropicKey ? 'Anthropic' : 'OpenAI'} API key above` : 'Ask anything...'}
            rows={1}
            className="flex-1 resize-none rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground px-3 py-1.5 text-sm min-h-[32px] max-h-[120px] focus:outline-none focus:ring-1 focus:ring-ring"
            style={{ height: 'auto', overflow: 'hidden' }}
            disabled={!canUseAiAssistant || needsByokKey}
          />

          {isActive ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleStop}
                  className="shrink-0 mb-0.5"
                >
                  <Square className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Stop generating</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="default"
                  size="icon-xs"
                  onClick={handleSend}
                  disabled={!inputText.trim() || !canUseAiAssistant || needsByokKey}
                  className="shrink-0 mb-0.5"
                >
                  <Send className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Send (Enter)</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="flex items-center justify-between mt-1 px-0.5">
          {isActive ? (
            <span className="text-[10px] text-muted-foreground/50">Streaming...</span>
          ) : displayUsage ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1.5 cursor-default">
                  <div className="w-12 h-1 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${displayUsage.pct >= 90 ? 'bg-destructive' : displayUsage.pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500'
                        }`}
                      style={{ width: `${Math.min(100, displayUsage.pct)}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground/40 tabular-nums">{displayUsage.pct}%</span>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                {displayUsage.type === 'credits'
                  ? `${displayUsage.used}/${displayUsage.limit} credits · resets ${usageResetLabel}`
                  : `${displayUsage.used}/${displayUsage.limit} requests · resets ${usageResetLabel}`
                }
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-[10px] text-muted-foreground/40">Shift+Enter new line</span>
          )}
          <span className="text-[10px] text-muted-foreground/30">⌘L</span>
        </div>
      </div>
    </div>
  );
}

// ── Inline BYOK key prompt (shown inside chat panel when key is missing) ──

const PROVIDER_INFO = {
  anthropic: {
    label: 'Anthropic',
    placeholder: 'sk-ant-api03-...',
    url: 'https://console.anthropic.com/settings/keys',
    urlLabel: 'console.anthropic.com',
  },
  openai: {
    label: 'OpenAI',
    placeholder: 'sk-...',
    url: 'https://platform.openai.com/api-keys',
    urlLabel: 'platform.openai.com',
  },
} as const;

function InlineKeyPrompt({ provider }: { provider: 'anthropic' | 'openai' }) {
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);
  const info = PROVIDER_INFO[provider];

  const handleSave = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (provider === 'anthropic') {
      updateApiKeys({ anthropicKey: trimmed });
    } else {
      updateApiKeys({ openaiKey: trimmed });
    }
    setSaved(true);
  }, [value, provider]);

  // Brief success state before the parent unmounts this component
  if (saved) {
    return (
      <div className="border-b bg-emerald-500/10 px-3 py-2 flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400">
        <Check className="h-3.5 w-3.5" />
        <span>{info.label} key saved — ready to chat</span>
      </div>
    );
  }

  return (
    <div className="border-b bg-muted/30 px-3 py-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <Key className="h-3.5 w-3.5" />
        {info.label} API key required
      </div>
      <p className="text-[11px] text-muted-foreground">
        Paste your key below — stored in your browser only, sent directly to {info.label}.{' '}
        <a href={info.url} target="_blank" rel="noopener noreferrer" className="underline inline-flex items-center gap-0.5">
          Get a key <ExternalLink className="h-2.5 w-2.5" />
        </a>
      </p>
      <div className="flex gap-1.5">
        <div className="relative flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
            placeholder={info.placeholder}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded border border-input bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring pr-7"
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {show ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          </button>
        </div>
        <Button size="sm" className="h-7 px-3 text-xs" onClick={handleSave} disabled={!value.trim()}>
          Save
        </Button>
      </div>
    </div>
  );
}
