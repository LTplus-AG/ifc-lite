/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Original DBL/DPP pilot contract, independent of any confidential or normative draft. */
export const PROFILE_ID = 'https://example.org/ifc-lite/semantic-pilot/v1';
export const VOCAB = 'https://example.org/ifc-lite/semantic-pilot#';
export const RESOURCE_TYPES = ['Building', 'Logbook', 'Installation', 'Product', 'Passport', 'Inspection'] as const;
export type ResourceType = typeof RESOURCE_TYPES[number];
export interface SemanticResource {
  id: string;
  type: ResourceType;
  label: string;
  buildingId?: string;
  productId?: string;
  passportId?: string;
  installationId?: string;
  evidenceId?: string;
  replacesId?: string;
  dictionaryUri?: string;
  GlobalId?: string;
  modelRevision?: string;
  granularity?: 'model' | 'batch' | 'item';
  fireRating?: string;
}
export interface SemanticDocument {
  profile: typeof PROFILE_ID;
  source: string;
  completeness: 'complete' | 'partial';
  resources: SemanticResource[];
}
export interface ValidationFinding {
  engine: 'JSON Schema' | 'SHACL' | 'links';
  resourceId: string;
  path: string;
  message: string;
}
export interface EntityAddress { modelId: string; expressId: number }
export interface LiveEntity extends EntityAddress { GlobalId: string }
export type Resolution =
  | { status: 'resolved'; ref: EntityAddress }
  | { status: 'ambiguous'; candidates: EntityAddress[] }
  | { status: 'unmatched' | 'unscoped' | 'external' | 'invalid' };
export interface RdfBinding {
  type: 'uri' | 'literal' | 'bnode';
  value: string;
  datatype?: string;
  'xml:lang'?: string;
}
export interface SparqlResults { columns: string[]; rows: Record<string, RdfBinding>[] }
export interface BindingMapping {
  id: string; type: string; label: string; GlobalId: string; modelRevision: string;
}
