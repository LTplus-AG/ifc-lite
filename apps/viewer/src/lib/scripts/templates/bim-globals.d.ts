/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AUTO-GENERATED — do not edit by hand.
 * Run: pnpm generate:bim-globals
 *
 * Type declarations for the sandbox `bim` global.
 * Generated from NAMESPACE_SCHEMAS in bridge-schema.ts.
 */

// ── Entity types ────────────────────────────────────────────────────────

/**
 * An entity as the sandbox hands it to a script.
 *
 * Every attribute is present under BOTH spellings and both always carry the
 * same value. **PascalCase is canonical** — it is the EXPRESS attribute name
 * for `GlobalId`, `Name`, `Description` and `ObjectType`, and it is what the
 * built-in templates use. Prefer it in new scripts. The camelCase half is
 * kept for compatibility with existing saved scripts and is not going away
 * without a major (#2422).
 *
 * `ref` and `type`/`Type` have no EXPRESS counterpart: `Type` is the entity's
 * IFC class name, not an attribute. For the IfcTypeObject behind an
 * occurrence use `bim.query.typeProperties(entity)`.
 */
interface BimEntity {
  ref: { modelId: string; expressId: number };
  name: string; Name: string;
  type: string; Type: string;
  globalId: string; GlobalId: string;
  description: string; Description: string;
  objectType: string; ObjectType: string;
}

interface BimPropertySet {
  name: string;
  properties: Array<{ name: string; value: string | number | boolean | null }>;
}

interface BimQuantitySet {
  name: string;
  quantities: Array<{ name: string; value: number | null }>;
}

interface BimAttribute {
  name: string;
  value: string;
}

interface BimClassification {
  system?: string;
  identification?: string;
  name?: string;
  location?: string;
  description?: string;
  path?: string[];
}

interface BimMaterialLayer {
  materialName?: string;
  thickness?: number;
  isVentilated?: boolean;
  name?: string;
  category?: string;
}

interface BimMaterialProfile {
  materialName?: string;
  name?: string;
  category?: string;
}

interface BimMaterialConstituent {
  materialName?: string;
  name?: string;
  fraction?: number;
  category?: string;
}

interface BimMaterial {
  type: 'Material' | 'MaterialLayerSet' | 'MaterialProfileSet' | 'MaterialConstituentSet' | 'MaterialList';
  name?: string;
  description?: string;
  layers?: BimMaterialLayer[];
  profiles?: BimMaterialProfile[];
  constituents?: BimMaterialConstituent[];
  materials?: string[];
}

interface BimTypeProperties {
  typeName: string;
  typeId: number;
  properties: BimPropertySet[];
}

interface BimDocument {
  name?: string;
  description?: string;
  location?: string;
  identification?: string;
  purpose?: string;
  intendedUse?: string;
  revision?: string;
  confidentiality?: string;
}

type BimRelationships = BimSdk.EntityRelationshipsData;

interface BimModelInfo {
  id: string;
  name: string;
  schemaVersion: string;
  entityCount: number;
  fileSize: number;
}

interface BimFileAttachment {
  name: string;
  type: string;
  size: number;
  rowCount?: number;
  columns?: string[];
  hasTextContent: boolean;
}

// ── Clash engine types ────────────────────────────────────────────────
//
// Extracted by the generator from the sources below — these declarations are
// the engine's own text, not a copy maintained in the generator:
//   packages/clash/src/types.ts
//   packages/clash/src/disciplines.ts
//   packages/spatial/src/aabb.ts

declare namespace BimClash {
  export interface ClashResult {
    clashes: Clash[];
    summary: ClashSummary;
    /** Present only when a cap dropped work — never silent. */
    truncated?: { reason: string; droppedPairs: number };
    rulesRun: ClashRule[];
    /**
     * Selector match coverage for every rule in `rulesRun`, in the same order.
     * This is the raw signal for distinguishing "ran and found nothing" from
     * "no rule matched anything in this model" — see
     * {@link classifyRuleCoverage} for the presentation-facing classification.
     * Populated by every engine-produced result (`runClash`, `findDuplicates`);
     * optional only so hand-built `ClashResult` fixtures in tests don't need it.
     */
    ruleCoverage?: ClashRuleCoverage[];
    settings: { tolerance: number; excludeVoidsAndHosts: boolean };
  }

  /** A cluster of related clashes — the unit of a single BCF topic (Phase 2). */
  export interface ClashGroup {
    id: string;
    title: string;
    members: Clash[];
    bounds: AABB;
    representativePoint: Vec3;
    severity: ClashSeverity;
    discipline?: string;
    storey?: string;
  }

  /** A single detection rule. Omit `b` for a self-clash within selection `a`. */
  export interface ClashRule {
    id: string;
    name: string;
    /** Selector for set A (e.g. `IfcDuct*|IfcPipe*`, `!IfcSpace`). */
    a: string;
    /** Selector for set B. Omitted ⇒ self-clash within A. */
    b?: string;
    /**
     * Explicit membership for set A — `clashMemberKey(model, ref)` strings. When
     * present it REPLACES the `a` selector, so a caller that can resolve a richer
     * filter than a type name (properties, attributes, storeys) against the model
     * can express it. An empty array means "matched nothing", never "everything".
     * See `members.ts`.
     */
    membersA?: readonly string[];
    /** Explicit membership for set B, replacing the `b` selector. See `membersA`. */
    membersB?: readonly string[];
    mode: ClashMode;
    /** Touching band (m). Defaults to the run-level tolerance. */
    tolerance?: number;
    /** Required gap (m) for `clearance` mode. */
    clearance?: number;
    /** Explicit severity; otherwise inferred from the discipline matrix. */
    severity?: ClashSeverity;
    /** Emit `touch`-classified results instead of suppressing them. */
    reportTouch?: boolean;
  }

  export interface ClashRulePreset {
    id: string;
    name: string;
    description: string;
    severity: ClashSeverity;
    selectorA: string;
    selectorB: string;
  }

  export interface Clash {
    /** Stable id: derived from the two durable keys + rule id. */
    id: string;
    a: ClashElementRef;
    b: ClashElementRef;
    rule: string;
    status: ClashStatus;
    /** Signed: `<0` penetration depth, `>0` gap. */
    distance: number;
    /**
     * Provenance of `distance`. The engine always sets it; it is optional only so
     * that a clash rehydrated from a run recorded before this field existed stays
     * assignable — absent means "unknown", never "measured".
     */
    distanceKind?: ClashDistanceKind;
    /**
     * For a `hard` clash, the float32 noise floor of `distance` along the
     * direction that depth was measured: the depth at or below which the engine
     * would have classified the pair as `touch` (#5405). Derived from the
     * elements' own coordinates on that axis and their sizes, never from their
     * distance from the origin along other axes, so it does not change under a
     * translation orthogonal to the depth. `isTouching` uses it for its default
     * band (#5639).
     *
     * Set by the engine on every `hard` clash, absent on every other status.
     * Optional so that a clash recorded before this field existed (or
     * rehydrated from BCF/JSON without it) stays assignable; `isTouching` then
     * falls back to its older coordinate-magnitude band.
     */
    depthFloor?: number;
    /** True contact point (hard) or closest-point midpoint (clearance/touch). */
    point: Vec3;
    /** Overlap region (hard) or closest-segment box (clearance/touch). */
    bounds: AABB;
    severity: ClashSeverity;
  }

  export interface ClashSummary {
    total: number;
    byRule: Record<string, number>;
    byTypePair: Record<string, number>;
    bySeverity: Record<ClashSeverity, number>;
    byStorey?: Record<string, number>;
  }

  /**
   * How many elements a rule's selectors actually matched in THIS model, before
   * any geometry test ran. `matchedB` is `null` for a self-clash rule (no `b`
   * selector). A rule with `matchedA === 0` or `matchedB === 0` never compared a
   * single pair — its selector simply doesn't describe anything in this model
   * (e.g. an MEP selector run against an infrastructure model).
   */
  export interface ClashRuleCoverage {
    rule: string;
    matchedA: number;
    matchedB: number | null;
    /**
     * Whether each side was resolved from explicit membership (`membersA` /
     * `membersB`) rather than from its type selector. A caller explaining an
     * empty side needs it and cannot recover it from `rulesRun`, which
     * deliberately drops the resolved member lists. Absent on a result recorded
     * before this existed — which is the same thing as "by selector".
     */
    fromMembersA?: boolean;
    fromMembersB?: boolean;
    /**
     * The durable `key` (IfcGUID / USD prim path) of every element THIS rule
     * matched on each side, deduplicated and sorted for determinism — not just
     * a count. `compareClashRevisions` (revision.ts) needs this to ask "was
     * this SPECIFIC element re-examined?", which `matchedA`/`matchedB` (counts
     * only) cannot answer: a narrowed selector that drops one previously-
     * matched element while keeping the total count non-zero is invisible to a
     * count-only check. `matchedKeysB` mirrors `matchedB`'s `null` for a
     * self-clash rule (no `b` side). Absent (not just empty) on a result
     * recorded before this existed, or from a hand-built fixture — callers
     * MUST treat an absent `matchedKeysA` as "cannot verify", never as "matched
     * nothing".
     */
    matchedKeysA?: readonly string[];
    matchedKeysB?: readonly string[] | null;
    /**
     * Broad-phase candidate pairs the geometry kernel actually narrow-phase
     * tested for THIS rule (`RuleDetection.candidatesProcessed` in
     * `engine-ts/kernel.ts`), surfaced here so a caller can tell "matched
     * elements on both sides AND compared some of them" apart from "matched
     * elements on both sides but the broad phase found nothing worth testing".
     * `matchedA`/`matchedB` alone cannot make that distinction — they are
     * selector-match counts taken before any geometry runs, so they read as
     * full coverage even when the broad phase (BVH margin query) ends up
     * empty (#4244).
     *
     * `0` here is NOT on its own evidence of a problem: two selected groups
     * that are genuinely far apart (further than the rule's tolerance/
     * clearance margin) legitimately produce zero candidate pairs and a real
     * `'clean'` result — that is the ordinary, correct outcome for a rule
     * whose matched elements never come close to touching. `classifyRuleCoverage`
     * does not treat this field as a coverage signal for exactly that reason;
     * it exists as a diagnostic a caller can inspect when a `'clean'` result
     * looks suspicious for other reasons (e.g. a much larger selector match
     * count than expected), not as an automatic verdict. Absent on a result
     * recorded before this field existed, or from a hand-built fixture.
     */
    candidatesExamined?: number;
  }

  /**
   * Axis-aligned bounding box
   */
  export interface AABB {
    min: [number, number, number];
    max: [number, number, number];
  }

  /** A 3-component vector `[x, y, z]`. */
  export type Vec3 = [number, number, number];

  export type ClashSeverity = 'critical' | 'major' | 'minor' | 'info';

  /**
   * What a rule looks for between two solids:
   * - `hard`      interpenetration (penetration depth beyond tolerance)
   * - `clearance` separated but within the required gap
   */
  export type ClashMode = 'hard' | 'clearance';

  /** The element identity carried on a `Clash` (no geometry). */
  export interface ClashElementRef {
    key: string;
    ref: number;
    model: string;
    tag: string;
    name?: string;
  }

  /** How a detected clash is classified. `touch` is suppressed unless opted in. */
  export type ClashStatus = 'hard' | 'clearance' | 'touch';

  /**
   * How a clash's `distance` was obtained — the two are NOT interchangeable and
   * were indistinguishable in the output before this field existed.
   *
   * - `'mesh'` — measured on the triangle meshes. For `clearance` it is the
   *   exact triangle-to-triangle gap. For `touch` it is usually that same exact
   *   gap, with one exception: a pair whose every candidate depth falls below
   *   the pair's f32 precision floor also reports `touch`, with `distance: 0`
   *   and `distanceKind: 'mesh'` — there the 0 is a CLASSIFICATION (the
   *   surfaces are flush to within what the f32 source coordinates can
   *   represent; nothing is measurably penetrating), not a measured gap.
   *   For a hard clash it is the exact
   *   box-box penetration depth (minimum translation distance along a
   *   separating axis, Gottschalk), certified only when BOTH elements are —
   *   within tolerance — rectangular boxes (`obb.ts`); this replaced an
   *   earlier "deepest crossing-triangle vertex" probe that was a sampling
   *   artifact, converging to 0 as a mesh was retessellated instead of to the
   *   true depth (PR #2536).
   * - `'estimate'` — an uncertified depth: the smallest overlapping dimension of
   *   the two element AABBs, or for a box through-penetration that value capped
   *   by the box-box minimum translation distance (see below). Reported for a hard clash whenever the narrow phase could not
   *   certify a box-box depth. That happens in four shapes, all common in real
   *   models: either element is not (confirmed) a box; surfaces that only
   *   coincide (stacked layers sharing a footprint); one solid modelled wholly
   *   inside another; and a member piercing clean through the other — even
   *   when BOTH are boxes, because the box-box minimum-translation-distance is
   *   then dominated by the piercing member's own extent along the shared
   *   axis, not by the material it actually crossed, and is withheld from
   *   `'mesh'` for exactly that reason. The value is then a property of the two
   *   BOXES, not of the solids — it can equal an element's own thickness rather
   *   than how far the two actually interpenetrate. Treat it as an indication of
   *   scale, not as a measurement. For a through-penetration between two boxes
   *   it never exceeds the box-box minimum translation distance, a distance
   *   proven to separate them (#5742).
   */
  export type ClashDistanceKind = 'mesh' | 'estimate';
}

// ── Cost SDK types ────────────────────────────────────────────────────
//
// Extracted by the generator from the sources below — these declarations are
// the engine's own text, not a copy maintained in the generator:
//   packages/sdk/src/cost-types.ts
//   packages/sdk/src/types.ts
//   packages/create/src/types-cost.ts

declare namespace BimCost {
  export interface CostGraphData {
    modelId: string;
    source: 'loaded-source';
    SchemaVersion: CostSchemaVersion;
    CostSchedules: CostScheduleData[];
    CostItems: CostItemData[];
    CostValues: CostValueData[];
    CostQuantities: CostQuantityData[];
    Units: CostUnitData[];
    MeasuresWithUnit: CostMeasureWithUnitData[];
    ProjectUnits: Partial<Record<CostQuantityDimension, EntityRef>>;
    Relationships: CostRelationshipData[];
    Diagnostics: CostDiagnosticData[];
    HasCostData: boolean;
    Currency?: string;
  }

  export interface CostScheduleData {
    ref: EntityRef;
    GlobalId?: string; Name?: string; Description?: string; ObjectType?: string;
    Identification?: string; PredefinedType?: string; Status?: string;
    SubmittedOn?: string; UpdateDate?: string; ID?: string;
  }

  export interface CostItemData {
    ref: EntityRef;
    GlobalId?: string; Name?: string; Description?: string; ObjectType?: string;
    Identification?: string; PredefinedType?: string;
    CostValues?: EntityRef[]; CostQuantities?: EntityRef[];
  }

  export interface CostValueData {
    ref: EntityRef;
    Type?: 'IfcCostValue' | 'IfcAppliedValue';
    Name?: string; Description?: string; AppliedValue?: CostAppliedValueData;
    UnitBasis?: EntityRef; InvalidUnitBasis?: boolean; ApplicableDate?: string;
    FixedUntilDate?: string; Category?: string; Condition?: string;
    InvalidCondition?: boolean; ArithmeticOperator?: string; Components?: EntityRef[];
    CostType?: string;
  }

  export interface CostEvaluationOptions {
    /** Decimal significant-digit precision from 1 through 10,000. Defaults to 34 (decimal128). */
    Precision?: number;
  }

  export interface CostEvaluationData {
    ref: EntityRef; Amount?: string; Currency?: string;
    Dimension?: CostQuantityDimension | 'ratio'; QuantityApplied?: string;
    Diagnostics: CostDiagnosticData[];
  }

  /** IfcCostSchedule (IfcControl). */
  export interface CostScheduleParams {
    Name: string;
    Description?: string;
    ObjectType?: string;
    Identification?: string;
    PredefinedType?: CostSchedulePredefinedType;
    Status?: string;
    /** IfcDateTime, e.g. '2026-03-01T09:00:00'. */
    SubmittedOn?: string;
    /** IfcDateTime. */
    UpdateDate?: string;
  }

  /** IfcCostItem. */
  export interface CostItemParams {
    Name: string;
    Description?: string;
    ObjectType?: string;
    Identification?: string;
    PredefinedType?: CostItemPredefinedType;
    /**
     * expressIds of IfcCostValue / IfcAppliedValue entities, in the order they
     * must appear. Absent (undefined) writes `$`; an empty array is rejected.
     */
    CostValues?: number[];
    /**
     * expressIds of IfcPhysicalQuantity entities, in order. Absent writes `$`;
     * an empty array is rejected.
     */
    CostQuantities?: number[];
  }

  /**
   * IfcCostValue.
   *
   * `AppliedValue` and `Components` are NOT interchangeable and this builder
   * never derives one from the other: a value that carried a literal
   * `AppliedValue` in the source is written with that literal and no
   * `Components`, and a value that was the sum of its `Components` is written
   * with `Components` and an absent `AppliedValue`. Normalising either way would
   * change what the file says about where the number came from.
   */
  export interface CostValueParams {
    Name?: string;
    Description?: string;
    /** Literal typed value, written as a named SELECT branch. */
    AppliedValue?: CostTypedValue;
    /**
     * expressId of an IfcMeasureWithUnit, the entity branch of
     * IfcAppliedValueSelect. Mutually exclusive with `AppliedValue`.
     */
    AppliedValueRef?: number;
    /**
     * expressId of an IfcMeasureWithUnit giving the basis this rate is quoted
     * per — a rate "per 100 m²" has a UnitBasis of 100 SQUARE_METRE. It is a
     * divisor, not a label: dropping or inventing it moves the amount by whole
     * orders of magnitude.
     */
    UnitBasis?: number;
    /** IfcDate. */
    ApplicableDate?: string;
    /** IfcDate. */
    FixedUntilDate?: string;
    Category?: string;
    Condition?: string;
    ArithmeticOperator?: CostArithmeticOperator;
    /**
     * expressIds of the IfcAppliedValue / IfcCostValue entities this value is
     * computed from, in order. Absent writes `$`; an empty array is rejected.
     * Repeating an expressId shares that entity rather than copying it.
     */
    Components?: number[];
  }

  /** IfcPhysicalSimpleQuantity, as referenced from IfcCostItem.CostQuantities. */
  export interface CostQuantityParams {
    Kind: CostQuantityKind;
    Name: string;
    Value: number;
    Description?: string;
    /** expressId of the unit entity this quantity is measured in. */
    Unit?: number;
    Formula?: string;
  }

  export type CostSchemaVersion = 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';

  export interface CostQuantityData {
    ref: EntityRef; Type: string; Name?: string; Description?: string; Unit?: EntityRef;
    InvalidUnit?: boolean; LengthValue?: string; AreaValue?: string; VolumeValue?: string;
    CountValue?: string; WeightValue?: string; TimeValue?: string; NumberValue?: string;
    Formula?: string; Dimension?: CostQuantityDimension; HasQuantities?: EntityRef[];
    InvalidHasQuantities?: boolean;
  }

  export interface CostUnitData {
    ref: EntityRef; Type: string; UnitType?: string; Prefix?: string; Name?: string;
    Symbol?: string; Currency?: string; Dimension?: CostQuantityDimension; Scale?: string;
  }

  export interface CostMeasureWithUnitData {
    ref: EntityRef; ValueComponent: string; UnitComponent: EntityRef;
    ValueType?: string; ValueDimension?: CostQuantityDimension;
  }

  export type CostQuantityDimension = 'length' | 'area' | 'volume' | 'mass' | 'time' | 'count' | 'number';

  /** Reference to a specific entity within a federated model set */
  export interface EntityRef {
    modelId: string;
    expressId: number;
  }

  export interface CostRelationshipData {
    ref: EntityRef; Type: CostRelationshipType; GlobalId?: string; Name?: string;
    Description?: string; RelatedObjects?: EntityRef[]; InvalidRelatedObjects?: boolean;
    InvalidReferences?: boolean; RelatedDefinitions?: EntityRef[]; RelatingControl?: EntityRef;
    RelatingObject?: EntityRef; RelatingProduct?: EntityRef; RelatingProcess?: EntityRef;
    RelatingContext?: EntityRef; RelatingAppliedValue?: EntityRef; ComponentOfTotal?: EntityRef;
    Components?: EntityRef[]; ArithmeticOperator?: string;
  }

  export interface CostDiagnosticData {
    Code: CostDiagnosticCode;
    Message: string;
    Severity: 'warning' | 'error';
    ref?: EntityRef;
    RelatedRef?: EntityRef;
  }

  export type CostAppliedValueData =
    | { Kind: 'Typed'; Type: string; Value: string }
    | { Kind: 'Reference'; ref: EntityRef }
    | { Kind: 'Unsupported'; Raw: unknown; InvalidNumber?: boolean };

  /** IfcCostScheduleTypeEnum (IFC4 / IFC4X3). */
  export type CostSchedulePredefinedType =
    | 'BUDGET' | 'COSTPLAN' | 'ESTIMATE' | 'TENDER'
    | 'PRICEDBILLOFQUANTITIES' | 'UNPRICEDBILLOFQUANTITIES' | 'SCHEDULEOFRATES'
    | 'USERDEFINED' | 'NOTDEFINED';

  /** IfcCostItemTypeEnum (IFC4 / IFC4X3). */
  export type CostItemPredefinedType = 'USERDEFINED' | 'NOTDEFINED';

  /** A typed IFC measure: the SELECT branch plus its numeric value. */
  export interface CostTypedValue {
    Type: CostMeasureType;
    Value: number;
  }

  /** IfcArithmeticOperatorEnum (MODULO is accepted only when the target schema is IFC4X3). */
  export type CostArithmeticOperator = 'ADD' | 'DIVIDE' | 'MODULO' | 'MULTIPLY' | 'SUBTRACT';

  /** The IfcPhysicalSimpleQuantity subtypes a cost item can take quantities from. */
  export type CostQuantityKind =
    | 'IfcQuantityLength' | 'IfcQuantityArea' | 'IfcQuantityVolume'
    | 'IfcQuantityWeight' | 'IfcQuantityTime' | 'IfcQuantityCount'
    | 'IfcQuantityNumber';

  export type CostRelationshipType =
    | 'IfcRelAssignsToControl' | 'IfcRelAssignsToProduct' | 'IfcRelAssignsToProcess'
    | 'IfcRelNests' | 'IfcRelDeclares' | 'IfcRelAssociatesAppliedValue'
    | 'IfcRelSchedulesCostItems' | 'IfcAppliedValueRelationship';

  export type CostDiagnosticCode =
    | 'IFC2X3_PARTIAL_READ' | 'UNSUPPORTED_SCHEMA' | 'MISSING_REFERENCE' | 'INVALID_LIST'
    | 'MULTIPLE_NESTING_PARENTS' | 'NESTING_CYCLE' | 'QUANTITY_CYCLE' | 'VALUE_CYCLE'
    | 'MISSING_VALUE' | 'INVALID_NUMBER' | 'UNSUPPORTED_APPLIED_VALUE' | 'UNSUPPORTED_CONDITION'
    | 'UNSUPPORTED_UNIT' | 'INCOMPATIBLE_UNIT' | 'MISSING_CURRENCY' | 'MIXED_CURRENCY'
    | 'DIVISION_BY_ZERO' | 'PENDING_EDIT_NOT_APPLIED';

  /**
   * The SELECT branch names this builder will write for a typed IFC value.
   *
   * `IfcCostValue.AppliedValue` is an `IfcAppliedValueSelect` and
   * `IfcMeasureWithUnit.ValueComponent` is an `IfcValue` — both SELECTs, so STEP
   * requires the branch to be named: `IFCMONETARYMEASURE(12.5)`, never a bare
   * `12.5`. A bare number parses but resolves to a different SELECT branch (or
   * to none), which is why the branch is part of the parameter rather than
   * inferred from the number.
   */
  export type CostMeasureType =
    | 'IfcMonetaryMeasure'
    | 'IfcAreaMeasure' | 'IfcVolumeMeasure' | 'IfcLengthMeasure'
    | 'IfcMassMeasure' | 'IfcTimeMeasure' | 'IfcCountMeasure'
    | 'IfcNumericMeasure' | 'IfcRatioMeasure' | 'IfcReal' | 'IfcInteger';
}

// ── SDK relationship types ────────────────────────────────────────────
//
// Extracted by the generator from the sources below — these declarations are
// the engine's own text, not a copy maintained in the generator:
//   packages/sdk/src/types.ts

declare namespace BimSdk {
  /**
   * The related **objects** of an entity's structural relationships — never the
   * `IfcRel*` entities themselves:
   *
   * - `voids` — the `IfcOpeningElement`s that void this element
   *   (`IfcRelVoidsElement`, host → opening).
   * - `fills` — the `IfcOpeningElement` this element fills
   *   (`IfcRelFillsElement`, filler → opening).
   * - `groups` — the `IfcZone` / `IfcGroup` / `IfcSystem` it is assigned to.
   * - `connections` — the elements it is joined to.
   *
   * The field names are deliberately not EXPRESS names, and #2422 resolved to
   * keep them. IFC's own names for these traversals (`HasOpenings`, `FillsVoids`,
   * `HasAssignments`, `ConnectedTo` / `ConnectedFrom`) are INVERSE attributes
   * holding the `IfcRel*` entity, which is not what these arrays contain — so
   * "use the exact EXPRESS name" has no name to offer here. Renaming `voids` to
   * `openings` is not a fix either: `voids` **and** `fills` both hold
   * `IfcOpeningElement`s, and only the voids/fills pair — buildingSMART's own
   * vocabulary for the two directions — tells them apart. Pinned by
   * `packages/parser/test/relationship-field-semantics-2422.test.ts`.
   */
  export interface EntityRelationshipsData {
    voids: Array<{ id: number; name?: string; type: string }>;
    fills: Array<{ id: number; name?: string; type: string }>;
    groups: Array<{ id: number; name?: string; type?: string }>;
    connections: Array<{ id: number; name?: string; type: string }>;
    /** Every graph edge touching the entity, preserving its exact IfcRel* class.
     * Optional for third-party backends compiled against the pre-#4205 shape. */
    relations?: Array<{
      relationshipId: number;
      relationshipType: string;
      direction: 'forward' | 'inverse';
      entity: { id: number; name?: string; type: string };
    }>;
  }
}
interface BimStructuralLoad {
  ExpressId: number; Type: string; Name?: string;
  Components: Record<string, number>;
  Configuration?: BimStructuralLoadConfiguration;
}
interface BimStructuralLoadConfiguration {
  Entries: Array<{ Value?: BimStructuralLoad; Dropped?: 'depth' | 'cycle' | 'budget' | 'invalid-reference' | 'unresolved' | 'unreadable'; Location?: number[] }>;
  Locations?: number[][]; Truncated: boolean;
}

// ── Sandbox globals ─────────────────────────────────────────────────────

/**
 * The sandbox `console`. Output is captured into the run result, not written
 * to the host console.
 *
 * These are the only methods QuickJS is given; there is no `console.table`,
 * and no `document`, `window` or `fetch` global at all.
 */
declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  info(...args: unknown[]): void;
};

// ── Namespace declarations ──────────────────────────────────────────────

declare const bim: {
  /** Model operations */
  model: {
    /** List loaded models */
    list(): BimModelInfo[];
    /** Get active model */
    active(): BimModelInfo | null;
    /** Get active model ID */
    activeId(): string | null;
    /** Load IFC content into the 3D viewer for preview */
    loadIfc(content: string, filename: string): void;
  };
  /** Query entities */
  query: {
    /** Get all entities */
    all(): BimEntity[];
    /** Filter by IFC type e.g. 'IfcWall' */
    byType(...types: string[]): BimEntity[];
    /** Entities matching the viewer's active advanced filter, or null if no filter is active */
    matchingActiveFilter(): BimEntity[] | null;
    /** Get entity by model ID and express ID */
    entity(modelId: string, expressId: number): BimEntity | null;
    /** Get all named string/enum attributes for an entity */
    attributes(entity: BimEntity): BimAttribute[];
    /** Get all IfcPropertySet data for an entity */
    properties(entity: BimEntity): BimPropertySet[];
    /** Get all IfcElementQuantity data for an entity */
    quantities(entity: BimEntity): BimQuantitySet[];
    /** Get a single property value from an entity */
    property(entity: BimEntity, psetName: string, propName: string): string | number | boolean | null;
    /** Get classification references for an entity */
    classifications(entity: BimEntity): BimClassification[];
    /** Get material assignment for an entity */
    materials(entity: BimEntity): BimMaterial | null;
    /** Get type-level property sets for an entity */
    typeProperties(entity: BimEntity): BimTypeProperties | null;
    /** Get linked document references for an entity */
    documents(entity: BimEntity): BimDocument[];
    /** Get structural relationship summary for an entity */
    relationships(entity: BimEntity): BimRelationships;
    /** Get a single quantity value from an entity */
    quantity(entity: BimEntity, qsetName: string, quantityName: string): number | null;
    /** Get related entities by IFC relationship type */
    related(entity: BimEntity, relType: string, direction: 'forward' | 'inverse'): BimEntity[];
    /** Get the spatial container of an entity */
    containedIn(entity: BimEntity): BimEntity | null;
    /** Get entities contained in a spatial container */
    contains(entity: BimEntity): BimEntity[];
    /** Get the parent aggregate of an entity */
    decomposedBy(entity: BimEntity): BimEntity | null;
    /** Get aggregated children of an entity */
    decomposes(entity: BimEntity): BimEntity[];
    /** Get the containing building storey of an entity */
    storey(entity: BimEntity): BimEntity | null;
    /** Get the spatial/aggregation path from project to entity */
    path(entity: BimEntity): BimEntity[];
    /** List all building storeys */
    storeys(): BimEntity[];
    /** Get the current viewer selection as entities */
    selection(): BimEntity[];
  };
  /** Viewer control */
  viewer: {
    /** Colorize entities e.g. '#ff0000' */
    colorize(entities: BimEntity[], color: string): void;
    /** Batch colorize with [{entities, color}] */
    colorizeAll(batches: Array<{ entities: BimEntity[]; color: string }>): void;
    /** Hide entities */
    hide(entities: BimEntity[]): void;
    /** Show entities */
    show(entities: BimEntity[]): void;
    /** Isolate entities */
    isolate(entities: BimEntity[]): void;
    /** Select entities */
    select(entities: BimEntity[]): void;
    /** Fly camera to entities */
    flyTo(entities: BimEntity[]): void;
    /** Reset colors. Omit entities to reset every color override; an empty list is a no-op; pass entities to reset only theirs. */
    resetColors(entities?: BimEntity[]): void;
    /** Reset all visibility */
    resetVisibility(): void;
  };
  /** Property editing */
  mutate: {
    /** Set an IfcPropertySet or quantity value (not a root IFC attribute) */
    setProperty(entity: unknown, psetName: string, propName: string, value: unknown): void;
    /** Set a root IFC attribute such as Name, Description, ObjectType, or Tag */
    setAttribute(entity: unknown, attrName: string, value: string): void;
    /** Delete a property */
    deleteProperty(entity: unknown, psetName: string, propName: string): void;
    /** Undo last mutation */
    undo(modelId: string): void;
    /** Redo undone mutation */
    redo(modelId: string): void;
  };
  /** Document-level edits — add, remove, and edit positional STEP arguments on entities of a parsed model */
  store: {
    /** Inject a new entity into the active model. Returns an EntityRef for the freshly-allocated expressId. */
    addEntity(modelId: string, def: { type: string; attributes: unknown[] }): { modelId: string; expressId: number };
    /** Remove an entity. Tombstones existing entities; forgets overlay-only ones. Returns false if the id is unknown. */
    removeEntity(entity: { modelId: string; expressId: number }): boolean;
    /** Edit a non-IfcRoot attribute by zero-based STEP argument index (e.g. IfcRectangleProfileDef.XDim is index 3). */
    setPositionalAttribute(entity: { modelId: string; expressId: number }, index: number, value: unknown): void;
    /** Add an IfcColumn to a parsed model anchored to an existing IfcBuildingStorey. Returns the new column entity ref. */
    addColumn(modelId: string, storeyExpressId: number, params: { Position: [number, number, number]; Width: number; Depth: number; Height: number; Name?: string; Description?: string; ObjectType?: string; Tag?: string }): { modelId: string; expressId: number };
    /** Add an IfcWall from Start to End anchored to an IfcBuildingStorey. Returns the new wall entity ref. */
    addWall(modelId: string, storeyExpressId: number, params: { Start: [number, number, number]; End: [number, number, number]; Thickness: number; Height: number; Name?: string; Description?: string; ObjectType?: string; Tag?: string }): { modelId: string; expressId: number };
    /** Add an IfcSlab anchored to an IfcBuildingStorey. Two modes: rectangle (Position + Width + Depth) or polygon (OuterCurve = Array<[x, y]> with ≥3 points). */
    addSlab(modelId: string, storeyExpressId: number, params: { Position: [number, number, number]; Width: number; Depth: number; Thickness: number; Profile?: "rectangle"; Name?: string; Description?: string; ObjectType?: string; Tag?: string } | { Profile: "polygon"; OuterCurve: Array<[number, number]>; Position?: [number, number, number]; Thickness: number; Name?: string; Description?: string; ObjectType?: string; Tag?: string }): { modelId: string; expressId: number };
    /** Add an IfcBeam from Start to End with a centred rectangular cross-section. */
    addBeam(modelId: string, storeyExpressId: number, params: { Start: [number, number, number]; End: [number, number, number]; Width: number; Height: number; Name?: string; Description?: string; ObjectType?: string; Tag?: string }): { modelId: string; expressId: number };
    /** Add a free-standing IfcDoor anchored to an IfcBuildingStorey. */
    addDoor(modelId: string, storeyExpressId: number, params: { Position: [number, number, number]; Width: number; Height: number; FrameThickness?: number; PredefinedType?: string; OperationType?: string; UserDefinedOperationType?: string; Name?: string; Description?: string; ObjectType?: string; Tag?: string }): { modelId: string; expressId: number };
    /** Add a free-standing IfcWindow anchored to an IfcBuildingStorey. */
    addWindow(modelId: string, storeyExpressId: number, params: { Position: [number, number, number]; Width: number; Height: number; FrameThickness?: number; PredefinedType?: string; PartitioningType?: string; UserDefinedPartitioningType?: string; Name?: string; Description?: string; ObjectType?: string; Tag?: string }): { modelId: string; expressId: number };
    /** Add an IfcSpace (room) — rectangle or polygon footprint extruded by Height. Aggregated under the storey via IfcRelAggregates. */
    addSpace(modelId: string, storeyExpressId: number, params: { Position: [number, number, number]; Width: number; Depth: number; Height: number; Profile?: "rectangle"; Name?: string; LongName?: string; Description?: string; ObjectType?: string } | { Profile: "polygon"; OuterCurve: Array<[number, number]>; Position?: [number, number, number]; Height: number; Name?: string; LongName?: string; Description?: string; ObjectType?: string }): { modelId: string; expressId: number };
    /** Add an IfcRoof (flat-roof slab variant). Two modes: rectangle or polygon. */
    addRoof(modelId: string, storeyExpressId: number, params: { Position: [number, number, number]; Width: number; Depth: number; Thickness: number; Profile?: "rectangle"; Name?: string; Description?: string; ObjectType?: string; Tag?: string } | { Profile: "polygon"; OuterCurve: Array<[number, number]>; Position?: [number, number, number]; Thickness: number; Name?: string; Description?: string; ObjectType?: string; Tag?: string }): { modelId: string; expressId: number };
    /** Add an IfcPlate (thin flat element). Two modes: rectangle or polygon. */
    addPlate(modelId: string, storeyExpressId: number, params: { Position: [number, number, number]; Width: number; Depth: number; Thickness: number; Profile?: "rectangle"; PredefinedType?: string; Name?: string; Description?: string; ObjectType?: string; Tag?: string } | { Profile: "polygon"; OuterCurve: Array<[number, number]>; Position?: [number, number, number]; Thickness: number; PredefinedType?: string; Name?: string; Description?: string; ObjectType?: string; Tag?: string }): { modelId: string; expressId: number };
    /** Add an IfcMember (generic structural — brace, post, strut) from Start to End with a rectangular cross-section. */
    addMember(modelId: string, storeyExpressId: number, params: { Start: [number, number, number]; End: [number, number, number]; Width: number; Height: number; PredefinedType?: string; Name?: string; Description?: string; ObjectType?: string; Tag?: string }): { modelId: string; expressId: number };
    /** Add an IfcCostSchedule to a parsed model. */
    addCostSchedule(modelId: string, params: BimCost.CostScheduleParams): { modelId: string; expressId: number };
    /** Add an IfcCostItem to a parsed model. */
    addCostItem(modelId: string, params: BimCost.CostItemParams): { modelId: string; expressId: number };
    /** Add an IfcCostValue to a parsed model. */
    addCostValue(modelId: string, params: BimCost.CostValueParams): { modelId: string; expressId: number };
    /** Add an IfcCostQuantity to a parsed model. */
    addCostQuantity(modelId: string, params: BimCost.CostQuantityParams): { modelId: string; expressId: number };
    /** Create or update the loaded-model cost relationship for nestCostItems. */
    nestCostItems(modelId: string, parentExpressId: number, childExpressIds: number[]): { modelId: string; expressId: number };
    /** Create or update the loaded-model cost relationship for assignCostItemsToSchedule. */
    assignCostItemsToSchedule(modelId: string, scheduleExpressId: number, itemExpressIds: number[]): { modelId: string; expressId: number };
    /** Create or update the loaded-model cost relationship for assignToCostItem. */
    assignToCostItem(modelId: string, costItemExpressId: number, objectExpressIds: number[]): { modelId: string; expressId: number };
    /** Replace an IfcCostItem CostValues list; pass [] to clear it. */
    setCostItemValues(modelId: string, itemExpressId: number, valueExpressIds: number[]): void;
    /** Safely remove an IfcCostSchedule, IfcCostItem, or IfcCostValue from a parsed model. */
    removeCostEntity(modelId: string, expressId: number, options?: { detach?: boolean }): void;
  };
  /** Lens visualization */
  lens: {
    /** Get built-in lens presets */
    presets(): unknown[];
  };
  /** IFC creation from scratch */
  create: {
    /** Create a new IFC project. Returns a creator handle (number). */
    project(params: { Name?: string; Description?: string; Schema?: string; LengthUnit?: string; Currency?: string; Author?: string; Organization?: string }): number;
    /** Generate the IFC STEP file content. Returns { content, entities, stats }. */
    toIfc(handle: number): { content: string; entities: Array<{ expressId: number; type: string; Name?: string }>; stats: { entityCount: number; fileSize: number } };
    /** Assign a named colour to an element. Call before toIfc(). */
    setColor(handle: number, elementId: number, name: string, rgb: unknown): void;
    /** Create an IfcWorkSchedule. Returns schedule expressId. */
    addIfcWorkSchedule(handle: number, params: { Name: string; StartTime: string; FinishTime?: string; CreationDate?: string; Description?: string; Identification?: string; Purpose?: string; Duration?: string; TotalFloat?: string; PredefinedType?: 'ACTUAL' | 'BASELINE' | 'PLANNED' | 'USERDEFINED' | 'NOTDEFINED' }): number;
    /** Create an IfcWorkPlan (groups multiple schedules). Returns plan expressId. */
    addIfcWorkPlan(handle: number, params: { Name: string; StartTime: string; FinishTime?: string; CreationDate?: string; Description?: string; Identification?: string; Purpose?: string; Duration?: string; PredefinedType?: 'ACTUAL' | 'BASELINE' | 'PLANNED' | 'USERDEFINED' | 'NOTDEFINED' }): number;
    /** Create an IfcWorkCalendar (working / non-working time calendar). Returns calendar expressId. */
    addIfcWorkCalendar(handle: number, params: { Name: string; Description?: string; ObjectType?: string; Identification?: string; PredefinedType?: 'FIRSTSHIFT' | 'SECONDSHIFT' | 'THIRDSHIFT' | 'USERDEFINED' | 'NOTDEFINED'; WorkingTimes?: { Name?: string; DataOrigin?: string; UserDefinedDataOrigin?: string; Start?: string; Finish?: string; RecurrencePattern?: { RecurrenceType: 'DAILY' | 'WEEKLY' | 'MONTHLY_BY_DAY_OF_MONTH' | 'MONTHLY_BY_POSITION' | 'BY_DAY_COUNT' | 'BY_WEEKDAY_COUNT' | 'YEARLY_BY_DAY_OF_MONTH' | 'YEARLY_BY_POSITION'; DayComponent?: number[]; WeekdayComponent?: number[]; MonthComponent?: number[]; Position?: number; Interval?: number; Occurrences?: number; TimePeriods?: { StartTime: string; EndTime: string }[] } }[]; ExceptionTimes?: { Name?: string; DataOrigin?: string; UserDefinedDataOrigin?: string; Start?: string; Finish?: string; RecurrencePattern?: { RecurrenceType: 'DAILY' | 'WEEKLY' | 'MONTHLY_BY_DAY_OF_MONTH' | 'MONTHLY_BY_POSITION' | 'BY_DAY_COUNT' | 'BY_WEEKDAY_COUNT' | 'YEARLY_BY_DAY_OF_MONTH' | 'YEARLY_BY_POSITION'; DayComponent?: number[]; WeekdayComponent?: number[]; MonthComponent?: number[]; Position?: number; Interval?: number; Occurrences?: number; TimePeriods?: { StartTime: string; EndTime: string }[] } }[] }): number;
    /** Create an IfcTask. Provide ScheduleStart + ScheduleFinish (or ScheduleDuration) for time fields. Returns task expressId. */
    addIfcTask(handle: number, params: { Name: string; Description?: string; Identification?: string; LongDescription?: string; Status?: string; WorkMethod?: string; IsMilestone?: boolean; Priority?: number; ObjectType?: string; ScheduleStart?: string; ScheduleFinish?: string; ScheduleDuration?: string; ActualStart?: string; ActualFinish?: string; ActualDuration?: string; EarlyStart?: string; EarlyFinish?: string; LateStart?: string; LateFinish?: string; FreeFloat?: string; TotalFloat?: string; IsCritical?: boolean; DurationType?: 'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED'; Completion?: number; PredefinedType?: 'ATTENDANCE' | 'CONSTRUCTION' | 'DEMOLITION' | 'DISMANTLE' | 'DISPOSAL' | 'INSTALLATION' | 'LOGISTIC' | 'MAINTENANCE' | 'MOVE' | 'OPERATION' | 'REMOVAL' | 'RENOVATION' | 'USERDEFINED' | 'NOTDEFINED' | 'ADJUSTMENT' | 'CALIBRATION' | 'EMERGENCY' | 'INSPECTION' | 'SAFETY' | 'SHUTDOWN' | 'STARTUP' | 'TESTING' | 'TROUBLESHOOTING' }): number;
    /** Link predecessor → successor tasks via IfcRelSequence. Returns relationship expressId. */
    addIfcRelSequence(handle: number, predecessorTaskId: number, successorTaskId: number, params: { SequenceType?: 'START_START' | 'START_FINISH' | 'FINISH_START' | 'FINISH_FINISH' | 'USERDEFINED' | 'NOTDEFINED'; TimeLag?: string; LagDurationType?: 'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED'; UserDefinedSequenceType?: string }): number;
    /** Canonical IfcRelAssignsToControl — bind IfcObjectDefinitions (tasks or sub-schedules) to an IfcControl (IfcWorkSchedule/IfcWorkPlan). Returns relationship expressId. */
    addIfcRelAssignsToControl(handle: number, relatingControlId: number, relatedObjectIds: number[]): number;
    /** Canonical IfcRelAssignsToProcess — bind products to an IfcProcess (task). Drives the 4D Gantt animation. Returns relationship expressId. */
    addIfcRelAssignsToProcess(handle: number, relatingProcessId: number, relatedObjectIds: number[]): number;
    /** Canonical IfcRelNests — nest child objects under a parent (task WBS hierarchy). Returns relationship expressId. */
    addIfcRelNests(handle: number, relatingObjectId: number, relatedObjectIds: number[]): number;
    /** Ergonomic alias for addIfcRelAssignsToControl — assign tasks to a work schedule. Returns relationship expressId. */
    assignTasksToWorkSchedule(handle: number, scheduleId: number, taskIds: number[]): number;
    /** Ergonomic alias for addIfcRelAssignsToControl — attach work schedules to a parent IfcWorkPlan. Returns relationship expressId. */
    assignSchedulesToWorkPlan(handle: number, planId: number, scheduleIds: number[]): number;
    /** Ergonomic alias for addIfcRelAssignsToControl — assign an IfcWorkCalendar to tasks (or to work schedules). Returns relationship expressId. */
    assignCalendarToTasks(handle: number, calendarId: number, taskIds: number[]): number;
    /** Ergonomic alias for addIfcRelAssignsToProcess — bind products to a task. Returns relationship expressId. */
    assignProductsToTask(handle: number, taskId: number, productIds: number[]): number;
    /** Ergonomic alias for addIfcRelNests — nest child tasks under a summary parent. Returns relationship expressId. */
    nestTasks(handle: number, parentTaskId: number, childTaskIds: number[]): number;
    /** Create an IfcCostSchedule (IFC4 / IFC4X3 only). Returns schedule expressId. */
    addIfcCostSchedule(handle: number, params: { Name: string; Description?: string; ObjectType?: string; Identification?: string; PredefinedType?: 'BUDGET' | 'COSTPLAN' | 'ESTIMATE' | 'TENDER' | 'PRICEDBILLOFQUANTITIES' | 'UNPRICEDBILLOFQUANTITIES' | 'SCHEDULEOFRATES' | 'USERDEFINED' | 'NOTDEFINED'; Status?: string; SubmittedOn?: string; UpdateDate?: string }): number;
    /** Create an IfcCostItem (IFC4 / IFC4X3 only). Returns cost item expressId. */
    addIfcCostItem(handle: number, params: { Name: string; Description?: string; ObjectType?: string; Identification?: string; PredefinedType?: 'USERDEFINED' | 'NOTDEFINED'; CostValues?: number[]; CostQuantities?: number[] }): number;
    /** Create an IfcCostValue (IFC4 / IFC4X3 only). Returns cost value expressId. */
    addIfcCostValue(handle: number, params: { Name?: string; Description?: string; AppliedValue?: { Type: 'IfcMonetaryMeasure' | 'IfcAreaMeasure' | 'IfcVolumeMeasure' | 'IfcLengthMeasure' | 'IfcMassMeasure' | 'IfcTimeMeasure' | 'IfcCountMeasure' | 'IfcNumericMeasure' | 'IfcRatioMeasure' | 'IfcReal' | 'IfcInteger'; Value: number }; AppliedValueRef?: number; UnitBasis?: number; ApplicableDate?: string; FixedUntilDate?: string; Category?: string; Condition?: string; ArithmeticOperator?: 'ADD' | 'DIVIDE' | 'MODULO' | 'MULTIPLY' | 'SUBTRACT'; Components?: number[] }): number;
    /** Create an IfcSIUnit for use as a quantity or measure unit. Returns unit expressId. */
    addIfcSIUnit(handle: number, params: { UnitType: 'LENGTHUNIT' | 'AREAUNIT' | 'VOLUMEUNIT' | 'MASSUNIT' | 'TIMEUNIT'; Prefix?: string; Name: string }): number;
    /** Create an IfcPhysicalSimpleQuantity for IfcCostItem.CostQuantities. Returns quantity expressId. */
    addIfcPhysicalQuantity(handle: number, params: { Kind: 'IfcQuantityLength' | 'IfcQuantityArea' | 'IfcQuantityVolume' | 'IfcQuantityWeight' | 'IfcQuantityTime' | 'IfcQuantityCount' | 'IfcQuantityNumber'; Name: string; Value: number; Description?: string; Unit?: number; Formula?: string }): number;
    /** Create an IfcMonetaryUnit for a currency code. Returns unit expressId. */
    addIfcMonetaryUnit(handle: number, currency: string): number;
    /** Create an IfcMeasureWithUnit (a typed value paired with a unit). Returns its expressId. */
    addIfcMeasureWithUnit(handle: number, value: { Type: 'IfcMonetaryMeasure' | 'IfcAreaMeasure' | 'IfcVolumeMeasure' | 'IfcLengthMeasure' | 'IfcMassMeasure' | 'IfcTimeMeasure' | 'IfcCountMeasure' | 'IfcNumericMeasure' | 'IfcRatioMeasure' | 'IfcReal' | 'IfcInteger'; Value: number }, unitId: number): number;
    /** Assign cost items to an IfcCostSchedule. Returns relationship expressId. */
    assignCostItemsToSchedule(handle: number, scheduleId: number, costItemIds: number[]): number;
    /** Assign cost items to the product they price. Returns relationship expressId. */
    assignCostItemsToProduct(handle: number, productId: number, costItemIds: number[]): number;
    /** Assign tasks to a cost item (an IfcCostItem is an IfcControl). Returns relationship expressId. */
    assignTasksToCostItem(handle: number, costItemId: number, taskIds: number[]): number;
    /** Nest child cost items under a parent (IfcRelNests). Returns relationship expressId. */
    nestCostItems(handle: number, parentCostItemId: number, childCostItemIds: number[]): number;
    /** Canonical IfcRelAssignsToProduct. Prefer assignCostItemsToProduct. */
    addIfcRelAssignsToProduct(handle: number, relatingProductId: number, relatedObjectIds: number[]): number;
    /** Create ANY IFC type extruded along a Start→End axis. Returns expressId. */
    addAxisElement(handle: number, storeyId: number, params: unknown): number;
    /** Create ANY IFC type with a profile at a placement. Returns expressId. */
    addElement(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcBeam. Returns expressId. */
    addIfcBeam(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcBuildingElementProxy. Returns expressId. */
    addIfcBuildingElementProxy(handle: number, storeyId: number, params: unknown): number;
    /** Add a building storey. Returns storey expressId. */
    addIfcBuildingStorey(handle: number, params: unknown): number;
    /** Add IfcCircularColumn. Returns expressId. */
    addIfcCircularColumn(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcColumn. Returns expressId. */
    addIfcColumn(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcCurtainWall. Returns expressId. */
    addIfcCurtainWall(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcDoor. Returns expressId. */
    addIfcDoor(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcElementQuantity. Returns expressId. */
    addIfcElementQuantity(handle: number, elementId: number, params: unknown): number;
    /** Add IfcFooting. Returns expressId. */
    addIfcFooting(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcFurnishingElement. Returns expressId. */
    addIfcFurnishingElement(handle: number, storeyId: number, params: unknown): number;
    /** Add a dual-pitch gable roof. `Slope` is in radians. Returns roof expressId. */
    addIfcGableRoof(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcHollowCircularColumn. Returns expressId. */
    addIfcHollowCircularColumn(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcIShapeBeam. Returns expressId. */
    addIfcIShapeBeam(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcLShapeMember. Returns expressId. */
    addIfcLShapeMember(handle: number, storeyId: number, params: unknown): number;
    /** Associate a material with an element via IfcRelAssociatesMaterial (deferred to toIfc). Returns nothing. */
    addIfcMaterial(handle: number, elementId: number, params: unknown): void;
    /** Add IfcMember. Returns expressId. */
    addIfcMember(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcPile. Returns expressId. */
    addIfcPile(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcPlate. Returns expressId. */
    addIfcPlate(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcPropertySet. Returns expressId. */
    addIfcPropertySet(handle: number, elementId: number, params: unknown): number;
    /** Add IfcRailing. Returns expressId. */
    addIfcRailing(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcRamp. Returns expressId. */
    addIfcRamp(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcRectangleHollowBeam. Returns expressId. */
    addIfcRectangleHollowBeam(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcRoof. Returns expressId. */
    addIfcRoof(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcSlab. Returns expressId. */
    addIfcSlab(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcSpace. Returns expressId. */
    addIfcSpace(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcStair. Returns expressId. */
    addIfcStair(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcTShapeMember. Returns expressId. */
    addIfcTShapeMember(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcUShapeMember. Returns expressId. */
    addIfcUShapeMember(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcWall. Returns expressId. */
    addIfcWall(handle: number, storeyId: number, params: unknown): number;
    /** Add a door hosted in a wall opening. Position is wall-local [alongWall, 0, baseHeight]. Returns door expressId. */
    addIfcWallDoor(handle: number, wallId: number, params: unknown): number;
    /** Add a window hosted in a wall opening. Position is wall-local [alongWall, 0, sillHeight]. Returns window expressId. */
    addIfcWallWindow(handle: number, wallId: number, params: unknown): number;
    /** Add IfcWindow. Returns expressId. */
    addIfcWindow(handle: number, storeyId: number, params: unknown): number;
    /** Create a profile from a ProfileDef union. Returns profile ID. */
    createProfile(handle: number, profile: unknown): number;
    /** Get the world placement ID for use with addLocalPlacement. */
    getWorldPlacementId(handle: number): number;
  };
  /** Uploaded file attachments */
  files: {
    /** List uploaded file attachments available to scripts */
    list(): BimFileAttachment[];
    /** Get raw text content for an uploaded attachment by file name */
    text(name: string): string | null;
    /** Get parsed CSV/TSV rows for an uploaded attachment by file name */
    csv(name: string): Record<string, string>[] | null;
    /** Get parsed CSV column names for an uploaded attachment by file name */
    csvColumns(name: string): string[];
  };
  /** 4D / IFC construction schedule reader (IfcTask, IfcWorkSchedule, IfcRelSequence, IfcWorkCalendar) */
  schedule: {
    /** Full schedule extraction — tasks, dependencies, work schedules, and work calendars. */
    data(modelId?: string): { HasSchedule: boolean; WorkSchedules: Array<{ GlobalId: string; ExpressId: number; Name: string; Description?: string; Identification?: string; CreationDate?: string; StartTime?: string; FinishTime?: string; Purpose?: string; Duration?: string; PredefinedType?: string; Kind: 'WorkSchedule' | 'WorkPlan'; TaskGlobalIds: string[]; CalendarGlobalIds?: string[] }>; Tasks: Array<{ GlobalId: string; ExpressId: number; Name: string; Description?: string; ObjectType?: string; Identification?: string; LongDescription?: string; Status?: string; WorkMethod?: string; IsMilestone: boolean; Priority?: number; PredefinedType?: string; ParentTaskGlobalId?: string; ChildTaskGlobalIds: string[]; AssignedProductExpressIds: number[]; AssignedProductGlobalIds: string[]; ControllingScheduleGlobalIds: string[]; CalendarGlobalIds?: string[]; TaskTime?: { ScheduleStart?: string; ScheduleFinish?: string; ScheduleDuration?: string; ActualStart?: string; ActualFinish?: string; ActualDuration?: string; EarlyStart?: string; EarlyFinish?: string; LateStart?: string; LateFinish?: string; FreeFloat?: string; TotalFloat?: string; RemainingTime?: string; StatusTime?: string; IsCritical?: boolean; Completion?: number; DurationType?: 'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED' } }>; Sequences: Array<{ RelatingProcessGlobalId: string; RelatedProcessGlobalId: string; SequenceType: 'START_START' | 'START_FINISH' | 'FINISH_START' | 'FINISH_FINISH' | 'USERDEFINED' | 'NOTDEFINED'; UserDefinedSequenceType?: string; TimeLagSeconds?: number; TimeLagDuration?: string }>; WorkCalendars: Array<{ GlobalId: string; ExpressId: number; Name: string; Description?: string; ObjectType?: string; Identification?: string; PredefinedType?: string; WorkingTimes: Array<{ Name?: string; DataOrigin?: string; UserDefinedDataOrigin?: string; Start?: string; Finish?: string; RecurrencePattern?: { RecurrenceType?: string; DayComponent: number[]; WeekdayComponent: number[]; MonthComponent: number[]; Position?: number; Interval?: number; Occurrences?: number; TimePeriods: { Start: string; End: string }[] } }>; ExceptionTimes: Array<{ Name?: string; DataOrigin?: string; UserDefinedDataOrigin?: string; Start?: string; Finish?: string; RecurrencePattern?: { RecurrenceType?: string; DayComponent: number[]; WeekdayComponent: number[]; MonthComponent: number[]; Position?: number; Interval?: number; Occurrences?: number; TimePeriods: { Start: string; End: string }[] } }> }> };
    /** All IfcTask entities with their times and assigned products. */
    tasks(modelId?: string): Array<{ GlobalId: string; ExpressId: number; Name: string; Description?: string; ObjectType?: string; Identification?: string; LongDescription?: string; Status?: string; WorkMethod?: string; IsMilestone: boolean; Priority?: number; PredefinedType?: string; ParentTaskGlobalId?: string; ChildTaskGlobalIds: string[]; AssignedProductExpressIds: number[]; AssignedProductGlobalIds: string[]; ControllingScheduleGlobalIds: string[]; CalendarGlobalIds?: string[]; TaskTime?: { ScheduleStart?: string; ScheduleFinish?: string; ScheduleDuration?: string; ActualStart?: string; ActualFinish?: string; ActualDuration?: string; EarlyStart?: string; EarlyFinish?: string; LateStart?: string; LateFinish?: string; FreeFloat?: string; TotalFloat?: string; RemainingTime?: string; StatusTime?: string; IsCritical?: boolean; Completion?: number; DurationType?: 'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED' } }>;
    /** All IfcWorkSchedule and IfcWorkPlan containers. */
    workSchedules(modelId?: string): Array<{ GlobalId: string; ExpressId: number; Name: string; Description?: string; Identification?: string; CreationDate?: string; StartTime?: string; FinishTime?: string; Purpose?: string; Duration?: string; PredefinedType?: string; Kind: 'WorkSchedule' | 'WorkPlan'; TaskGlobalIds: string[]; CalendarGlobalIds?: string[] }>;
    /** All IfcRelSequence dependency edges (FS/SS/FF/SF, with optional IfcLagTime). */
    sequences(modelId?: string): Array<{ RelatingProcessGlobalId: string; RelatedProcessGlobalId: string; SequenceType: 'START_START' | 'START_FINISH' | 'FINISH_START' | 'FINISH_FINISH' | 'USERDEFINED' | 'NOTDEFINED'; UserDefinedSequenceType?: string; TimeLagSeconds?: number; TimeLagDuration?: string }>;
  };
  /** Structural analysis reader (IfcStructuralAnalysisModel, members, connections, activities, load/result groups) */
  structural: {
    /** Full structural extraction — analysis models, members, connections, activities, load groups, result groups. */
    data(modelId?: string): { HasStructural: boolean; LoadsTruncated: boolean; AnalysisModels: Array<{ GlobalId: string; ExpressId: number; Name?: string; Description?: string; ObjectType?: string; PredefinedType?: string; LoadGroupGlobalIds: string[]; ResultGroupGlobalIds: string[]; ItemGlobalIds: string[] }>; Members: Array<{ GlobalId: string; ExpressId: number; Type: string; Name?: string; Description?: string; ObjectType?: string; PredefinedType?: string; Thickness?: number; ConnectionGlobalIds: string[]; ActivityGlobalIds: string[]; AnalysisModelGlobalIds: string[] }>; Connections: Array<{ GlobalId: string; ExpressId: number; Type: string; Name?: string; Description?: string; ObjectType?: string; MemberGlobalIds: string[]; ActivityGlobalIds: string[]; AnalysisModelGlobalIds: string[]; AppliedCondition?: { ExpressId: number; Type: string; Name?: string; Components: Record<string, number | boolean> } }>; Activities: Array<{ GlobalId: string; ExpressId: number; Type: string; Kind: 'Action' | 'Reaction' | 'Unknown'; Name?: string; Description?: string; ObjectType?: string; PredefinedType?: string; GlobalOrLocal?: string; DestabilizingLoad?: boolean; AppliesToGlobalId?: string; GroupGlobalIds: string[]; AppliedLoad?: BimStructuralLoad }>; LoadGroups: Array<{ GlobalId: string; ExpressId: number; Type: string; Name?: string; Description?: string; ObjectType?: string; PredefinedType?: string; ActionType?: string; ActionSource?: string; Coefficient?: number; Purpose?: string; SelfWeightCoefficients?: number[]; ActivityGlobalIds: string[] }>; ResultGroups: Array<{ GlobalId: string; ExpressId: number; Name?: string; Description?: string; ObjectType?: string; TheoryType?: string; IsLinear?: boolean; ResultForLoadGroupGlobalId?: string; ActivityGlobalIds: string[] }> };
    /** All IfcStructuralAnalysisModel containers. */
    analysisModels(modelId?: string): Array<{ GlobalId: string; ExpressId: number; Name?: string; Description?: string; ObjectType?: string; PredefinedType?: string; LoadGroupGlobalIds: string[]; ResultGroupGlobalIds: string[]; ItemGlobalIds: string[] }>;
    /** All IfcStructuralMember subtype occurrences (curve, surface). */
    members(modelId?: string): Array<{ GlobalId: string; ExpressId: number; Type: string; Name?: string; Description?: string; ObjectType?: string; PredefinedType?: string; Thickness?: number; ConnectionGlobalIds: string[]; ActivityGlobalIds: string[]; AnalysisModelGlobalIds: string[] }>;
    /** All IfcStructuralConnection subtype occurrences, with resolved support conditions. */
    connections(modelId?: string): Array<{ GlobalId: string; ExpressId: number; Type: string; Name?: string; Description?: string; ObjectType?: string; MemberGlobalIds: string[]; ActivityGlobalIds: string[]; AnalysisModelGlobalIds: string[]; AppliedCondition?: { ExpressId: number; Type: string; Name?: string; Components: Record<string, number | boolean> } }>;
    /** All IfcStructuralActivity subtype occurrences — applied actions and computed reactions. */
    activities(modelId?: string): Array<{ GlobalId: string; ExpressId: number; Type: string; Kind: 'Action' | 'Reaction' | 'Unknown'; Name?: string; Description?: string; ObjectType?: string; PredefinedType?: string; GlobalOrLocal?: string; DestabilizingLoad?: boolean; AppliesToGlobalId?: string; GroupGlobalIds: string[]; AppliedLoad?: BimStructuralLoad }>;
    /** All IfcStructuralLoadGroup / IfcStructuralLoadCase entities. */
    loadGroups(modelId?: string): Array<{ GlobalId: string; ExpressId: number; Type: string; Name?: string; Description?: string; ObjectType?: string; PredefinedType?: string; ActionType?: string; ActionSource?: string; Coefficient?: number; Purpose?: string; SelfWeightCoefficients?: number[]; ActivityGlobalIds: string[] }>;
    /** All IfcStructuralResultGroup entities. */
    resultGroups(modelId?: string): Array<{ GlobalId: string; ExpressId: number; Name?: string; Description?: string; ObjectType?: string; TheoryType?: string; IsLinear?: boolean; ResultForLoadGroupGlobalId?: string; ActivityGlobalIds: string[] }>;
  };
  /** IFC 5D cost graph and decimal evaluation from the loaded source snapshot */
  cost: {
    /** Read the complete canonical cost graph. */
    data(modelId?: string): BimCost.CostGraphData;
    /** List IfcCostSchedule records. */
    schedules(modelId?: string): BimCost.CostScheduleData[];
    /** List IfcCostItem records. */
    items(modelId?: string): BimCost.CostItemData[];
    /** List IfcCostValue and IfcAppliedValue records. */
    values(modelId?: string): BimCost.CostValueData[];
    /** Evaluate an IfcCostItem using decimal arithmetic. */
    evaluateItem(ref: BimCost.EntityRef, options?: BimCost.CostEvaluationOptions): BimCost.CostEvaluationData;
    /** Evaluate an IfcCostValue using decimal arithmetic. */
    evaluateValue(ref: BimCost.EntityRef, options?: BimCost.CostEvaluationOptions): BimCost.CostEvaluationData;
  };
  /** Geometric clash / interference detection over host-meshed ClashElement[]. Read-only analysis - selectors are IFC-type globs (e.g. "IfcDuct*|IfcPipe*", "!IfcSpace"), never GlobalIds. The host meshes the model and builds the elements. */
  clash: {
    /** Run a custom set of clash rules over the elements. Each rule is { id, name, a, b?, mode: "hard"|"clearance", tolerance?, clearance?, severity? } where a/b are IFC-type selectors (omit b for a self-clash within a). */
    run(elements: Array<{ key: string; ref: number; model: string; tag: string; name?: string; storey?: string; bounds: { min: [number, number, number]; max: [number, number, number] }; positions: number[]; indices: number[] }>, rules: Array<{ id: string; name: string; a: string; b?: string; mode: "hard" | "clearance"; tolerance?: number; clearance?: number; severity?: "critical" | "major" | "minor" | "info" }>, options?: { tolerance?: number; excludeVoidsAndHosts?: boolean; maxCandidatePairs?: number }): Promise<BimClash.ClashResult>;
    /** Run the standard discipline clash matrix (MEP x STR, HVAC x ARCH, ...). options.mode picks the preset detection mode; remaining options are forwarded as run settings. */
    matrix(elements: Array<{ key: string; ref: number; model: string; tag: string; name?: string; storey?: string; bounds: { min: [number, number, number]; max: [number, number, number] }; positions: number[]; indices: number[] }>, options?: { mode?: "hard" | "clearance"; tolerance?: number; excludeVoidsAndHosts?: boolean; maxCandidatePairs?: number }): Promise<BimClash.ClashResult>;
    /** Group a clash result into clusters (the unit of a single BCF topic). By default, grouping uses "cluster". */
    group(result: Pick<BimClash.ClashResult, "clashes"> & Partial<BimClash.ClashResult>, by?: "cluster" | "rule" | "typePair" | "element" | "storey"): BimClash.ClashGroup[];
    /** Get the built-in discipline-pair rule presets. */
    presets(): BimClash.ClashRulePreset[];
    /** Get the standard discipline matrix as runnable clash rules. mode picks the detection mode ("hard" | "clearance"). */
    disciplineRules(mode?: "hard" | "clearance"): BimClash.ClashRule[];
  };
  /** Data export */
  export: {
    /** Export entities to CSV string */
    csv(entities: BimEntity[], options: { columns: string[]; filename?: string; separator?: string }): string;
    /** Export entities to JSON array */
    json(entities: BimEntity[], columns: string[]): Record<string, unknown>[];
    /** Export entities to IFC STEP text. Omit `entities` for the whole model; an empty list is a filter that matched nothing and is refused. Pass filename to auto-download a valid .ifc file */
    ifc(entities?: BimEntity[], options?: { schema?: "IFC2X3" | "IFC4" | "IFC4X3"; filename?: string; includeMutations?: boolean; visibleOnly?: boolean }): string | Uint8Array;
    /** Trigger a browser file download with the given content. mimeType defaults to text/plain. */
    download(content: string, filename: string, mimeType?: string): void;
  };
  /** Outbound HTTP requests, restricted to https: hosts covered by a granted network.fetch:<host> capability. */
  network: {
    /** Fetch an https: URL. `options.method` is GET (default) or POST; `options.headers`/`body` are optional. Throws if the host is not granted or the response exceeds the byte cap. */
    fetch(url: string, options?: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number }): Promise<{ status: number; headers: Record<string, string>; body: string; truncated: boolean }>;
  };
};
