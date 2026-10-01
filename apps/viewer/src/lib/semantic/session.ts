/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import type { IdentityFields } from './resolver-context';
import { DEFAULT_PROFILE, assertProfile, sanitizeSource, exportWorkspace, importWorkspace, parseProfileDocument,
  type ValidationReport, type BindingMapping, type ResourceIdentityLink, type ProfileDefinition, type SemanticWorkspace, type SemanticDocument, type SparqlResults, type ValidationFinding } from '@ifc-lite/semantic';

interface SemanticSession {
  strategy: string; links: ResourceIdentityLink[]; identityFields: IdentityFields;
  setStrategy: (strategy: string) => void; setLinks: (links: ResourceIdentityLink[]) => void; setIdentityFields: (fields: IdentityFields) => void;
  document?: SemanticDocument; results?: SparqlResults; graph: string; findings: ValidationFinding[]; report?: ValidationReport; dataVersion: number; resultMapping?: BindingMapping;
  profile: ProfileDefinition; retrievedAt?: string; graphFormat: 'text/turtle' | 'application/n-quads'; pendingRevisions: SemanticWorkspace['revisions']; revisions: Map<string, string>; queries: SemanticWorkspace['queries'];
  setDocument: (document: SemanticDocument | undefined) => void;
  setResults: (results: SparqlResults | undefined) => void;
  setResultMapping: (mapping: BindingMapping | undefined) => void;
  setGraph: (graph: string) => void;
  setFindings: (findings: ValidationFinding[]) => void;
  setReport: (report: ValidationReport | undefined) => void;
  setRevisions: (revisions: Map<string, string>) => void;
  setProfile: (profile: ProfileDefinition) => void;
  setRetrievedAt: (retrievedAt: string | undefined) => void;
  setGraphFormat: (format: 'text/turtle' | 'application/n-quads') => void;
  setQueries: (queries: SemanticWorkspace['queries']) => void;
  save: () => string; restore: (serialized: string) => void;
}
const STORAGE_KEY = 'ifc-lite.semantic.workspace.v1';
/** Export portable identities only; endpoint grants, credentials and session addresses never persist. */
export const useSemanticSession = create<SemanticSession>((set, get) => ({
  strategy: 'ifc-global-id', links: [], identityFields: { GlobalId: 'GlobalId', modelRevision: 'modelRevision' },
  setStrategy: strategy => set({ strategy }), setLinks: links => set({ links }), setIdentityFields: identityFields => set({ identityFields }),
  graph: '', findings: [], report: undefined, dataVersion: 0, revisions: new Map(), profile: DEFAULT_PROFILE, queries: [], pendingRevisions: [], graphFormat: 'application/n-quads',
  setDocument: document => set(state => state.document === document ? {} : { document, findings: [], report: undefined, dataVersion: state.dataVersion + 1 }), setResults: results => set({ results }), setResultMapping: resultMapping => set({ resultMapping }),
  setGraph: graph => set(state => state.graph === graph ? {} : { graph, findings: [], report: undefined, dataVersion: state.dataVersion + 1 }), setFindings: findings => set({ findings }),
  setReport: report => set({ report }), setRevisions: revisions => set({ revisions }),
  setProfile: profile => { assertProfile(profile); set(state => ({ profile, document: undefined, findings: [], report: undefined, retrievedAt: undefined, dataVersion: state.dataVersion + 1 })); },
  setRetrievedAt: retrievedAt => set({ retrievedAt }), setGraphFormat: graphFormat => set(state => state.graphFormat === graphFormat ? {} : { graphFormat, findings: [], report: undefined, dataVersion: state.dataVersion + 1 }), setQueries: queries => set({ queries }),
  save() {
    const state = get();
    const workspace = exportWorkspace({ version: 1, queries: state.queries, resourceLinks: state.links, revisions: [...new Set([...state.revisions.keys(), ...state.pendingRevisions.map(link => link.revision), ...state.links.map(link => link.modelRevision)])].map(revision => ({ revision, modelLabel: '' })),
      datasets: [{ id: 'current', source: state.document?.source ?? 'urn:ifc-lite:local', completeness: state.document?.completeness ?? 'partial',
        profileId: state.profile.id, rows: state.results, graph: state.graph || undefined, graphFormat: state.graph ? state.graphFormat : undefined }] });
    const serialized = JSON.stringify({ version: 1, workspace: JSON.parse(workspace) as unknown, profile: state.profile, document: state.document ? { ...parseProfileDocument(state.document, state.profile), source: sanitizeSource(state.document.source) } : undefined, strategy: state.strategy, identityFields: { GlobalId: state.identityFields.GlobalId, modelRevision: state.identityFields.modelRevision } });
    if (new TextEncoder().encode(serialized).length > 5 * 1024 * 1024) throw new Error('Workspace exceeds byte limit');
    localStorage.setItem(STORAGE_KEY, serialized);
    return serialized;
  },
  restore(serialized) {
    if (new TextEncoder().encode(serialized).length > 5 * 1024 * 1024) throw new Error('Workspace exceeds byte limit');
    const raw: unknown = JSON.parse(serialized);
    if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1 || !('workspace' in raw) || !('profile' in raw)) throw new Error('Unsupported viewer workspace');
    assertProfile(raw.profile);
    const imported = importWorkspace(JSON.stringify(raw.workspace));
    const document = 'document' in raw && raw.document !== undefined ? parseProfileDocument(raw.document, raw.profile) : undefined;
    if (document) document.source = sanitizeSource(document.source);
    const dataset = imported.workspace.datasets[0];
    const strategy = 'strategy' in raw && ['ifc-global-id', 'resource-links', 'profile-fields'].includes(String(raw.strategy)) ? String(raw.strategy) : 'ifc-global-id';
    const fields = 'identityFields' in raw ? raw.identityFields : undefined;
    const identityFields = fields && typeof fields === 'object' && 'GlobalId' in fields && typeof fields.GlobalId === 'string'
      && (!('modelRevision' in fields) || typeof fields.modelRevision === 'string') ? { GlobalId: fields.GlobalId, modelRevision: 'modelRevision' in fields ? fields.modelRevision as string : undefined } : { GlobalId: 'GlobalId', modelRevision: 'modelRevision' };
    set({ strategy, identityFields, links: imported.workspace.resourceLinks ?? [], profile: raw.profile, document, results: dataset?.rows, resultMapping: imported.workspace.queries[0]?.mapping, graph: dataset?.graph ?? '', queries: imported.workspace.queries,
      revisions: new Map(), pendingRevisions: imported.workspace.revisions, graphFormat: dataset?.graphFormat ?? 'application/n-quads', findings: [], report: undefined, dataVersion: get().dataVersion + 1, retrievedAt: undefined });
  },
}));
export function savedSemanticWorkspace(): string | null { return localStorage.getItem(STORAGE_KEY); }
