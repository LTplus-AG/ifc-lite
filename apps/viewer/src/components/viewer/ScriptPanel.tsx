/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ScriptPanel — Code editor + output console + optional AI chat side panel.
 *
 * Uses CodeMirror 6 for the code editor with bim.* autocomplete.
 * Connects to the QuickJS sandbox via useSandbox() and displays results
 * in a log console. AI chat is integrated as a collapsible side panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import {
  Play,
  Save,
  Plus,
  Trash2,
  X,
  ChevronDown,
  FileCode2,
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  Info,
  AlertTriangle,
  Bot,
  PanelRightClose,
  PanelRightOpen,
  Undo2,
  Redo2,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/toast';
import { buildDesktopUpgradeUrl, hasDesktopFeatureAccess } from '@/lib/desktop-product';
import { cn, formatDuration } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { useSandbox } from '@/hooks/useSandbox';
import { SCRIPT_TEMPLATES } from '@/lib/scripts/templates';
import { navigateToPath } from '@/services/app-navigation';
import { CodeEditor } from './CodeEditor';
import { ChatPanel } from './ChatPanel';
import { PromoteToolDialog } from '@/components/extensions/PromoteToolDialog';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import type { LogEntry } from '@/store/slices/scriptSlice';

interface ScriptPanelProps {
  onClose?: () => void;
}

/** Consolidated script state selector — single subscription instead of 14 */
function useScriptState() {
  const editorContent = useViewerStore((s) => s.scriptEditorContent);
  const setEditorContent = useViewerStore((s) => s.setScriptEditorContent);
  const executionState = useViewerStore((s) => s.scriptExecutionState);
  const lastResult = useViewerStore((s) => s.scriptLastResult);
  const lastError = useViewerStore((s) => s.scriptLastError);
  const savedScripts = useViewerStore((s) => s.savedScripts);
  const activeScriptId = useViewerStore((s) => s.activeScriptId);
  const editorDirty = useViewerStore((s) => s.scriptEditorDirty);
  const createScript = useViewerStore((s) => s.createScript);
  const saveActiveScript = useViewerStore((s) => s.saveActiveScript);
  const deleteScript = useViewerStore((s) => s.deleteScript);
  const setActiveScriptId = useViewerStore((s) => s.setActiveScriptId);
  const deleteConfirmId = useViewerStore((s) => s.scriptDeleteConfirmId);
  const setDeleteConfirmId = useViewerStore((s) => s.setScriptDeleteConfirmId);
  const setScriptCursorContext = useViewerStore((s) => s.setScriptCursorContext);
  const registerScriptEditorApplyAdapter = useViewerStore((s) => s.registerScriptEditorApplyAdapter);
  const scriptCanUndo = useViewerStore((s) => s.scriptCanUndo);
  const scriptCanRedo = useViewerStore((s) => s.scriptCanRedo);
  const setScriptHistoryState = useViewerStore((s) => s.setScriptHistoryState);
  const undoScriptEditor = useViewerStore((s) => s.undoScriptEditor);
  const redoScriptEditor = useViewerStore((s) => s.redoScriptEditor);
  const queueChatRepairRequest = useViewerStore((s) => s.queueChatRepairRequest);
  const chatToolReady = useViewerStore((s) => s.chatToolReady);
  const setChatToolReady = useViewerStore((s) => s.setChatToolReady);

  return {
    editorContent,
    setEditorContent,
    executionState,
    lastResult,
    lastError,
    savedScripts,
    activeScriptId,
    editorDirty,
    createScript,
    saveActiveScript,
    deleteScript,
    setActiveScriptId,
    deleteConfirmId,
    setDeleteConfirmId,
    setScriptCursorContext,
    registerScriptEditorApplyAdapter,
    scriptCanUndo,
    scriptCanRedo,
    setScriptHistoryState,
    undoScriptEditor,
    redoScriptEditor,
    queueChatRepairRequest,
    chatToolReady,
    setChatToolReady,
  };
}

export function ScriptPanel({ onClose }: ScriptPanelProps) {
  const {
    editorContent,
    setEditorContent,
    executionState,
    lastResult,
    lastError,
    savedScripts,
    activeScriptId,
    editorDirty,
    createScript,
    saveActiveScript,
    deleteScript,
    setActiveScriptId,
    deleteConfirmId,
    setDeleteConfirmId,
    setScriptCursorContext,
    registerScriptEditorApplyAdapter,
    scriptCanUndo,
    scriptCanRedo,
    setScriptHistoryState,
    undoScriptEditor,
    redoScriptEditor,
    queueChatRepairRequest,
    chatToolReady,
    setChatToolReady,
  } = useScriptState();

  const { execute, reset } = useSandbox();
  const extensionHost = useOptionalExtensionHost();
  const [outputCollapsed, setOutputCollapsed] = useState(false);
  const chatPanelVisible = useViewerStore((s) => s.chatPanelVisible);
  const setChatPanelVisible = useViewerStore((s) => s.setChatPanelVisible);
  const desktopEntitlement = useViewerStore((s) => s.desktopEntitlement);
  const canUseAiAssistant = hasDesktopFeatureAccess(desktopEntitlement, 'ai_assistant');

  // Chat panel width (px) — resizable via drag handle
  const [chatWidth, setChatWidth] = useState(380);
  const chatDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const cleanupChatDragRef = useRef<(() => void) | null>(null);

  // Open chat by default when script panel mounts
  useEffect(() => {
    try {
      if (canUseAiAssistant && localStorage.getItem('ifc-lite-chat-panel-visible') === null) {
        setChatPanelVisible(true);
      }
    } catch {
      if (canUseAiAssistant) {
        setChatPanelVisible(true);
      }
    }
    return () => { cleanupChatDragRef.current?.(); };
  }, [canUseAiAssistant, setChatPanelVisible]);

  useEffect(() => {
    if (!canUseAiAssistant && chatPanelVisible) {
      setChatPanelVisible(false);
    }
  }, [canUseAiAssistant, chatPanelVisible, setChatPanelVisible]);

  const promptAiUpgrade = useCallback(() => {
    toast.info('AI assistant is available with Desktop Pro');
    navigateToPath(buildDesktopUpgradeUrl());
  }, []);

  const handleChatResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    chatDragRef.current = { startX: e.clientX, startWidth: chatWidth };

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!chatDragRef.current) return;
      const delta = chatDragRef.current.startX - moveEvent.clientX;
      const newWidth = Math.min(700, Math.max(240, chatDragRef.current.startWidth + delta));
      setChatWidth(newWidth);
    };

    const cleanup = () => {
      chatDragRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      cleanupChatDragRef.current = null;
    };

    const onMouseUp = () => { cleanup(); };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    cleanupChatDragRef.current = cleanup;
  }, [chatWidth]);

  const activeScript = useMemo(
    () => savedScripts.find((s) => s.id === activeScriptId),
    [savedScripts, activeScriptId],
  );

  const deleteConfirmScript = useMemo(
    () => (deleteConfirmId ? savedScripts.find((s) => s.id === deleteConfirmId) : null),
    [savedScripts, deleteConfirmId],
  );

  const handleRun = useCallback(async () => {
    if (executionState === 'running') return;
    const startedAt = performance.now();
    await execute(editorContent);
    extensionHost?.emitAction('script.execute', {
      templateId: activeScriptId ?? undefined,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }, [execute, editorContent, executionState, extensionHost, activeScriptId]);

  const handleSave = useCallback(() => {
    if (activeScriptId) {
      saveActiveScript();
    } else {
      createScript('Untitled Script');
    }
  }, [activeScriptId, saveActiveScript, createScript]);

  const handleNew = useCallback((name: string, code?: string) => {
    createScript(name, code);
  }, [createScript]);

  const [promoteOpen, setPromoteOpen] = useState(false);
  const canPromote = !!extensionHost && editorContent.trim().length > 0;

  const handleDeleteConfirm = useCallback(() => {
    if (deleteConfirmId) {
      deleteScript(deleteConfirmId);
    }
  }, [deleteConfirmId, deleteScript]);

  const handleFixWithLlm = useCallback(() => {
    if (!lastError) return;
    if (!canUseAiAssistant) {
      promptAiUpgrade();
      return;
    }
    setChatPanelVisible(true);
    const state = useViewerStore.getState();
    queueChatRepairRequest({
      error: lastError,
      diagnostics: state.scriptLastDiagnostics,
      reason: lastError.startsWith('Preflight validation failed:') ? 'preflight' : 'runtime',
    });
  }, [canUseAiAssistant, lastError, promptAiUpgrade, queueChatRepairRequest, setChatPanelVisible]);

  const toggleChat = useCallback(() => {
    if (!canUseAiAssistant) {
      promptAiUpgrade();
      return;
    }
    setChatPanelVisible(!chatPanelVisible);
  }, [canUseAiAssistant, chatPanelVisible, promptAiUpgrade, setChatPanelVisible]);

  return (
    <div className="h-full flex bg-background">
      {/* Left side: Script editor + output */}
      <div className={cn('flex flex-col min-w-0', chatPanelVisible ? 'flex-1' : 'w-full')}>
        {/* Header */}
        <div className="flex items-center gap-1 px-2 py-1.5 border-b shrink-0">
          <FileCode2 className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate">
            {activeScript ? activeScript.name : 'Script Editor'}
            {editorDirty && <span className="text-muted-foreground ml-1">*</span>}
          </span>
          <div className="flex-1" />

          {/* Script selector dropdown */}
          {savedScripts.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs">
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {savedScripts.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onClick={() => setActiveScriptId(s.id)}
                    className={cn(s.id === activeScriptId && 'bg-accent')}
                  >
                    <FileCode2 className="h-3.5 w-3.5 mr-2" />
                    {s.name}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                {activeScriptId && (
                  <DropdownMenuItem
                    onClick={() => setDeleteConfirmId(activeScriptId)}
                    className="text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* AI Chat toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={chatPanelVisible ? 'default' : 'ghost'}
                size="icon-xs"
                onClick={toggleChat}
                className={cn(canUseAiAssistant && chatPanelVisible && 'bg-blue-500 hover:bg-blue-600 text-white')}
              >
                <Bot className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{canUseAiAssistant ? (chatPanelVisible ? 'Hide AI Chat' : 'Show AI Chat') : 'Desktop Pro required for AI Chat'}</TooltipContent>
          </Tooltip>

          {onClose && (
            <Button variant="ghost" size="icon-xs" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {/* Post-authoring "install as tool" banner — surfaces right
            where the AI-written code lands so the user never has to
            hunt for the Promote button. Highlighted (accent fill +
            ring) so the install step reads as the obvious next move,
            not a faint afterthought. */}
        {chatToolReady?.kind === 'script' && (
          <div className="shrink-0 border-b bg-primary/15 px-3 py-2.5 ring-1 ring-inset ring-primary/40">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Wrench className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold">This script is ready</div>
                <div className="text-[11px] text-muted-foreground">
                  Install it as a one-click button in your toolbar.
                </div>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  setPromoteOpen(true);
                  setChatToolReady(null);
                }}
                className="shrink-0"
              >
                <Wrench className="mr-1 h-3.5 w-3.5" />
                Install as tool
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => setChatToolReady(null)}
                aria-label="Dismiss"
                className="shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        {/* Toolbar */}
        <div className="flex items-center gap-1 px-2 py-1 border-b shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="default"
                size="sm"
                onClick={handleRun}
                disabled={executionState === 'running'}
                className="gap-1"
              >
                <Play className="h-3.5 w-3.5" />
                Run
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run script (Ctrl+Enter)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={handleSave}>
                <Save className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Save (Ctrl+S)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setPromoteOpen(true)}
                disabled={!canPromote}
                aria-label="Promote script to a persistent tool"
              >
                <Sparkles className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Promote to a persistent tool</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={undoScriptEditor}
                disabled={!scriptCanUndo}
              >
                <Undo2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={redoScriptEditor}
                disabled={!scriptCanRedo}
              >
                <Redo2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Redo (Ctrl+Shift+Z)</TooltipContent>
          </Tooltip>

          {/* New script dropdown with templates */}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs">
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>New script</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => handleNew('Untitled Script')}>
                <FileCode2 className="h-3.5 w-3.5 mr-2" />
                Blank Script
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {SCRIPT_TEMPLATES.map((t) => (
                <DropdownMenuItem key={t.name} onClick={() => handleNew(t.name, t.code)}>
                  <FileCode2 className="h-3.5 w-3.5 mr-2" />
                  {t.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={reset}>
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reset sandbox</TooltipContent>
          </Tooltip>

          {/* Status indicator */}
          <div className="flex-1" />
          {executionState === 'running' && (
            <span className="text-xs text-muted-foreground animate-pulse">Running...</span>
          )}
          {executionState === 'success' && lastResult && (
            <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" />
              {formatDuration(lastResult.durationMs)}
            </span>
          )}
          {executionState === 'error' && (
            <span className="text-xs text-destructive flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              Error
            </span>
          )}
        </div>

        {/* Code Editor */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <CodeEditor
            value={editorContent}
            onChange={setEditorContent}
            onSelectionChange={setScriptCursorContext}
            onHistoryChange={setScriptHistoryState}
            registerApplyAdapter={registerScriptEditorApplyAdapter}
            onRun={handleRun}
            onSave={handleSave}
            className="h-full"
          />
        </div>

        {/* Output Console */}
        <div className="shrink-0 border-t">
          {/* Output header */}
          <button
            className="flex items-center gap-1.5 px-2 py-1 w-full hover:bg-muted/50 transition-colors text-left"
            onClick={() => setOutputCollapsed(!outputCollapsed)}
          >
            <ChevronDown
              className={cn('h-3 w-3 transition-transform', outputCollapsed && '-rotate-90')}
            />
            <span className="text-xs font-medium text-muted-foreground">Output</span>
            {lastResult && lastResult.logs.length > 0 && (
              <span className="text-xs text-muted-foreground">({lastResult.logs.length})</span>
            )}
          </button>

          {!outputCollapsed && (
            <ScrollArea className="h-[140px]">
              <div className="px-2 pb-2 font-mono text-xs space-y-0.5">
                {/* Error message */}
                {lastError && (
                  <div className="flex items-start gap-1.5 text-destructive">
                    <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <span className="whitespace-pre-wrap break-all">{lastError}</span>
                      {/* Sandbox-globals hint — when the error names a
                          browser-context API the sandbox doesn't expose,
                          surface a one-line cue so the user understands
                          why the rewrite is needed before clicking Fix. */}
                      {/(document|window|navigator|location|fetch|XMLHttpRequest|localStorage|indexedDB|setTimeout|setInterval) is not defined/.test(lastError) && (
                        <div className="mt-1 text-[11px] text-muted-foreground font-sans">
                          Scripts run in a QuickJS sandbox — no DOM, no <code className="font-mono">fetch</code>, no browser globals.
                          Use <code className="font-mono">bim.*</code> APIs for viewer / data / export side-effects.
                        </div>
                      )}
                      <div className="mt-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-xs border-destructive/40 text-destructive bg-transparent hover:bg-destructive/10"
                          onClick={handleFixWithLlm}
                        >
                          {canUseAiAssistant ? 'Fix with LLM' : 'Upgrade for AI Fix'}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Log entries */}
                {lastResult?.logs.map((log, i) => (
                  <MemoizedLogLine key={i} log={log} />
                ))}

                {/* Return value */}
                {lastResult && lastResult.value !== undefined && lastResult.value !== null && (
                  <div className="text-muted-foreground mt-1 pt-1 border-t border-border/50">
                    <span className="opacity-60">Return: </span>
                    <span className="text-foreground">
                      {typeof lastResult.value === 'object'
                        ? JSON.stringify(lastResult.value, null, 2)
                        : String(lastResult.value)}
                    </span>
                  </div>
                )}

                {/* Empty state */}
                {!lastError && !lastResult && (
                  <div className="text-muted-foreground py-2 text-center">
                    Press Run or Ctrl+Enter to execute
                  </div>
                )}
              </div>
            </ScrollArea>
          )}
        </div>
      </div>

      {/* Right side: AI Chat panel (collapsible, resizable) */}
      {chatPanelVisible && (
        <>
          <div
            className="w-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors cursor-col-resize shrink-0 h-full"
            onMouseDown={handleChatResizeStart}
          />
          <div style={{ width: chatWidth }} className="shrink-0 h-full min-w-0">
            <ChatPanel onClose={() => setChatPanelVisible(false)} />
          </div>
        </>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={deleteConfirmId !== null} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Delete Script</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{deleteConfirmScript?.name ?? 'this script'}&rdquo;?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteConfirmId(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteConfirm}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {promoteOpen && extensionHost && (
        <PromoteToolDialog
          open={promoteOpen}
          source={editorContent}
          initialName={
            savedScripts.find((s) => s.id === activeScriptId)?.name
            ?? 'My tool'
          }
          onClose={() => setPromoteOpen(false)}
        />
      )}
    </div>
  );
}

/** Format a log entry's args into a display string */
function formatLogArgs(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === 'object' && a !== null) {
      try {
        return JSON.stringify(a, null, 2);
      } catch {
        return String(a);
      }
    }
    return String(a);
  }).join(' ');
}

/** Render a single log entry with appropriate icon and color — memoized */
const MemoizedLogLine = memo(function LogLine({ log }: { log: LogEntry }) {
  const formatted = useMemo(() => formatLogArgs(log.args), [log.args]);

  switch (log.level) {
    case 'error':
      return (
        <div className="flex items-start gap-1.5 text-destructive">
          <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap break-all">{formatted}</span>
        </div>
      );
    case 'warn':
      return (
        <div className="flex items-start gap-1.5 text-yellow-600 dark:text-yellow-400">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap break-all">{formatted}</span>
        </div>
      );
    case 'info':
      return (
        <div className="flex items-start gap-1.5 text-blue-600 dark:text-blue-400">
          <Info className="h-3 w-3 mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap break-all">{formatted}</span>
        </div>
      );
    default:
      return (
        <div className="flex items-start gap-1.5">
          <span className="whitespace-pre-wrap break-all">{formatted}</span>
        </div>
      );
  }
});
