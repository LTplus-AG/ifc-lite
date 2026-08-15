/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ExecutableCodeBlock — renders a code block from an LLM response
 * with a "Run" button that executes it in the QuickJS sandbox.
 * Results (logs, return value, errors) appear in a console-like panel.
 * Failed executions show a "Fix this" button that feeds the error
 * back to the LLM for automatic repair.
 *
 * Auto-execute: when the chat sets status to 'running' (via auto-execute toggle),
 * a useEffect triggers actual sandbox execution automatically.
 */

import { memo, useCallback, useState, useEffect, useRef } from 'react';
import {
  Play,
  Copy,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileCode2,
  RefreshCw,
  Terminal,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { resolveChatViewportScreenshot } from './chatViewportCapture.js';
import { useSandbox } from '@/hooks/useSandbox';
import { useViewerStore } from '@/store';
import type { CodeBlock, CodeExecResult } from '@/lib/llm/types';

interface ExecutableCodeBlockProps {
  block: CodeBlock;
  messageId: string;
  result?: CodeExecResult;
  /** Callback to trigger a "fix this" error feedback loop */
  onFixError?: (code: string, error: string) => void;
}

/** Format a log arg for display */
function formatArg(a: unknown): string {
  if (typeof a === 'object' && a !== null) {
    try {
      return JSON.stringify(a, null, 2);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

/** Level prefix for console lines */
function levelPrefix(level: string): string {
  switch (level) {
    case 'error': return '✕';
    case 'warn': return '⚠';
    case 'info': return 'ℹ';
    default: return '›';
  }
}

function captureCompressedCanvasImage(canvas: HTMLCanvasElement): string {
  const maxSide = 1400;
  const srcW = canvas.width || canvas.clientWidth || 0;
  const srcH = canvas.height || canvas.clientHeight || 0;
  if (srcW <= 0 || srcH <= 0) {
    return canvas.toDataURL('image/jpeg', 0.72);
  }

  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const outW = Math.max(1, Math.round(srcW * scale));
  const outH = Math.max(1, Math.round(srcH * scale));
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  if (!ctx) {
    return canvas.toDataURL('image/jpeg', 0.72);
  }
  ctx.drawImage(canvas, 0, 0, outW, outH);
  return out.toDataURL('image/jpeg', 0.72);
}

export const ExecutableCodeBlock = memo(function ExecutableCodeBlock({
  block,
  messageId,
  result,
  onFixError,
}: ExecutableCodeBlockProps) {
  const { execute } = useSandbox();
  const setCodeExecResult = useViewerStore((s) => s.setCodeExecResult);
  const setScriptError = useViewerStore((s) => s.setScriptError);
  const [copied, setCopied] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const autoExecTriggered = useRef(false);
  const copiedResetTimerRef = useRef<number | null>(null);

  const handleRun = useCallback(async () => {
    setCodeExecResult(messageId, block.index, { status: 'running' });

    try {
      const scriptResult = await execute(block.code);
      if (scriptResult) {
        setCodeExecResult(messageId, block.index, {
          status: 'success',
          logs: scriptResult.logs,
          value: scriptResult.value,
          durationMs: scriptResult.durationMs,
        });

        // Auto-capture viewport screenshot if script likely created/modified geometry
        if (block.code.includes('loadIfc') || block.code.includes('bim.create') || block.code.includes('colorize')) {
          // Small delay to let the renderer finish presenting the frame
          setTimeout(() => {
            // Always WRITE the slot, including on failure: it is only cleared
            // when the user sends, so skipping the write would leave the
            // previous run's screenshot attached to a message about this one.
            // See resolveChatViewportScreenshot.
            const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
            useViewerStore.getState().setChatViewportScreenshot(
              resolveChatViewportScreenshot(canvas, captureCompressedCanvasImage),
            );
          }, 500);
        }
      } else {
        // useSandbox sets scriptLastError synchronously before returning null —
        // read it immediately after the await to get the actual error message.
        const { scriptLastError, scriptLastResult } = useViewerStore.getState();
        setCodeExecResult(messageId, block.index, {
          status: 'error',
          error: scriptLastError ?? 'Script execution failed',
          logs: scriptLastResult?.logs,
          durationMs: scriptLastResult?.durationMs,
        });
      }
    } catch (err) {
      setCodeExecResult(messageId, block.index, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [execute, block.code, block.index, messageId, setCodeExecResult]);

  // Auto-execute: when the chat auto-execute toggle triggers a 'running' status
  // before this component has executed, trigger actual execution
  useEffect(() => {
    if (result?.status === 'running' && !autoExecTriggered.current) {
      autoExecTriggered.current = true;
      void handleRun();
    }
    // Reset the flag when result goes back to idle / new result
    if (result?.status !== 'running') {
      autoExecTriggered.current = false;
    }
  }, [result?.status, handleRun]);

  useEffect(() => () => {
    if (copiedResetTimerRef.current !== null) {
      window.clearTimeout(copiedResetTimerRef.current);
    }
  }, []);

  // Auto-scroll console to bottom when new logs appear
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [result?.logs?.length, result?.status]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(block.code);
      setCopied(true);
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current);
      }
      copiedResetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copiedResetTimerRef.current = null;
      }, 2000);
    } catch (error) {
      setScriptError(
        error instanceof Error ? error.message : 'Could not copy code block to clipboard.',
        [],
      );
    }
  }, [block.code, setScriptError]);

  const handleApplyToEditor = useCallback(() => {
    const state = useViewerStore.getState();
    const applyResult = state.applyScriptEditOps([{
      opId: crypto.randomUUID(),
      type: 'replaceSelection',
      baseRevision: state.scriptEditorRevision,
      text: block.code,
    }], {
      intent: 'create',
    });
    if (!applyResult.ok) {
      setScriptError(applyResult.error ?? 'Could not apply code block to the current selection.', applyResult.diagnostic ? [applyResult.diagnostic] : []);
      return;
    }
    setScriptError(null);
    state.setScriptPanelVisible(true);
  }, [block.code, setScriptError]);

  const handleReplaceAllInEditor = useCallback(() => {
    const state = useViewerStore.getState();
    const applyResult = state.replaceScriptContentFallback(block.code, {
      intent: 'explicit_rewrite',
      source: 'manual_replace_all',
    });
    if (!applyResult.ok) {
      setScriptError(applyResult.error ?? 'Could not replace the script with this code block.', applyResult.diagnostic ? [applyResult.diagnostic] : []);
      return;
    }
    setScriptError(null);
    state.setScriptPanelVisible(true);
  }, [block.code, setScriptError]);

  const handleFixError = useCallback(() => {
    if (result?.status === 'error' && result.error && onFixError) {
      onFixError(block.code, result.error);
    }
  }, [block.code, result, onFixError]);

  const isRunning = result?.status === 'running';
  const hasOutput = result && (
    result.status !== 'running' ||
    (result.logs && result.logs.length > 0)
  );
  const hasLogs = result?.logs && result.logs.length > 0;

  return (
    <div className="my-2 rounded-md border bg-muted/30 overflow-hidden">
      {/* Code header with action buttons */}
      <div className="flex items-center gap-1 px-2 py-1 bg-muted/50 border-b">
        <span className="text-[10px] font-mono text-muted-foreground uppercase">
          {block.language || 'js'}
        </span>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={handleCopy}>
              {copied ? <CheckCircle2 className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy code</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={handleApplyToEditor}>
              <FileCode2 className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Apply to selection</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={handleReplaceAllInEditor}>
              All
            </Button>
          </TooltipTrigger>
          <TooltipContent>Replace entire script</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="default"
              size="sm"
              onClick={handleRun}
              disabled={isRunning}
              className="gap-1 h-6 px-2 text-xs"
            >
              {isRunning ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Play className="h-3 w-3" />
              )}
              {isRunning ? 'Running...' : 'Run'}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Execute in sandbox</TooltipContent>
        </Tooltip>
      </div>

      {/* Code content */}
      <pre className="px-3 py-2 text-xs font-mono overflow-x-auto max-h-[300px] overflow-y-auto">
        <code>{block.code}</code>
      </pre>

      {/* Console output panel */}
      {(isRunning || hasOutput) && (
        <div className="border-t">
          {/* Console header */}
          <button
            onClick={() => setConsoleOpen(!consoleOpen)}
            className="flex items-center gap-1.5 w-full px-2 py-1 bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
          >
            {consoleOpen ? (
              <ChevronDown className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" />
            )}
            <Terminal className="h-3 w-3 shrink-0" />
            <span className="text-[10px] font-mono uppercase tracking-wider">Console</span>
            {isRunning && (
              <Loader2 className="h-3 w-3 animate-spin ml-1 text-blue-500" />
            )}
            {result?.status === 'success' && (
              <CheckCircle2 className="h-3 w-3 ml-1 text-emerald-500" />
            )}
            {result?.status === 'error' && (
              <AlertCircle className="h-3 w-3 ml-1 text-destructive" />
            )}
            {result?.durationMs !== undefined && result.status !== 'running' && (
              <span className="text-[10px] font-mono text-muted-foreground/60 ml-auto">
                {result.durationMs}ms
              </span>
            )}
          </button>

          {/* Console body */}
          {consoleOpen && (
            <div className="bg-muted px-2 py-1.5 text-xs font-mono max-h-[200px] overflow-y-auto">
              {/* Running indicator */}
              {isRunning && (!hasLogs) && (
                <div className="flex items-center gap-1.5 text-blue-500 py-0.5">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Executing script...</span>
                </div>
              )}

              {/* Log entries */}
              {hasLogs && result.logs!.map((log, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex items-start gap-1.5 py-0.5 leading-relaxed',
                    log.level === 'error' && 'text-destructive',
                    log.level === 'warn' && 'text-amber-500',
                    log.level === 'info' && 'text-blue-500',
                    log.level === 'log' && 'text-foreground',
                  )}
                >
                  <span className="shrink-0 w-3 text-center opacity-60">{levelPrefix(log.level)}</span>
                  <span className="whitespace-pre-wrap break-all">
                    {log.args.map(formatArg).join(' ')}
                  </span>
                </div>
              ))}

              {/* Error message */}
              {result?.status === 'error' && result.error && (
                <div className="flex items-start gap-1.5 py-0.5 text-destructive">
                  <span className="shrink-0 w-3 text-center">✕</span>
                  <span className="whitespace-pre-wrap break-all">{result.error}</span>
                </div>
              )}

              {/* Return value */}
              {result?.status === 'success' && result.value !== undefined && result.value !== null && (
                <div className="flex items-start gap-1.5 py-0.5 text-emerald-500 border-t border-border mt-1 pt-1">
                  <span className="shrink-0 w-3 text-center opacity-60">←</span>
                  <span className="whitespace-pre-wrap break-all">
                    {typeof result.value === 'object'
                      ? JSON.stringify(result.value, null, 2)
                      : String(result.value)}
                  </span>
                </div>
              )}

              {/* Success footer */}
              {result?.status === 'success' && (
                <div className="flex items-center gap-1 text-emerald-500 border-t border-border mt-1 pt-1">
                  <CheckCircle2 className="h-3 w-3" />
                  <span>Done{result.durationMs !== undefined ? ` in ${result.durationMs}ms` : ''}</span>
                </div>
              )}

              <div ref={consoleEndRef} />
            </div>
          )}

          {/* Error action buttons */}
          {result?.status === 'error' && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 bg-muted border-t border-border">
              {onFixError && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleFixError}
                  className="gap-1 h-6 px-2 text-xs text-destructive border-destructive/30 hover:bg-destructive/10 bg-transparent"
                >
                  <RefreshCw className="h-3 w-3" />
                  Fix this
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleRun}
                className="gap-1 h-6 px-2 text-xs bg-transparent"
              >
                <Play className="h-3 w-3" />
                Re-run
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
