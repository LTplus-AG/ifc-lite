/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS Requirement Grouping — pure helpers to re-slice a specification's
 * per-entity results by requirement ("check") instead of by entity.
 *
 * An `IDSSpecificationResult` carries `entityResults: IDSEntityResult[]`,
 * each with a `requirementResults: IDSRequirementResult[]` produced by
 * iterating the SAME `spec.requirements` array for every entity
 * (`validateEntityRequirements` in `packages/ids/src/validation/validator.ts`).
 * The validator also reuses that same `IDSRequirement` object (not a
 * per-entity clone) for every entity it checks, so
 * `requirementResult.requirement.id` (assigned once at parse time as
 * `req-${index}`, see `packages/ids/src/parser/xml-parser.ts`) is a
 * stable key to group by ACROSS entities within one specification.
 * It is only unique within a specification, not across specifications —
 * grouping must stay scoped to one `IDSSpecificationResult` at a time,
 * which is how every caller here uses it.
 *
 * `not_applicable` is excluded from both the numerator and the
 * denominator of every rate computed here, mirroring how the validator
 * itself treats specification-level `applicableCount` / `passedCount` /
 * `failedCount` (`packages/ids/src/validation/validator.ts`): entities
 * are only ever tallied as passed or failed, never as a third bucket,
 * and the rate is `Math.floor(passed / total * 100)`.
 *
 * This module is standalone and not shared with
 * `apps/viewer/src/hooks/ids/idsExportService.ts` (the HTML/JSON export,
 * owned by a concurrent change) — it exists so the in-app panel can group
 * by requirement without touching that file.
 */

import type {
  IDSEntityResult,
  IDSRequirementResult,
} from '@ifc-lite/ids';

/** One failing entity, flattened with the failure detail for a single requirement. */
export interface RequirementFailingEntity {
  modelId: string;
  expressId: number;
  entityType: string;
  entityName?: string;
  globalId?: string;
  failureReason?: string;
  actualValue?: string;
  expectedValue?: string;
}

/** All entity-level results rolled up for one requirement within a specification. */
export interface RequirementGroup {
  /** `requirement.id`, stable across entities within one specification. */
  key: string;
  requirement: IDSRequirementResult['requirement'];
  facetType: IDSRequirementResult['facetType'];
  checkedDescription: string;
  passedCount: number;
  failedCount: number;
  notApplicableCount: number;
  /** Applicable checks only (excludes not_applicable), floored like the validator. */
  passRate: number;
  failingEntities: RequirementFailingEntity[];
}

/** Check-level rollup: one check = one entity x one requirement. */
export interface CheckStats {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  notApplicableChecks: number;
  /** passedChecks / (passedChecks + failedChecks), floored; 100 if no applicable checks. */
  checkPassRate: number;
}

/**
 * Group a specification's entity results by requirement. Entities are
 * iterated first and never pre-filtered by status — filtering before
 * grouping would silently drop `not_applicable` results and break the
 * per-requirement alignment the counts depend on.
 */
export function groupRequirementResults(
  entityResults: readonly IDSEntityResult[]
): RequirementGroup[] {
  const groups = new Map<string, RequirementGroup>();

  for (const entity of entityResults) {
    for (const reqResult of entity.requirementResults) {
      const key = reqResult.requirement.id;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          requirement: reqResult.requirement,
          facetType: reqResult.facetType,
          checkedDescription: reqResult.checkedDescription,
          passedCount: 0,
          failedCount: 0,
          notApplicableCount: 0,
          passRate: 0,
          failingEntities: [],
        };
        groups.set(key, group);
      }

      if (reqResult.status === 'pass') {
        group.passedCount++;
      } else if (reqResult.status === 'fail') {
        group.failedCount++;
        group.failingEntities.push({
          modelId: entity.modelId,
          expressId: entity.expressId,
          entityType: entity.entityType,
          entityName: entity.entityName,
          globalId: entity.globalId,
          failureReason: reqResult.failureReason,
          actualValue: reqResult.actualValue,
          expectedValue: reqResult.expectedValue,
        });
      } else {
        group.notApplicableCount++;
      }
    }
  }

  for (const group of groups.values()) {
    const applicable = group.passedCount + group.failedCount;
    group.passRate = applicable > 0 ? Math.floor((group.passedCount / applicable) * 100) : 100;
  }

  // Preserve first-seen order, which follows `spec.requirements` order
  // since every entity iterates that same array in the validator.
  return Array.from(groups.values());
}

/**
 * Roll every entity's requirement checks in a specification into a single
 * check-level pass rate — distinct from (and always <=) the specification's
 * own entity-level `passRate`, since one entity can fail several checks.
 */
export function computeCheckStats(entityResults: readonly IDSEntityResult[]): CheckStats {
  let passedChecks = 0;
  let failedChecks = 0;
  let notApplicableChecks = 0;

  for (const entity of entityResults) {
    for (const reqResult of entity.requirementResults) {
      if (reqResult.status === 'pass') passedChecks++;
      else if (reqResult.status === 'fail') failedChecks++;
      else notApplicableChecks++;
    }
  }

  const applicableChecks = passedChecks + failedChecks;
  const checkPassRate = applicableChecks > 0 ? Math.floor((passedChecks / applicableChecks) * 100) : 100;

  return {
    totalChecks: passedChecks + failedChecks + notApplicableChecks,
    passedChecks,
    failedChecks,
    notApplicableChecks,
    checkPassRate,
  };
}
