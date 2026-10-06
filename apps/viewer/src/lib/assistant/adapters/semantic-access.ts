/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Linked records session as seen by the `semantic` evidence adapter
 * (#6833). The session, its resolver and `@ifc-lite/semantic` (jsonld, n3,
 * SHACL) load only with the lazy Linked records panel chunk; the adapter
 * register is eager. So the panel module hands its session and resolver in
 * here when it loads, and the adapter reads nothing until then: no panel
 * chunk means no session, which is "no records", never a clean result.
 *
 * Type-only imports below are erased and pull nothing into the eager bundle.
 */

import type { IdentityRecord, LiveEntity, Resolution, ResourceIdentityLink, ResourceUriIdentityConfig, SemanticDocument,
  SparqlResults, ValidationFinding, ValidationReport } from '@ifc-lite/semantic';
import type { IdentityFields } from '@/lib/semantic/resolver-context';

/** The session fields evidence reads; credentials, endpoints and grants are not in the session at all. */
export interface SemanticSessionView {
  strategy: string;
  links: ResourceIdentityLink[];
  identityFields: IdentityFields;
  uriConfig: ResourceUriIdentityConfig;
  document?: SemanticDocument;
  results?: SparqlResults;
  graph: string;
  findings: ValidationFinding[];
  report?: ValidationReport;
  revisions: Map<string, string>;
}

export interface SemanticEvidenceAccess {
  session: { getState: () => SemanticSessionView; subscribe: (listener: () => void) => () => void };
  /** The panel's resolver with the session's identity settings. */
  resolve: (resource: IdentityRecord, entities: readonly LiveEntity[], revisions: ReadonlyMap<string, string>) => Resolution;
  /** Effective IfcRoot GlobalIds of every loaded model (edits, created entities and tombstones applied). */
  liveEntities: () => LiveEntity[];
}

let access: SemanticEvidenceAccess | null = null;
let detachSession: (() => void) | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

export function provideSemanticEvidence(next: SemanticEvidenceAccess): void {
  access = next;
  detachSession?.();
  detachSession = next.session.subscribe(notify);
  notify();
}

/** Session changes and the panel chunk arriving, for the source picker's live readiness. */
export function subscribeSemanticEvidence(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function semanticEvidenceAccess(): SemanticEvidenceAccess | null {
  return access;
}
