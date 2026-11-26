/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Validation findings. Categories mirror IfcOpenShell's `json_logger` types so reports line up with it. */

export type FindingCategory =
  | 'schema'
  | 'header'
  | 'simpletype_rule'
  | 'entity_rule'
  | 'global_rule'
  | 'unique_rule'
  | 'evaluation_error';

export type SchemaCheck =
  | 'unknown-entity'
  | 'abstract'
  | 'record-syntax'
  | 'attribute-count'
  | 'not-optional'
  | 'derived-in-subtype'
  | 'invalid-derived-marker'
  | 'invalid-type'
  | 'inverse-cardinality'
  | 'guid-format';

export interface ValidationFinding {
  category: FindingCategory;
  /** `IfcWall.CorrectPredefinedType`, `IfcRoot.UR1`, or a {@link SchemaCheck} for `schema` findings. */
  rule: string;
  instance?: number;
  entity?: string;
  /** `Entity.Attribute` the finding is about, when it is about one. */
  attribute?: string;
  message: string;
}

export interface NotEvaluated {
  scope: string;
  owner: string;
  label: string;
  reason: string;
}

export interface ValidationReport {
  schema: string;
  valid: boolean;
  findings: ValidationFinding[];
  /** Rules present in the schema that this run did not evaluate, and why. */
  notEvaluated: NotEvaluated[];
  stats: {
    instances: number;
    entityRuleEvaluations: number;
    typeRuleEvaluations: number;
    milliseconds: number;
  };
}
