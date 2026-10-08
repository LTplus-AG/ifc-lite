/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Native script mutation remains here; only completed shared requests finalize it (#7093). */
import type { ScriptResult } from '@ifc-lite/sandbox';
import { useViewerStore } from '@/store';
import { stripContinuationOverlap } from '@/components/viewer/chat/chatPanelHelpers';
import { extractCodeBlocks } from './code-extractor';
import { extractScriptEditOps, filterUnappliedScriptOps, type ScriptEditParseOptions } from './script-edit-ops';
import { createPatchDiagnostic } from './script-diagnostics';
import { canUsePlainCodeBlockFallback, type ScriptMutationIntent } from './script-preservation';
import type { ChatRepairRequest } from './types';

interface ScriptResponseOptions {
  responseBaseRevision: number;
  responseBaseContent: string;
  editParseOptions: ScriptEditParseOptions;
  responseIntent: ScriptMutationIntent;
  continuationBase?: string;
  clearPendingAttachmentsOnce: () => void;
  onFirstChunk: () => void;
  execute: (code: string) => Promise<ScriptResult | null>;
  triggerAutoRepair: (request: ChatRepairRequest) => void;
  offerBundle: boolean;
  handleAuthoringResponse: (text: string) => Promise<boolean>;
  ownsRequest: () => boolean;
  ownsTask: () => boolean;
}

export function createScriptResponse(options: ScriptResponseOptions) {
  const { responseBaseRevision, responseBaseContent, editParseOptions, responseIntent,
    continuationBase, clearPendingAttachmentsOnce, onFirstChunk, execute, triggerAutoRepair,
    offerBundle, handleAuthoringResponse, ownsRequest, ownsTask } = options;
  const { finalizeAssistantMessage: finalizeAssistant, setChatError, setChatStatus,
    updateLastAssistantMessage: updateStreaming, setChatToolReady } = useViewerStore.getState();
  let accumulated = '';
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
        if (!ownsRequest()) return;
        onFirstChunk();
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
    const completeTurn = (fullText: string) => {
        if (!ownsRequest()) return;
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

        // Release this native edit transaction before a follow-up can start its own.
        commitAssistantTurn();

        // Auto-execute if enabled
        const autoExec = useViewerStore.getState().chatAutoExecute;
        if (autoExec) {
          if (responseEditState.appliedAny || responseEditState.fallbackApplied) {
            const currentCode = useViewerStore.getState().scriptEditorContent;
            if (currentCode.trim()) {
              void (async () => {
                const result = await execute(currentCode);
                if (!result && ownsTask()) {
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

        // Authoring loop: when the classifier flagged this turn as
        // 'authoring' or 'fork', the response may contain a bundle in
        // the ifc-extension-* fenced format. If it does, surface the
        // bundle CTA. If it doesn't but code landed in the editor,
        // surface the script CTA so "promote to tool" is one click
        // away — the user never has to hunt for the Promote button.
        //
        // Offer the script-path install CTA whenever the assistant
        // produced runnable code this turn — NOT only on authoring-
        // classified turns. The classifier tags follow-up messages
        // ("yes, use Pset_DoorCommon") as one-shot, but that's often
        // the turn where the final code lands. A one-shot script is
        // just as promotable as an "authored" one.
        const offerScriptInstall = () => {
          if (responseIntent === 'repair') return;
          const wroteCode = responseEditState.appliedAny || responseEditState.fallbackApplied;
          const code = useViewerStore.getState().scriptEditorContent;
          const hasRealCode =
            code.trim().length > 0 && !/Write your BIM script here/.test(code);
          if (wroteCode && hasRealCode) {
            setChatToolReady({ kind: 'script', name: '' });
          }
        };

        if (
          offerBundle
        ) {
          // Authoring-classified turn — try the bundle path first; if
          // no bundle was emitted, fall back to the script CTA.
          void handleAuthoringResponse(fullText).then((bundleFound) => {
            if (!ownsTask()) return;
            if (!bundleFound) offerScriptInstall();
          });
        } else {
          offerScriptInstall();
        }

    };
  return { handleChunk, completeTurn, rollbackAssistantTurnIfNeeded, commitAssistantTurn, responseEditState };
}
