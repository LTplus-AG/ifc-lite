/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SaveResult } from '@/lib/scripts/persistence';
import { useViewerStore } from '@/store';
import { emptySchema } from './contract';
import { modelCoordination, coordination, textSchema, idSchema } from './coordination-common';
export const coordinationScriptSessionOperations = [
  coordination('script.read', 'Inspect saved scripts, active source/revision, native execution state, diagnostics and terminal results.', ['read'], emptySchema, () => {
    const s = useViewerStore.getState(); return { saved: s.savedScripts, active_id: s.activeScriptId, source: s.scriptEditorContent, revision: s.scriptEditorRevision,
      execution_state: s.scriptExecutionState, run_epoch: s.scriptRunEpoch, result: s.scriptLastResult, error: s.scriptLastError, diagnostics: s.scriptLastDiagnostics };
  }),
  coordination('script.preflight', 'Check supplied source with the exact native script preflight diagnostics without executing or granting sandbox capabilities.', ['read'], textSchema, async i => {
    const { validateScriptPreflightDetailed } = await import('@/lib/llm/script-preflight'); return { diagnostics: validateScriptPreflightDetailed(i.value) };
  }),
  coordination<{ source: string; expected_revision: number }>('script.replace', 'Replace editor source through its native revision-aware semantic edit path. Does not execute source or widen sandbox permissions.', ['configuration'], {
    type: 'object', properties: { source: { type: 'string', maxLength: 1000000 }, expected_revision: { type: 'integer', minimum: 0 } }, required: ['source', 'expected_revision'], additionalProperties: false,
  }, (i: { source: string; expected_revision: number }, c) => c.commit(() => {
    const s = useViewerStore.getState(); if (s.scriptEditorRevision !== i.expected_revision) throw new Error('Script editor revision changed; refresh before replacing.');
    const result = s.replaceScriptContentFallback(i.source); if (!result.ok) throw new Error(result.error ?? 'Native script edit refused.');
    return { ...result, revision: useViewerStore.getState().scriptEditorRevision };
  })),
  modelCoordination<{ source: string; timeout_ms: number; memory_bytes: number }>('script.analyze', 'Run source in a fresh native QuickJS sandbox with query-only permissions and bounded time/heap. Returns actual terminal value/logs after deterministic teardown; cancellation disposes the VM.', ['read'], {
    type: 'object', properties: { source: { type: 'string', maxLength: 1000000 }, timeout_ms: { type: 'integer', minimum: 1, maximum: 30000 }, memory_bytes: { type: 'integer', minimum: 1048576, maximum: 67108864 } }, required: ['source', 'timeout_ms', 'memory_bytes'], additionalProperties: false,
  }, async (i, c) => {
    const inputs = useViewerStore.getState();
    const { analyzeViewerScript } = await import('@/lib/scripts/viewer-sandbox'); c.checkpoint?.();
    const result = await analyzeViewerScript(c.model.bim, i.source, { timeoutMs: i.timeout_ms, memoryBytes: i.memory_bytes }, c.signal); c.checkpoint?.();
    const live = useViewerStore.getState(); if (live.models !== inputs.models || live.mutationVersion !== inputs.mutationVersion || live.geometryContentVersion !== inputs.geometryContentVersion) throw new Error('Model inputs changed during sandbox analysis.'); return result;
  }),
  coordination('script.save', 'Save the active script through native persistence.', ['configuration'], emptySchema, (_, c) => c.commit(() => {
    const s = useViewerStore.getState(); if (!s.activeScriptId) throw new Error('No active saved script.'); const storage = s.saveActiveScript(); return { active_id: s.activeScriptId, dirty: useViewerStore.getState().scriptEditorDirty, storage }; 
  })),
  coordination<{ name: string; source: string }>('script.create', 'Create a saved native script without executing it.', ['configuration'], {
    type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, source: { type: 'string', maxLength: 1000000 } }, required: ['name', 'source'], additionalProperties: false,
  }, (i, c) => c.commit(() => {
    let storage: SaveResult | undefined; const id = useViewerStore.getState().createScript(i.name, i.source, result => { storage = result; });
    if (!id) throw new Error('Native script size or count limit exceeded.'); return { id, storage };
  })),
  coordination('script.open', 'Open an existing saved script using the native editor lifecycle.', ['configuration'], idSchema, (i, c) => c.commit(() => {
    const s = useViewerStore.getState(); if (!s.savedScripts.some(script => script.id === i.id)) throw new Error('Unknown saved script.');
    s.setActiveScriptId(i.id); return { active_id: useViewerStore.getState().activeScriptId, revision: useViewerStore.getState().scriptEditorRevision };
  })),
  coordination<{ id: string; name: string }>('script.rename', 'Rename a known saved native script.', ['configuration'], {
    type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 200 }, name: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['id', 'name'], additionalProperties: false,
  }, (i, c) => c.commit(() => {
    const s = useViewerStore.getState(); if (!s.savedScripts.some(script => script.id === i.id)) throw new Error('Unknown saved script.'); const storage = s.renameScript(i.id, i.name); return { id: i.id, name: i.name, storage: storage ?? null }; 
  })),
  coordination('script.delete', 'Delete one saved script through its native lifecycle; this does not execute any source.', ['configuration'], idSchema, (i, c) => c.commit(() => {
    const s = useViewerStore.getState(); if (!s.savedScripts.some(script => script.id === i.id)) throw new Error('Unknown saved script.'); const storage = s.deleteScript(i.id); return { deleted: i.id, storage }; 
  })),
  coordination('script.undo', 'Undo through the native mounted editor history. Refuses absent editor hosts instead of claiming a silent undo.', ['configuration'], emptySchema, (_, c) => c.commit(() => {
    const state = useViewerStore.getState(); if (!state.scriptEditorApplyAdapter) throw new Error('The script editor must be mounted to access its native history.');
    const changed = state.scriptCanUndo; if (changed) state.undoScriptEditor(); return { changed, revision: useViewerStore.getState().scriptEditorRevision };
  })),
  coordination('script.redo', 'Redo through the native mounted editor history. Refuses absent editor hosts instead of claiming a silent redo.', ['configuration'], emptySchema, (_, c) => c.commit(() => {
    const state = useViewerStore.getState(); if (!state.scriptEditorApplyAdapter) throw new Error('The script editor must be mounted to access its native history.');
    const changed = state.scriptCanRedo; if (changed) state.redoScriptEditor(); return { changed, revision: useViewerStore.getState().scriptEditorRevision };
  })),
  coordination('collab.read', 'Inspect session status, role, seed phase and peer presence without exposing room bearer/share tokens.', ['read'], emptySchema, () => {
    const s = useViewerStore.getState(); return { status: s.collabStatus, room_id: s.collabRoomId, role: s.collabRole, peers: s.collabPeers,
      connecting: s.collabConnecting, seed_phase: s.collabSeedPhase, seed_progress: s.collabSeedProgress, seed_failure: s.collabSeedFailure, geometry_notice: s.collabGeometryNotice };
  }),
  coordination('collab.leave', 'Leave the current native room and run its complete local teardown. Does not delete a remote room.', ['configuration'], emptySchema, (_, c) => c.commit(() => {
    useViewerStore.getState().stopCollab(); return { status: useViewerStore.getState().collabStatus };
  })),
  coordination('assistant.read', 'Read the native evidence assistant conversation, terminal messages, streaming status, evidence id and root budget without exposing provider credentials.', ['read'], emptySchema, async () => {
    const { useAssistant } = await import('@/lib/assistant/conversation'); const s = useAssistant.getState();
    return { messages: s.messages, status: s.status, model: useViewerStore.getState().chatActiveModel, error: s.error, evidence_id: s.snapshot?.id ?? s.archived?.id ?? null, budget: s.budget, output: s.output };
  }),
  coordination('assistant.cancel', 'Cancel the native evidence assistant request through its provider AbortController and conversation lifecycle.', ['configuration'], emptySchema, async (_, c) => {
    const { useAssistant, cancelAssistant } = await import('@/lib/assistant/conversation');
    return c.commit(() => { const active = !!useAssistant.getState().controller; cancelAssistant(); return { cancellation_requested: active, terminal: false }; });
  }),
  coordination('assistant.model', 'Set the assistant model through native entitlement coercion.', ['configuration'], textSchema, (i, c) => c.commit(() => {
    useViewerStore.getState().setChatActiveModel(i.value); return { model: useViewerStore.getState().chatActiveModel };
  })),
];
