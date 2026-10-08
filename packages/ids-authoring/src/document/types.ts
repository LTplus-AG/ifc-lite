/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Studio document model (02-document-model-and-ops.md §2, ADR-001).
 *
 * `ids` is pure IDS content — the same `IDSDocument` the parser, validator,
 * audit and writer share. Everything Studio-specific lives beside it:
 *
 * - `nodes` gives every node a stable UUID. It MIRRORS the shape of `ids`
 *   (one `SpecNodes` per specification, one `FacetNodes` per applicability
 *   facet and per requirement, one constraint id per present field) rather
 *   than holding positional paths, so a reorder moves the ids along with the
 *   content and no path ever goes stale. `locateNode` derives the
 *   `Uuid → NodePath` direction on demand.
 * - `meta` is the sidecar (`studio.json`).
 *
 * Specification and requirement `id` fields inside `ids` carry the same
 * UUIDs as their nodes, so validator results (which echo those ids) map
 * straight back to Studio nodes.
 */

import type { IDSDocument } from '@ifc-lite/ids';
import type { Uuid } from '../uuid.js';
import type { FacetFieldName } from './fields.js';

/** Version of the sidecar / document format. */
export const STUDIO_SCHEMA_VERSION = 1;

export interface StudioDocument {
  /** Stable across revisions. */
  readonly docId: Uuid;
  readonly schemaVersion: typeof STUDIO_SCHEMA_VERSION;
  /** Canonical IDS content; no Studio-only fields. */
  readonly ids: IDSDocument;
  readonly nodes: NodeIndex;
  readonly meta: StudioMeta;
}

export interface NodeIndex {
  /** The node id of the document (`info`) itself. */
  readonly document: Uuid;
  /** Parallel to `ids.specifications`. */
  readonly specs: readonly SpecNodes[];
}

export interface SpecNodes {
  readonly id: Uuid;
  /** Parallel to `spec.applicability.facets`. */
  readonly applicability: readonly FacetNodes[];
  /** Parallel to `spec.requirements`. */
  readonly requirements: readonly FacetNodes[];
}

export interface FacetNodes {
  readonly id: Uuid;
  /** One id per constraint field present on the facet. */
  readonly constraints: Readonly<Partial<Record<FacetFieldName, Uuid>>>;
}

export type NodeKind = 'document' | 'spec' | 'applicabilityFacet' | 'requirement' | 'constraint';

export type Section = 'applicability' | 'requirements';

/** Where a node lives right now. Indices are positions in `ids`. */
export type NodeLocation =
  | { kind: 'document' }
  | { kind: 'spec'; specIndex: number; specId: Uuid }
  | {
      kind: 'applicabilityFacet' | 'requirement';
      specIndex: number;
      specId: Uuid;
      section: Section;
      facetIndex: number;
    }
  | {
      kind: 'constraint';
      specIndex: number;
      specId: Uuid;
      section: Section;
      facetIndex: number;
      facetId: Uuid;
      field: FacetFieldName;
    };

// ---------------------------------------------------------------------------
// Sidecar (StudioMeta)
// ---------------------------------------------------------------------------

export type Provenance =
  | { by: 'user'; userId?: string; at: string; opId: Uuid }
  | { by: 'ai'; runId: Uuid; model: string; at: string; opId: Uuid }
  | {
      by: 'import';
      format: 'ids' | 'xlsx' | 'csv' | 'yaml' | 'bsdd' | 'template' | 'infer';
      ref?: string;
      at: string;
      opId: Uuid;
    };

export interface SourceSpan {
  docRef: string;
  kind: 'pdf' | 'docx' | 'xlsx' | 'text';
  page?: number;
  para?: number;
  sheet?: string;
  cell?: string;
  quote: string;
}

export interface CommentThread {
  id: Uuid;
  resolved: boolean;
  comments: { author: string; at: string; text: string }[];
}

export interface Suppression {
  rule: string;
  reason: string;
  by?: string;
  at: string;
}

/** A custom (non-standard) property set the author declared on purpose. */
export interface CustomPsetDecl {
  name: string;
  /** When present, `baseName` literals must be one of these. */
  properties?: { name: string; dataType?: string }[];
}

export interface RevisionInfo {
  parentHash?: string;
  label?: string;
  signOffs?: { by: string; at: string; role?: string }[];
}

/**
 * Studio-only metadata, persisted as the `studio.json` sidecar. Collections
 * owned by later pitches (tests, mappings, unresolved requirements) are
 * kept as opaque JSON until their owners define them.
 */
export interface StudioMeta {
  provenance: Record<Uuid, Provenance[]>;
  sources: Record<Uuid, SourceSpan[]>;
  comments: Record<Uuid, CommentThread[]>;
  suppressions: Record<Uuid, Suppression[]>;
  tests: Record<Uuid, unknown>;
  mappings: unknown[];
  revision: RevisionInfo;
  unresolved: unknown[];
  custom: { psets: CustomPsetDecl[] };
}

export function emptyMeta(): StudioMeta {
  return {
    provenance: {},
    sources: {},
    comments: {},
    suppressions: {},
    tests: {},
    mappings: [],
    revision: {},
    unresolved: [],
    custom: { psets: [] },
  };
}
