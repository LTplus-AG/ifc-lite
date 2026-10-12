/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS, validateIDS, type ValidationReport } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import * as portable from '@ifc-lite/sdk/review';

const samples = new URL('../../../apps/viewer/public/samples/', import.meta.url);
const modelKey = 'saved-architecture-source';
let report: ValidationReport;
let sourceHash: string;
let failure: portable.SavedValidationElement;
let failuresObserved: number;

beforeAll(async () => {
  // The committed authored IFC and derived demo-kit IDS used by native SDK capture controls.
  // This is actual parser/IDS output, not a fabricated report or a mocked producer.
  const bytes = new Uint8Array(readFileSync(new URL('building-architecture.ifc', samples)));
  sourceHash = createHash('sha256').update(bytes).digest('hex');
  const store = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
  const document = parseIDS(readFileSync(new URL('building-architecture.ids', samples), 'utf8'));
  report = await validateIDS(document, createDataAccessor(store), {
    modelId: modelKey, schemaVersion: store.schemaVersion, entityCount: store.entityCount,
  });
  expect(report.specificationResults.every(spec => !spec.error)).toBe(true);
  const nativeFailures = report.specificationResults.flatMap(spec => spec.entityResults
    .filter(entity => !entity.passed).map(entity => ({ spec, entity })));
  expect(nativeFailures.length).toBeGreaterThan(0);
  const selected = nativeFailures.find(({ entity }) => !!store.entities.getGlobalId(entity.expressId));
  expect(selected).toBeDefined();
  if (!selected) throw new Error('The committed native fixture has no identified failure');
  const GlobalId = store.entities.getGlobalId(selected.entity.expressId);
  expect(GlobalId).toBe(selected.entity.globalId);
  failuresObserved = nativeFailures.length;
  failure = {
    id: 'selected-native-failure', specificationId: selected.spec.specification.id,
    GlobalId: GlobalId ?? null, modelName: 'building-architecture.ifc',
    ifcType: selected.entity.entityType, Name: selected.entity.entityName,
    title: selected.spec.specification.name,
    nativeStatus: selected.spec.specification.severity === 'warning' ? 'warning' : 'failed',
    detail: selected.entity.requirementResults.filter(check => check.status === 'fail')
      .flatMap(check => [check.requirement.id, check.actualValue].filter((value): value is string => !!value)).slice(0, 8),
  };
  expect(createHash('sha256').update(store.source.materialize()).digest('hex')).toBe(sourceHash);
}, 30_000);

function analysis(): portable.SavedAnalysisRun {
  return {
    version: 1, id: 'native-ids-history', kind: 'validation',
    capturedAt: report.timestamp.toISOString(), savedAt: report.timestamp.toISOString(),
    models: [{ key: modelKey, name: 'building-architecture.ifc', sourceContentHash: sourceHash }],
    examined: [modelKey], freshness: 'unknown', edited: null, placementRecorded: false, frame: null,
    report: { ...report, timestamp: report.timestamp.toISOString() }, ruleSet: null,
  };
}

function validation(): portable.SavedValidationReport {
  return {
    id: 'native-ids-snapshot', name: 'Actual native IDS history',
    snapshot: {
      kind: 'ids-report', id: 'native-ids-block', sourceKind: 'ids',
      sourceName: report.source.kind === 'ids' ? report.source.document.info.title ?? '' : report.source.ruleSet.name,
      generatedAt: report.timestamp.toISOString(),
      summary: { checked: report.summary.totalEntitiesChecked, passed: report.summary.totalEntitiesPassed,
        failed: report.summary.totalEntitiesFailed, passRate: report.summary.overallPassRate },
      // This legacy count-only publisher carries the actual native totals and one
      // explicitly partial failure row; it does not claim a complete requirement snapshot.
      checks: [], elementEvidence: { version: 1, rows: [failure], observed: failuresObserved,
        omitted: failuresObserved - 1, gaps: ['Only one actual failed element was retained in this partial snapshot'] },
    },
  };
}

it('#7510 public SDK analysis codec restores actual native IDS rows and refuses broken model joins', () => {
  const wire: unknown = JSON.parse(JSON.stringify(analysis()));
  // Namespace calls keep the existing public review module loadable under the
  // original-production inverse. The assertions concern restored native facts,
  // never symbol existence; missing functionality returns no usable history.
  const restored = portable.decodeSavedAnalysisRun?.(wire);
  expect(restored?.kind).toBe('validation');
  if (!restored || restored.kind !== 'validation') throw new Error('No usable portable native history');
  expect(restored.report.specificationResults).toEqual(report.specificationResults);
  expect(restored.report.summary).toEqual(report.summary);
  expect(restored.models[0].sourceContentHash).toBe(sourceHash);
  expect(restored).toMatchObject({ freshness: 'unknown', edited: null });
  const nativeRows = restored.report.specificationResults.flatMap(spec => spec.entityResults);
  expect(nativeRows.some(row => row.globalId === failure.GlobalId && !row.passed)).toBe(true);
  const broken = analysis(); broken.models[0].key = 'unlisted-model';
  expect(portable.decodeSavedAnalysisRun?.(JSON.parse(JSON.stringify(broken)))).toBeNull();
});

it('#7510 public SDK saved-report codec retains partial native failure identity and rejects fabricated coverage', () => {
  const snapshot: portable.SavedValidationReport = JSON.parse(JSON.stringify(validation()));
  expect(portable.validateSavedReport?.(snapshot)).toBe(true);
  if (snapshot.snapshot.kind !== 'ids-report') throw new Error('The fixture snapshot is not IDS');
  expect(snapshot.snapshot.summary.failed).toBe(report.summary.totalEntitiesFailed);
  expect(snapshot.snapshot.elementEvidence).toMatchObject({ rows: [{ GlobalId: failure.GlobalId,
    specificationId: failure.specificationId, nativeStatus: failure.nativeStatus }], observed: failuresObserved,
    omitted: failuresObserved - 1 });
  expect(snapshot.snapshot.elementEvidence?.definition).toBeUndefined();
  const dishonest = validation();
  if (dishonest.snapshot.kind !== 'ids-report' || !dishonest.snapshot.elementEvidence) throw new Error('No native snapshot evidence');
  dishonest.snapshot.elementEvidence.omitted = failuresObserved;
  expect(portable.validateSavedReport?.(JSON.parse(JSON.stringify(dishonest)))).toBe(false);
  const invalidRate = validation();
  if (invalidRate.snapshot.kind !== 'ids-report') throw new Error('The fixture snapshot is not IDS');
  invalidRate.snapshot.summary.passRate = 101;
  expect(portable.validateSavedReport?.(JSON.parse(JSON.stringify(invalidRate)))).toBe(false);
});
