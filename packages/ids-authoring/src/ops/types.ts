/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Operation vocabulary v1 (02-document-model-and-ops.md §3).
 *
 * All ops are plain JSON. The runtime contract (JSON Schema + validator) is
 * in `./schema*.ts`; `op-kinds.test.ts` keeps the two in lockstep.
 *
 * Besides the vocabulary in the architecture doc, v1 has four FIDELITY ops
 * (`spec.restore`, `spec.patch`, `facet.restore`, `facet.patch`). They are
 * what the reducer emits as exact inverses: they carry raw IDS content and
 * node ids, so undo restores imported diagnostics fields (`ifcVersionRaw`,
 * `cardinalityRaw`, `rawRelation`, absent `minOccurs`, …) bit for bit. They
 * pass through the gate like any other op.
 */

import type {
  IDSConstraint,
  IDSFacet,
  IDSSpecification,
  IFCVersion,
  PartOfRelation,
  RequirementOptionality,
} from '@ifc-lite/ids';
import type { FacetFieldName } from '../document/fields.js';
import type { CustomPsetDecl, FacetNodes, Section, SpecNodes, UserDefinedTypeDecl } from '../document/types.js';
import type { Uuid } from '../uuid.js';

export const OPS_VERSION = 1;

export interface Op<K extends string, P> {
  kind: K;
  opId: Uuid;
  payload: P;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type Scalar = string | number | boolean;

/** XSD base types a draft may name explicitly. */
export type XsdBase =
  | 'xs:string'
  | 'xs:boolean'
  | 'xs:integer'
  | 'xs:double'
  | 'xs:decimal'
  | 'xs:float'
  | 'xs:date'
  | 'xs:dateTime'
  | 'xs:time'
  | 'xs:duration'
  | 'xs:anyURI';

/** The AI- and UI-friendly authoring form of a value (§3.4). */
export type ConstraintDraft =
  | { kind: 'any' }
  | { kind: 'equals'; value: Scalar }
  | { kind: 'oneOf'; values: Scalar[]; base?: XsdBase }
  | { kind: 'pattern'; pattern: string; base?: XsdBase }
  | {
      kind: 'range';
      min?: number;
      minInclusive?: boolean;
      max?: number;
      maxInclusive?: boolean;
      /** Converted to SI (`mm` → m, `kN` → N, `degC` → K, …). */
      unit?: string;
      base?: XsdBase;
    }
  | { kind: 'length'; exact?: number; min?: number; max?: number }
  | { kind: 'digits'; total?: number; fraction?: number }
  | { kind: 'all'; of: ConstraintDraft[] };

/** A verbatim `IDSConstraint` (imports, inverses, paste). */
export interface RawConstraint {
  kind: 'raw';
  constraint: IDSConstraint;
}

export type ValueInput = ConstraintDraft | RawConstraint;

export type FacetDraft =
  | { type: 'entity'; name: ValueInput; predefinedType?: ValueInput }
  | { type: 'attribute'; name: ValueInput; value?: ValueInput }
  | { type: 'property'; propertySet: ValueInput; baseName: ValueInput; dataType?: ValueInput; value?: ValueInput; uri?: string }
  | { type: 'classification'; system?: ValueInput; value?: ValueInput; uri?: string }
  | { type: 'material'; value?: ValueInput; uri?: string }
  | { type: 'partOf'; relation: PartOfRelation; entity?: { name: ValueInput; predefinedType?: ValueInput } };

export type ConstraintIds = Partial<Record<FacetFieldName, Uuid>>;

// ---------------------------------------------------------------------------
// Document + specification ops
// ---------------------------------------------------------------------------

export type InfoField = 'title' | 'copyright' | 'version' | 'description' | 'author' | 'date' | 'purpose' | 'milestone';
export type SpecCardinality = 'required' | 'optional' | 'prohibited';
export type SpecTextField = 'name' | 'description' | 'instructions' | 'identifier';

/** Scalar specification fields a `spec.patch` may set; `null` removes. */
export interface SpecPatch {
  name?: string;
  description?: string | null;
  instructions?: string | null;
  identifier?: string | null;
  ifcVersions?: IFCVersion[];
  ifcVersionRaw?: string | null;
  minOccurs?: number | null;
  maxOccurs?: number | 'unbounded' | null;
  applicabilityCardinality?: string | null;
}

export type DocSetInfoOp = Op<'doc.setInfo', { field: InfoField; value: string | null }>;
export type SpecAddOp = Op<
  'spec.add',
  {
    specId: Uuid;
    index?: number;
    name: string;
    ifcVersions: IFCVersion[];
    description?: string;
    instructions?: string;
    identifier?: string;
    cardinality?: SpecCardinality;
  }
>;
export type SpecRemoveOp = Op<'spec.remove', { specId: Uuid }>;
export type SpecDuplicateOp = Op<'spec.duplicate', { specId: Uuid; newSpecId: Uuid; nameSuffix?: string }>;
export type SpecMoveOp = Op<'spec.move', { specId: Uuid; toIndex: number }>;
export type SpecSetOp = Op<'spec.set', { specId: Uuid; field: SpecTextField; value: string | null }>;
export type SpecSetCardinalityOp = Op<'spec.setCardinality', { specId: Uuid; cardinality: SpecCardinality }>;
export type SpecSetIfcVersionsOp = Op<'spec.setIfcVersions', { specId: Uuid; versions: IFCVersion[] }>;
export type SpecRestoreOp = Op<'spec.restore', { index: number; spec: IDSSpecification; nodes: SpecNodes }>;
export type SpecPatchOp = Op<'spec.patch', { specId: Uuid; set: SpecPatch }>;

// ---------------------------------------------------------------------------
// Facet, requirement and value ops
// ---------------------------------------------------------------------------

/** Requirement-only fields a `facet.patch` may set; `null` removes. */
export interface FacetPatch {
  optionality?: RequirementOptionality;
  cardinalityRaw?: string | null;
  description?: string | null;
  instructions?: string | null;
  relation?: PartOfRelation;
  rawRelation?: string | null;
  /** `@uri` of a property, classification or material requirement. */
  uri?: string | null;
}

/** Requirement fields carried by `facet.restore` (absent for applicability). */
export interface RequirementSnapshot {
  optionality: RequirementOptionality;
  cardinalityRaw?: string;
  description?: string;
  instructions?: string;
}

export type FacetAddOp = Op<
  'facet.add',
  {
    specId: Uuid;
    section: Section;
    facetId: Uuid;
    index?: number;
    facet: FacetDraft;
    optionality?: RequirementOptionality;
    description?: string;
    instructions?: string;
    constraintIds?: ConstraintIds;
  }
>;
export type FacetRemoveOp = Op<'facet.remove', { facetId: Uuid }>;
export type FacetMoveOp = Op<'facet.move', { facetId: Uuid; toSpecId?: Uuid; toSection?: Section; toIndex: number }>;
export type FacetReplaceOp = Op<'facet.replace', { facetId: Uuid; facet: FacetDraft; constraintIds?: ConstraintIds }>;
export type FacetSetFieldOp = Op<
  'facet.setField',
  { facetId: Uuid; field: FacetFieldName; value: ValueInput | null; constraintId?: Uuid }
>;
export type FacetSetRelationOp = Op<'facet.setRelation', { facetId: Uuid; relation: PartOfRelation }>;
/** Set (or with `null` remove) the `@uri` of a property, classification or material requirement. */
export type FacetSetUriOp = Op<'facet.setUri', { facetId: Uuid; uri: string | null }>;
export type FacetRestoreOp = Op<
  'facet.restore',
  {
    specId: Uuid;
    section: Section;
    index: number;
    facet: IDSFacet;
    requirement?: RequirementSnapshot;
    nodes: FacetNodes;
  }
>;
export type FacetPatchOp = Op<'facet.patch', { facetId: Uuid; set: FacetPatch }>;
export type RequirementSetOptionalityOp = Op<
  'requirement.setOptionality',
  { facetId: Uuid; optionality: RequirementOptionality }
>;
export type RequirementSetOp = Op<
  'requirement.set',
  { facetId: Uuid; field: 'description' | 'instructions'; value: string | null }
>;
export type ValueSetOp = Op<
  'value.set',
  { facetId: Uuid; field: FacetFieldName; value: ValueInput; constraintId?: Uuid }
>;
export type ValueAddEnumOp = Op<
  'value.addEnumValue',
  { facetId: Uuid; field: FacetFieldName; value: Scalar; constraintId?: Uuid }
>;
export type ValueRemoveEnumOp = Op<'value.removeEnumValue', { facetId: Uuid; field: FacetFieldName; value: Scalar }>;

// ---------------------------------------------------------------------------
// Meta ops (sidecar only)
// ---------------------------------------------------------------------------

export type MetaDeclarePsetOp = Op<'meta.custom.declarePset', { decl: CustomPsetDecl; index?: number }>;
export type MetaRemovePsetOp = Op<'meta.custom.removePset', { name: string }>;
export type MetaDeclareUserDefinedTypeOp = Op<'meta.custom.declareUserDefinedType', UserDefinedTypeDecl & { index?: number }>;
export type MetaRemoveUserDefinedTypeOp = Op<'meta.custom.removeUserDefinedType', UserDefinedTypeDecl>;

// ---------------------------------------------------------------------------
// Compound ops (expand to primitives)
// ---------------------------------------------------------------------------

export type BulkRenamePropertyOp = Op<
  'bulk.renameProperty',
  { fromPset: string; fromName: string; toPset: string; toName: string; scope?: Uuid[] }
>;
export type BulkRetargetEntityOp = Op<'bulk.retargetEntity', { from: string; to: string; scope?: Uuid[] }>;

/** An op inside a template: no `opId`; strings may hold `{{param}}` / `{{id:local}}`. */
export interface TemplateOp {
  kind: PrimitiveOp['kind'];
  payload: Record<string, unknown>;
}

export interface OpTemplate {
  id: string;
  title?: string;
  params: { name: string; description?: string; default?: string }[];
  ops: TemplateOp[];
}

export type BulkApplyTemplateOp = Op<'bulk.applyTemplate', { template: OpTemplate; params: Record<string, string> }>;

/** An IFC entity a bSDD class relates to, split from bSDD's `IfcWallSOLIDWALL` form. */
export interface BsddEntityRef {
  entity: string;
  predefinedType?: string;
}

/** What the property mapping table (`bsdd/mapping.ts`) needs of a bSDD class property. */
export interface BsddPropertySnapshot {
  code: string;
  name?: string;
  uri?: string;
  propertySet?: string;
  dataType?: string;
  propertyValueKind?: string;
  dimension?: string;
  units?: string[];
  allowedValues?: { code: string; value?: string }[];
  minInclusive?: number;
  maxInclusive?: number;
  minExclusive?: number;
  maxExclusive?: number;
  pattern?: string;
  isRequired?: boolean;
  /** EXPRESS data type of the standard property of that name in that standard set, when there is one. */
  standardDataType?: string;
}

/**
 * The part of a bSDD class an insert needs, carried in the op so the reducer
 * stays pure and the op log replays offline (like `bulk.applyTemplate`
 * carries its template). Built by `snapshotBsddClass`.
 */
export interface BsddClassSnapshot {
  uri: string;
  code: string;
  name: string;
  dictionaryUri: string;
  /** The dictionary name as bSDD publishes it: the classification `system`. */
  dictionaryName: string;
  relatedIfcEntities?: BsddEntityRef[];
  /** The class's properties (with inherited ones when the caller resolved the hierarchy). */
  properties?: BsddPropertySnapshot[];
}

export interface BsddNewSpec {
  specId: Uuid;
  name: string;
  ifcVersions: IFCVersion[];
  index?: number;
  description?: string;
  identifier?: string;
  cardinality?: SpecCardinality;
}

/**
 * Insert one or more classes of ONE dictionary into a specification (an
 * existing one, or a new one the op creates). Several classes give one
 * classification facet with an enumeration of their codes.
 */
export type BulkFromBsddClassOp = Op<
  'bulk.fromBsddClass',
  {
    classes: BsddClassSnapshot[];
    target: { specId: Uuid } | { newSpec: BsddNewSpec };
    /** Add a classification facet (`system` = dictionary name, `value` = class code; `uri` in requirements for one class). */
    classification?: { section: Section; uri?: boolean };
    /** Add an entity facet from the related IFC entities (all of them, or the `entities` chosen). */
    entity?: { section: Section; entities?: string[] };
    /** Add property requirements through the mapping table. */
    properties?: BsddPropertySelection;
  }
>;

export interface BsddPropertySelection {
  /** Property codes (or URIs) to add; each must be defined on every class of the op. */
  select: string[];
  /** `fromClass` (default): required when bSDD marks the property required, else optional. */
  optionality?: 'fromClass' | 'required' | 'optional';
  /** Property set for properties bSDD publishes without one (declared as a custom set). */
  fallbackPropertySet?: string;
  /** Write the property URI on the requirement (default true). */
  uri?: boolean;
}

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

export type PrimitiveOp =
  | DocSetInfoOp
  | SpecAddOp
  | SpecRemoveOp
  | SpecDuplicateOp
  | SpecMoveOp
  | SpecSetOp
  | SpecSetCardinalityOp
  | SpecSetIfcVersionsOp
  | SpecRestoreOp
  | SpecPatchOp
  | FacetAddOp
  | FacetRemoveOp
  | FacetMoveOp
  | FacetReplaceOp
  | FacetSetFieldOp
  | FacetSetRelationOp
  | FacetSetUriOp
  | FacetRestoreOp
  | FacetPatchOp
  | RequirementSetOptionalityOp
  | RequirementSetOp
  | ValueSetOp
  | ValueAddEnumOp
  | ValueRemoveEnumOp
  | MetaDeclarePsetOp
  | MetaRemovePsetOp
  | MetaDeclareUserDefinedTypeOp
  | MetaRemoveUserDefinedTypeOp;

export type CompoundOp = BulkRenamePropertyOp | BulkRetargetEntityOp | BulkApplyTemplateOp | BulkFromBsddClassOp;

export type StudioOp = PrimitiveOp | CompoundOp;
export type OpKind = StudioOp['kind'];

export type OpOfKind<K extends OpKind> = Extract<StudioOp, { kind: K }>;
