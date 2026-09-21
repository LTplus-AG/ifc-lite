/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generalised validation report shapes (issue #5138) — split out of
 * `types.ts` to keep that file under its module-size budget.
 *
 * Shared by IDS validation and, in a follow-up PR, rule-set ("information")
 * validation. `ValidationSource` records which engine produced a report;
 * `SpecificationSummary`/`RequirementSummary`/`CheckKind` are the reduced
 * shapes both engines can populate. `types.ts` re-exports everything here
 * and layers the `IDSSpecification`/`IDSRequirement`-typed narrowings
 * (`IDSValidationReport`, `IDSSpecificationResult`, …) on top.
 */

import type { IDSDocument, RequirementOptionality, FacetType, IDSFailureDetail, IDSCardinalityResult } from './types.js';
import type { IDSValidationSummary } from './types.js';

/** Where a validation report came from. */
export type ValidationSource =
  | { kind: 'ids'; document: IDSDocument }
  | { kind: 'rules'; ruleSet: { name: string; description?: string; fileName?: string } };

/** Reduced specification shape shared by every validation source. */
export interface SpecificationSummary {
  id: string;
  name: string;
  description?: string;
  ifcVersions?: string[];
}

/** Reduced requirement shape shared by every validation source. */
export interface RequirementSummary {
  id: string;
  label: string;
  optionality: RequirementOptionality;
}

/** The kind of check a requirement result represents. */
export type CheckKind = FacetType | 'quantity' | 'spatial' | 'model' | 'unique' | 'aggregate' | 'compare';

/** Closed set of failure reasons for the generalised report (PR 3 onward emits the set-check kinds). */
export type FailureReasonCode =
  | 'absent'
  | 'mismatch'
  | 'notNumeric'
  | 'cardinality'
  | 'duplicate'
  | 'aggregate'
  | 'notDate';

/**
 * A set-level check result (uniqueness / aggregate), distinct from a
 * per-entity `RequirementResult` because it describes a GROUP of entities,
 * not one. Populated starting PR 3 (rule engine); the field exists on
 * `SpecificationResult` now so IDS consumers compile against the final
 * report shape without behaviour change (IDS never populates it).
 */
export interface SetResult {
  kind: 'duplicate' | 'aggregate';
  /** unique: the shared value; aggregate: fn + subject, e.g. `sum(Qto_….NetFloorArea)` */
  label: string;
  /** rendered groupBy key (parent name, storey name…) */
  groupKey?: string;
  /** `Level 1 (3×)` / `287.4 m²` */
  actual: string;
  /** `unique` / `> 300` */
  expected: string;
  passed: boolean;
  failureReason?: FailureReasonCode;
  /** aggregate: non-numeric members excluded */
  skipped?: number;
  members: { modelId: string; expressId: number }[];
}

/** Result for a single requirement check, generalised over its source. */
export interface RequirementResult {
  /** Reference to the requirement */
  requirement: RequirementSummary;
  /** Pass/fail status */
  status: 'pass' | 'fail' | 'not_applicable';
  /** The kind of check that was performed */
  facetType: CheckKind;
  /** Human-readable description of what was checked (translated) */
  checkedDescription: string;
  /** Human-readable failure reason (translated IDS text, or a `FailureReasonCode`) */
  failureReason?: string;
  /** Actual value found */
  actualValue?: string;
  /** Expected value/constraint description */
  expectedValue?: string;
  /** Detailed failure information (IDS only) */
  failure?: IDSFailureDetail;
}

/** Result for a single entity, generalised over its source. */
export interface EntityResult {
  /** Express ID of the entity */
  expressId: number;
  /** Model ID (for multi-model support) */
  modelId: string;
  /** Entity type (e.g., "IfcWall") */
  entityType: string;
  /** Entity name (if available) */
  entityName?: string;
  /** IFC GlobalId (if available) */
  globalId?: string;
  /** Overall pass/fail status */
  passed: boolean;
  /** Results for each requirement */
  requirementResults: RequirementResult[];
}

/** Result for a single specification, generalised over its source. */
export interface SpecificationResult {
  /** Reference to the specification */
  specification: SpecificationSummary;
  /** Overall pass/fail status */
  status: 'pass' | 'fail' | 'not_applicable';
  /** Number of entities that matched applicability */
  applicableCount: number;
  /** Number of applicable entities that passed */
  passedCount: number;
  /** Number of applicable entities that failed */
  failedCount: number;
  /** Pass rate (0-100) */
  passRate: number;
  /** Per-entity results */
  entityResults: EntityResult[];
  /** Cardinality result (if minOccurs/maxOccurs specified) */
  cardinalityResult?: IDSCardinalityResult;
  /** Set when unevaluable (e.g. a ReDoS-rejected pattern) — `status` is `'fail'` */
  error?: string;
  /** Set-level (uniqueness/aggregate) check results (PR 3 onward; never set by IDS) */
  setResults?: SetResult[];
  /** True when `setResults` was capped before every set was evaluated */
  setResultsTruncated?: boolean;
}

/** Complete validation report, generalised over its source. */
export interface ValidationReport {
  /** What produced this report */
  source: ValidationSource;
  /** Information about every validated model */
  modelInfo: ValidationModelInfo[];
  /** When validation was performed */
  timestamp: Date;
  /** Summary statistics */
  summary: IDSValidationSummary;
  /** Results per specification */
  specificationResults: SpecificationResult[];
}

/** Information about a validated model. */
export interface ValidationModelInfo {
  /** Model identifier/filename */
  modelId: string;
  /** IFC schema version */
  schemaVersion: string;
  /** Total entity count */
  entityCount: number;
}
