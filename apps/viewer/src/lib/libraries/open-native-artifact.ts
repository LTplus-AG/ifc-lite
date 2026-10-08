/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import type { ExtensionHostService } from '@/services/extensions/host';
import { nativeLibraryCatalogue, type LibraryArtifact, type ProfileLibrary } from './native-catalogue';
import { sameReportEvidence } from '../flow/report-provenance';
import { loadIdsContent } from '@/hooks/ids/loadIdsContent';
import { setValidationSourceChoice } from '../validation/validation-source-choice';
import { useLibraryFocus } from './library-focus';
import { useSavedComparisonFocus } from '../panels/evidence-focus';

export type LibraryOpenOutcome = 'opened' | 'missing' | 'changed' | 'busy' | 'unsaved' | 'unavailable';
/** Resolve afresh at the action boundary; opening never runs/applies the saved artifact (#7235). */
export async function openNativeLibraryArtifact(target: LibraryArtifact, host: ExtensionHostService | null): Promise<LibraryOpenOutcome> {
  let profiles: ProfileLibrary = { phase: 'unavailable', entries: [] };
  if (target.kind === 'profile') {
    if (!host) return 'unavailable';
    try { profiles = { phase: 'ready', entries: await host.flavors.list(), owner: host }; }
    catch (error) { console.warn('[Libraries] Native profile library could not be read', error); return 'unavailable'; }
  }
  const state = useViewerStore.getState();
  const live = nativeLibraryCatalogue(state, profiles).flatMap(group => group.rows)
    .find(row => row.kind === target.kind && row.id === target.id);
  if (!live) return 'missing';
  if (live.owner !== target.owner || !sameReportEvidence(live.record, target.record)) return 'changed';
  switch (target.kind) {
    case 'flow':
      if (state.flowRunning) return 'busy';
      if (state.flowDirty) return 'unsaved';
      state.openFlow(target.id);
      break;
    case 'script':
      if (state.scriptExecutionState === 'running') return 'busy';
      if (state.scriptEditorDirty) return 'unsaved';
      state.setActiveScriptId(target.id);
      break;
    case 'document': state.setActiveDocumentId(target.id); break;
    case 'list':
      if (state.listExecuting) return 'busy';
      if (state.pendingListDraft) return 'unsaved';
      state.setActiveListId(target.id);
      break;
    case 'lens':
      state.setPendingArtifactEditor({ kind: 'lens', id: target.id });
      break;
    case 'check': {
      if (state.idsLoading) return 'busy';
      const definition = state.validationDefinitions.entries.find(entry => entry.id === target.id);
      if (!definition) return 'missing';
      if (definition.kind === 'ids') await loadIdsContent(useViewerStore, definition.xml, definition.id);
      else state.selectValidationDefinition(definition.id);
      if (useViewerStore.getState().validationDefinitions.active[definition.kind] !== target.id) return 'unavailable';
      setValidationSourceChoice(definition.kind);
      break;
    }
    case 'topic': state.setActiveTopic(target.id); break;
    case 'comparison-report': useSavedComparisonFocus.setState({ record: { comparisonId: target.id, key: '' } }); break;
    case 'profile': state.setFlavorDialogRequested(true); break;
    case 'validation-report':
    case 'clash-report':
      // Their native immutable history/management views consume this exact id.
      break;
  }
  useLibraryFocus.setState({ target: { kind: target.kind, id: target.id } });
  state.openWorkspacePanel(target.panel);
  return 'opened';
}
