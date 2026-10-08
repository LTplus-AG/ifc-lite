/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Flavor } from '@ifc-lite/extensions';
import type { ViewerState } from '@/store';
import type { WorkspacePanelId } from '../panels/registry';
import { definitionTitle } from '../validation/definition-library';
import type { ContentStatus } from '../storage/content-library';

/** Existing native libraries, not another persisted copy of their artifacts (#7235). */
export const LIBRARY_FAMILIES = ['checks', 'reports', 'topics', 'documents', 'flows', 'scripts', 'lists', 'lenses', 'profiles'] as const;
export type LibraryFamily = typeof LIBRARY_FAMILIES[number];
export type LibraryKind = 'check' | 'validation-report' | 'comparison-report' | 'clash-report' | 'topic'
  | 'document' | 'flow' | 'script' | 'list' | 'lens' | 'profile';
export interface LibraryArtifact {
  kind: LibraryKind;
  family: LibraryFamily;
  id: string;
  name: string;
  panel: WorkspacePanelId;
  /** The actual native record observed when listing; used to refuse replaced targets. */
  record: object;
  /** Native loaded-project/host namespace; a repeated record id does not cross owners. */
  owner?: object;
}
export interface LibraryGroup {
  family: LibraryFamily;
  phase: 'loading' | 'ready' | 'unavailable' | 'session';
  /** Native warnings remain distinct from a truly empty library. */
  warning?: string;
  rows: LibraryArtifact[];
}
export interface ProfileLibrary { phase: LibraryGroup['phase']; entries: readonly Flavor[]; warning?: string; owner?: object }

export function nativeLibraryCatalogue(state: ViewerState, profiles: ProfileLibrary): LibraryGroup[] {
  const row = (kind: LibraryKind, family: LibraryFamily, id: string, name: string, panel: WorkspacePanelId, record: object): LibraryArtifact =>
    ({ kind, family, id, name, panel, record });
  const status = (storage: ContentStatus): LibraryGroup['phase'] => storage.phase;
  // Reports retain each native library's availability; a failed source cannot
  // make the whole reports family look empty or complete.
  const reports = [state.validationReportsStorage, state.savedComparisonsStorage, state.savedClashReportsStorage];
  const reportsPhase = reports.some(source => source.phase === 'unavailable') ? 'unavailable'
    : reports.some(source => source.phase === 'loading') ? 'loading' : 'ready';
  return [
    { family: 'checks', phase: state.validationDefinitionsError ? 'unavailable' : 'ready',
      warning: state.validationDefinitionsError ?? undefined,
      rows: state.validationDefinitions.entries.map(entry => row('check', 'checks', entry.id, definitionTitle(entry), 'validation', entry)) },
    { family: 'reports', phase: reportsPhase, rows: [
      ...state.savedValidationReports.map(entry => row('validation-report', 'reports', entry.id, entry.name, 'validation', entry)),
      ...state.savedComparisons.map(entry => row('comparison-report', 'reports', entry.id, entry.name, 'compare', entry)),
      ...state.savedClashReports.map(entry => row('clash-report', 'reports', entry.id, entry.name, 'clash', entry)),
    ] },
    { family: 'topics', phase: state.bcfLoading ? 'loading' : state.bcfError ? 'unavailable' : 'ready', warning: state.bcfError ?? undefined,
      rows: [...(state.bcfProject?.topics.values() ?? [])].map(entry => ({ ...row('topic', 'topics', entry.guid, entry.title, 'bcf', entry), owner: state.bcfProject ?? undefined })) },
    { family: 'documents', phase: status(state.documentsStorage),
      rows: state.documents.map(entry => row('document', 'documents', entry.id, entry.name, 'document', entry)) },
    { family: 'flows', phase: state.flowStorageError ? 'unavailable' : 'ready', warning: state.flowStorageError ?? undefined,
      rows: state.savedFlows.map(entry => row('flow', 'flows', entry.doc.id, entry.doc.name, 'flow', entry)) },
    // These native startup readers expose session entries, not a durable-read
    // status. Never turn their fallback [] into a claim that storage is empty.
    { family: 'scripts', phase: 'session', rows: state.savedScripts.map(entry => row('script', 'scripts', entry.id, entry.name, 'script', entry)) },
    { family: 'lists', phase: 'session', rows: state.listDefinitions.map(entry => row('list', 'lists', entry.id, entry.name, 'lists', entry)) },
    { family: 'lenses', phase: 'session', rows: state.savedLenses.map(entry => row('lens', 'lenses', entry.id, entry.name, 'lens', entry)) },
    { family: 'profiles', phase: profiles.phase, warning: profiles.warning,
      rows: profiles.entries.map(entry => ({ ...row('profile', 'profiles', entry.id, entry.name, 'extensions', entry), owner: profiles.owner })) },
  ];
}

/** Name/type matching is independent of the IFC model search and never runs an artifact. */
export function searchNativeLibraries(groups: readonly LibraryGroup[], query: string, family?: LibraryFamily): LibraryArtifact[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return groups.filter(group => !family || group.family === family).flatMap(group => group.rows)
    .filter(row => terms.every(term => `${row.name} ${row.kind} ${row.family}`.toLocaleLowerCase().includes(term)));
}
