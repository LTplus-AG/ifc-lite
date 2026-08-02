/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `ifc-lite gym` reward channels (schema/clash/ids) and the reset
 * observation. Every channel's `score` is shaped so that HIGHER IS BETTER,
 * in [0, 1] - an agent maximizing any channel is always pushed toward a
 * healthier model. Determinism contract: every array is explicitly sorted
 * and every fractional number is rounded to a fixed number of decimals, so
 * the same store yields byte-identical channel payloads.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import { createClashEngine, type ClashRule, type Clash } from '@ifc-lite/clash';
import { elementsFromStep } from '@ifc-lite/clash/step';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { IDSNamespace, type IDSSupportedLocale } from '@ifc-lite/sdk';
import { computeValidationIssues } from '../validate.js';

/** Reward channels this prototype knows how to compute. */
export type GymCheck = 'schema' | 'clash' | 'ids';
export const KNOWN_CHECKS: GymCheck[] = ['schema', 'clash', 'ids'];

export function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function computeSchemaChannel(store: IfcDataStore): Record<string, unknown> {
  const issues = computeValidationIssues(store)
    .slice()
    .sort((a, b) => (a.rule === b.rule ? a.message.localeCompare(b.message) : a.rule.localeCompare(b.rule)));
  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const info = issues.filter(i => i.severity === 'info').length;
  const score = errors > 0 ? 0 : warnings > 0 ? 0.5 : 1;
  return { score, errors, warnings, info, issues };
}

/**
 * Reward shaping for the clash channel: 1 for a clash-free model, strictly
 * decreasing toward 0 as the clash count grows. Keeping the raw count as a
 * separate `totalClashes` field means consumers wanting the magnitude still
 * get it, while the `score` field is safe to maximize (matching the schema
 * and ids channels, where higher is always better).
 */
export function clashScoreFromCount(totalClashes: number): number {
  return round(1 / (1 + totalClashes));
}

export async function computeClashChannel(store: IfcDataStore, processor: GeometryProcessor, modelId: string): Promise<Record<string, unknown>> {
  const bytes = store.source;
  if (!bytes || bytes.byteLength === 0) {
    return { score: null, error: 'clash check needs source bytes, which the current store did not retain' };
  }
  const result = await processor.process(bytes);
  const meshes: MeshData[] = result.meshes;
  const { elements, exclusions } = elementsFromStep({ store, meshes, modelId });

  // v0 default: a single self-clash rule across every element, matching
  // `ifc-lite clash` with no `--matrix`/`--a`/`--b` flags.
  const rules: ClashRule[] = [{ id: 'gym-self-clash', name: '* self-clash', a: '*', mode: 'hard' }];
  const engine = createClashEngine({ backend: 'ts' });
  const clashResult = await engine.run(elements, rules, { exclusions });

  const sorted = clashResult.clashes.slice().sort((a: Clash, b: Clash) => {
    if (a.a.key !== b.a.key) return a.a.key < b.a.key ? -1 : 1;
    if (a.b.key !== b.b.key) return a.b.key < b.b.key ? -1 : 1;
    return a.distance - b.distance;
  });

  return {
    score: clashScoreFromCount(clashResult.summary.total),
    totalClashes: clashResult.summary.total,
    bySeverity: clashResult.summary.bySeverity,
    top: sorted.slice(0, 20).map(c => ({
      a: c.a.key,
      aTag: c.a.tag,
      b: c.b.key,
      bTag: c.b.tag,
      severity: c.severity,
      status: c.status,
      distance: round(c.distance),
    })),
  };
}

export async function computeIdsChannel(
  store: IfcDataStore,
  ids: IDSNamespace,
  idsDoc: unknown,
  locale: IDSSupportedLocale,
): Promise<Record<string, unknown>> {
  if (!idsDoc) {
    return { score: null, error: 'ids check requested but --ids <rules.xml> was not provided' };
  }
  const accessor = createDataAccessor(store);
  const report = (await ids.validate(idsDoc, {
    accessor,
    modelInfo: { schemaVersion: store.schemaVersion },
    locale,
    includePassingEntities: false,
  })) as {
    summary: {
      totalSpecifications: number;
      passedSpecifications: number;
      failedSpecifications: number;
      totalEntitiesChecked: number;
      totalEntitiesPassed: number;
      totalEntitiesFailed: number;
    };
  };
  const summary = report.summary;
  const passRatio = summary.totalEntitiesChecked > 0
    ? round(summary.totalEntitiesPassed / summary.totalEntitiesChecked)
    : 1;
  return {
    score: passRatio,
    totalSpecifications: summary.totalSpecifications,
    passedSpecifications: summary.passedSpecifications,
    failedSpecifications: summary.failedSpecifications,
    totalEntitiesChecked: summary.totalEntitiesChecked,
    totalEntitiesPassed: summary.totalEntitiesPassed,
    totalEntitiesFailed: summary.totalEntitiesFailed,
  };
}

export function computeObservation(store: IfcDataStore): Record<string, unknown> {
  const entityCounts: Record<string, number> = {};
  for (const [type, ids] of store.entityIndex.byType) {
    if (ids.length > 0) entityCounts[type] = ids.length;
  }
  const sortedEntityCounts: Record<string, number> = {};
  for (const type of Object.keys(entityCounts).sort()) {
    sortedEntityCounts[type] = entityCounts[type];
  }
  const storeyCount = (store.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? []).length;
  return {
    entityCounts: sortedEntityCounts,
    storeyCount,
    schema: store.schemaVersion ?? null,
    // v0 gap: no geometry pass runs on reset (only the "clash" channel
    // meshes, and only for clash detection, not to derive bounds), so
    // `bounds` is always null for now. See the command doc's "op vocabulary
    // gaps" note.
    bounds: null,
  };
}
