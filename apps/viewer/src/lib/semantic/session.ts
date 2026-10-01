import { create } from 'zustand';
import type { SemanticDocument, SparqlResults, ValidationFinding } from './types';

interface SemanticSession {
  document?: SemanticDocument;
  results?: SparqlResults;
  graph: string;
  findings: ValidationFinding[];
  revisions: Map<string, string>;
  setDocument: (document: SemanticDocument) => void;
  setResults: (results: SparqlResults | undefined) => void;
  setGraph: (graph: string) => void;
  setFindings: (findings: ValidationFinding[]) => void;
  setRevisions: (revisions: Map<string, string>) => void;
}
/** In-memory session only: panel switches retain records; no endpoint credentials are stored. */
export const useSemanticSession = create<SemanticSession>(set => ({
  graph: '', findings: [], revisions: new Map(),
  setDocument: document => set({ document }), setResults: results => set({ results }),
  setGraph: graph => set({ graph }), setFindings: findings => set({ findings }),
  setRevisions: revisions => set({ revisions }),
}));
