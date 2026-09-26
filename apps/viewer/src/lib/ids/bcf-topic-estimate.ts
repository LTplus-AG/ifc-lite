/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How many BCF topics an IDS report produces, BEFORE exporting it (#5824).
 *
 * `createBCFFromIDSReport` (`@ifc-lite/bcf`) stops at `maxTopics` and adds
 * one "truncated" Info topic, but nothing told the user beforehand: the
 * dialog defaulted to one topic per failing entity, so a requirement that
 * failed on 5,000 walls silently became 1,000 topics plus a note. This counts
 * exactly what each grouping's builder in `packages/bcf/src/ids-reporter.ts`
 * counts as a qualifying item (its `qualifyingCount`), so the dialog can
 * show the number and warn above the cap. `bcf-topic-estimate.test.ts` pins
 * the two against each other on real reporter output.
 */

import type { IDSReportInput } from '@ifc-lite/bcf';

/** The topic cap the viewer passes to `createBCFFromIDSReport` (its package default). */
export const IDS_BCF_MAX_TOPICS = 1000;

export type IdsBcfTopicGrouping = 'per-entity' | 'per-specification' | 'per-requirement';

export interface IdsBcfTopicEstimateInput {
  topicGrouping: IdsBcfTopicGrouping;
  includePassingEntities: boolean;
}

/** Topics the report yields for `settings` before the cap is applied. */
export function estimateIdsBcfTopicCount(
  report: Pick<IDSReportInput, 'specificationResults'>,
  { topicGrouping, includePassingEntities }: IdsBcfTopicEstimateInput,
): number {
  let count = 0;
  for (const spec of report.specificationResults) {
    switch (topicGrouping) {
      case 'per-specification':
        if (spec.status === 'fail') count++;
        break;
      case 'per-entity':
        if (spec.status === 'not_applicable') break;
        if (spec.status === 'fail' && spec.entityResults.length === 0) { count++; break; }
        for (const entity of spec.entityResults) {
          if (!entity.passed || includePassingEntities) count++;
        }
        break;
      case 'per-requirement':
        if (spec.status !== 'fail') break;
        if (spec.entityResults.length === 0) { count++; break; }
        for (const entity of spec.entityResults) {
          if (entity.passed) continue;
          for (const req of entity.requirementResults) if (req.status === 'fail') count++;
        }
        break;
    }
  }
  return count;
}

export interface IdsBcfSnapshotTarget { modelId: string; expressId: number; boundsKey: string }

/**
 * The unique entities to render a BCF snapshot for, in report order, capped
 * at `IDS_BCF_MAX_TOPICS`: no export can attach more snapshots than it has
 * topics, and each snapshot is a full re-render, so 5,000 failures used to
 * mean 5,000 renders for at most 1,000 topics (#5824).
 */
export function idsBcfSnapshotTargets(
  report: Pick<IDSReportInput, 'specificationResults'>,
  includePassingEntities: boolean,
  cap = IDS_BCF_MAX_TOPICS,
): IdsBcfSnapshotTarget[] {
  const seen = new Set<string>();
  const targets: IdsBcfSnapshotTarget[] = [];
  for (const spec of report.specificationResults) {
    for (const entity of spec.entityResults) {
      if (targets.length >= cap) return targets;
      if (entity.passed && !includePassingEntities) continue;
      const boundsKey = `${entity.modelId}:${entity.expressId}`;
      if (seen.has(boundsKey)) continue;
      seen.add(boundsKey);
      targets.push({ modelId: entity.modelId, expressId: entity.expressId, boundsKey });
    }
  }
  return targets;
}
