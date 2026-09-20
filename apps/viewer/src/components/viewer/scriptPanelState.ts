/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Non-UI state helpers split out of `ScriptPanel.tsx` (#4918 i18n slice) to
 * keep that file under its module-size budget after localizing its JSX.
 * Neither export renders anything, so neither needs `useTranslation()`.
 */
import { useViewerStore } from '@/store';

/** Consolidated script state selector — single subscription instead of 14 */
export function useScriptState() {
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

/** Format a log entry's args into a display string */
export function formatLogArgs(args: unknown[]): string {
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
