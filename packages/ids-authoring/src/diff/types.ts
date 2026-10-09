/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Semantic diff data model (02-document-model-and-ops.md §6).
 *
 * A `DocumentDiff` says what changed from document `a` to document `b` in
 * IDS terms (a specification was added, a requirement became required, a
 * value changed), not in XML lines. Every entry carries the data needed to
 * reproduce it, so `diffToOps` can turn a diff into ops; that round trip is
 * the completeness oracle of the tests.
 *
 * Node ids: matched nodes are named by their id in `a` (`specId`,
 * `facetId`); nodes only in `b` by their id in `b`. Between two documents
 * of one Studio lineage (same `docId`) the ids agree anyway.
 */

import type {
  IDSConstraint,
  IDSFacet,
  IDSSpecification,
  PartOfRelation,
  RequirementOptionality,
} from '@ifc-lite/ids';
import type { FacetFieldName } from '../document/fields.js';
import type {
  CustomPsetDecl,
  FacetNodes,
  Section,
  SpecNodes,
  UserDefinedTypeDecl,
} from '../document/types.js';
import type { FacetMatchStep, MatchStep } from '../match/cascade.js';
import type { InfoField, RequirementSnapshot, SpecCardinality, SpecPatch } from '../ops/types.js';
import type { Uuid } from '../uuid.js';

/** Specification fields a diff compares (the `spec.patch` keys). */
export type SpecField = keyof SpecPatch;

/** Requirement-only fields a diff compares. */
export type RequirementField = 'optionality' | 'cardinalityRaw' | 'description' | 'instructions';

/** Context every facet entry carries for rendering. */
export interface FacetContext {
  /** The specification (id in `a` when matched). */
  specId: Uuid;
  specName: string;
  section: Section;
  facetId: Uuid;
  /** The facet as it reads after the change (before it, for removals). */
  facet: IDSFacet;
  /** Requirement optionality after the change (requirements only). */
  optionality?: RequirementOptionality;
}

export type DiffEntry =
  | { kind: 'info.changed'; field: InfoField; old?: string; new?: string }
  | { kind: 'custom.psetDeclared'; decl: CustomPsetDecl }
  | { kind: 'custom.psetRemoved'; decl: CustomPsetDecl }
  | { kind: 'custom.userDefinedTypeDeclared'; decl: UserDefinedTypeDecl }
  | { kind: 'custom.userDefinedTypeRemoved'; decl: UserDefinedTypeDecl }
  | { kind: 'spec.added'; specId: Uuid; specName: string; index: number; spec: IDSSpecification; nodes: SpecNodes }
  | { kind: 'spec.removed'; specId: Uuid; specName: string; index: number }
  | { kind: 'spec.moved'; specId: Uuid; specName: string; from: number; to: number }
  | {
      kind: 'spec.changed';
      specId: Uuid;
      specName: string;
      field: SpecField;
      old: unknown;
      new: unknown;
      /** For `minOccurs` / `maxOccurs`: the cardinality before and after. */
      cardinality?: { old: SpecCardinality; new: SpecCardinality };
    }
  | (FacetContext & {
      kind: 'facet.added';
      index: number;
      nodes: FacetNodes;
      requirement?: RequirementSnapshot;
    })
  | (FacetContext & { kind: 'facet.removed'; index: number })
  | (FacetContext & {
      kind: 'facet.moved';
      from: { specId: Uuid; section: Section; index: number };
      to: { specId: Uuid; section: Section; index: number };
    })
  | (FacetContext & {
      kind: 'facet.replaced';
      old: IDSFacet;
      nodes: FacetNodes;
      requirement?: RequirementSnapshot;
    })
  | (FacetContext & {
      kind: 'facet.valueChanged';
      field: FacetFieldName;
      old?: IDSConstraint;
      new?: IDSConstraint;
      /** Constraint node id after the change (when the field is present). */
      constraintId?: Uuid;
    })
  | (FacetContext & {
      kind: 'facet.relationChanged';
      old: { relation: PartOfRelation; rawRelation?: string };
      new: { relation: PartOfRelation; rawRelation?: string };
    })
  | (FacetContext & { kind: 'requirement.changed'; field: RequirementField; old: unknown; new: unknown });

export type DiffEntryKind = DiffEntry['kind'];

/** One row of the side-by-side outline: a node of `a`, of `b`, or both. */
export interface FacetAlignment {
  a?: { specId: Uuid; section: Section; index: number; facetId: Uuid };
  b?: { specId: Uuid; section: Section; index: number; facetId: Uuid };
  by?: FacetMatchStep;
  status: 'unchanged' | 'changed' | 'moved' | 'added' | 'removed';
}

export interface SpecAlignment {
  a?: { index: number; specId: Uuid; name: string };
  b?: { index: number; specId: Uuid; name: string };
  by?: MatchStep;
  status: 'unchanged' | 'changed' | 'moved' | 'added' | 'removed';
  /** Rows of this specification, `b` order first, then removed rows. */
  facets: FacetAlignment[];
}

/**
 * Target node order, in the id space of the patched document (ids of `a`
 * for matched nodes, ids of `b` for new ones).
 */
export interface DiffOrder {
  specs: Uuid[];
  sections: Record<Uuid, { applicability: Uuid[]; requirements: Uuid[] }>;
}

export interface DocumentDiff {
  /** True when `a` and `b` have the same IDS content and custom declarations. */
  identical: boolean;
  /** Nodes were matched by node id (two revisions of one Studio document). */
  byNodeId: boolean;
  entries: DiffEntry[];
  /** Side-by-side alignment, `b` order, removed specs appended. */
  specs: SpecAlignment[];
  order: DiffOrder;
}

export interface DiffOptions {
  /** Minimum similarity for the last matching step (0..1). */
  threshold?: number;
  /**
   * Match by node id first. Defaults to `a.docId === b.docId` (two
   * revisions of one Studio document); two unrelated IDS files are matched
   * by identifier, name and signature, then similarity.
   */
  byNodeId?: boolean;
}
