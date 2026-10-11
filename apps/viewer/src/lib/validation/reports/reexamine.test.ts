/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7371 follow-up: the GlobalId ownership boundary of saved-row re-examination,
 * and the cost of the per-check lookup. Reports here are native-shaped
 * `ValidationReport`s captured through the canonical snapshot owner
 * (`validationReportSnapshot`), which records the evaluated scope and the
 * saved failure evidence exactly as a real run does.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntityResult, SpecificationResult, ValidationReport } from '@ifc-lite/ids';
import { validationReportSnapshot } from './history';
import { reexamineSavedValidation, type RowReexamination } from './reexamine';
import { savedValidationFindings } from '../../review/sources/saved-validation';

const MODEL = { name: 'tower.ifc', sourceFingerprint: 'fp-tower-7371' };
const models = new Map([['m1', MODEL]]);

interface Element { globalId?: string; passed: boolean; actual?: string }

function entity(element: Element, index: number): EntityResult {
  return { expressId: index + 1, modelId: 'm1', entityType: 'IfcWall', ...(element.globalId ? { globalId: element.globalId } : {}),
    passed: element.passed, requirementResults: element.passed ? [] : [{ requirement: { id: 'is-external', label: 'IsExternal', optionality: 'required' },
      status: 'fail', facetType: 'property', checkedDescription: 'IsExternal', actualValue: element.actual ?? 'false', expectedValue: 'true' }] };
}

function report(checks: Record<string, Element[]>): ValidationReport {
  const specificationResults: SpecificationResult[] = Object.entries(checks).map(([id, elements]) => {
    const failed = elements.filter(element => !element.passed).length;
    return { specification: { id, name: `Walls are external (${id})` }, status: failed ? 'fail' : 'pass', applicableCount: elements.length,
      passedCount: elements.length - failed, failedCount: failed, passRate: 0, entityResults: elements.map(entity) };
  });
  return { source: { kind: 'ids', document: { info: { title: '#7371 synthetic' },
    specifications: Object.keys(checks).map(id => ({ id, name: `Walls are external (${id})`, ifcVersions: ['IFC4'], applicability: { facets: [] }, requirements: [] })) } },
  modelInfo: [{ modelId: 'm1', schemaVersion: 'IFC4', entityCount: 0 }], timestamp: new Date('2026-10-11T00:00:00.000Z'),
  summary: { totalSpecifications: specificationResults.length, passedSpecifications: 0, failedSpecifications: 0, totalEntitiesChecked: 0,
    totalEntitiesPassed: 0, totalEntitiesFailed: 0, overallPassRate: 0 }, specificationResults };
}

const isReport = (value: ValidationReport | Record<string, Element[]>): value is ValidationReport => value.timestamp instanceof Date;

/** Save `before`, then re-examine the saved rows against `after` as a fresh, stamped current run. */
function reexamine(before: Record<string, Element[]>, after: ValidationReport | Record<string, Element[]>) {
  const saved = validationReportSnapshot(report(before), models, 'saved');
  const current = isReport(after) ? after : report(after);
  validationReportSnapshot(current, models, 'current');
  const run = () => reexamineSavedValidation(saved, { report: current, stale: false, stamped: true });
  const result = run();
  assert.ok(result.compatible, 'the synthetic runs checked the same definition over the same model source');
  const rows = new Map<string, RowReexamination[]>();
  for (const row of saved.elementEvidence?.rows ?? []) {
    const key = row.GlobalId ?? '(none)';
    rows.set(key, [...rows.get(key) ?? [], result.rows.get(row.id) ?? assert.fail(`row ${row.id} has no outcome`)]);
  }
  return Object.assign(rows, { again: run });
}

const failing = (globalId: string, actual?: string): Element => ({ globalId, passed: false, ...(actual ? { actual } : {}) });
const ambiguous = { state: 'notEvaluated', reason: 'identityAmbiguous' };

test('#7371 a GlobalId saved twice for one check and model is never compared, while its neighbours are', () => {
  const rows = reexamine({ walls: [failing('dup'), failing('dup'), failing('solo')] }, { walls: [failing('dup'), failing('solo')] });
  assert.deepEqual(rows.get('dup'), [ambiguous, ambiguous]);
  assert.deepEqual(rows.get('solo'), [{ state: 'persisting' }]);
});

test('#7371 a GlobalId the current run carries twice has no identity: neither its failure nor its pass is used', () => {
  const failingTwice = reexamine({ walls: [failing('dup'), failing('solo')] }, { walls: [failing('dup'), failing('dup', 'no'), failing('solo')] });
  assert.deepEqual(failingTwice.get('dup'), [ambiguous]);
  const passingTwice = reexamine({ walls: [failing('dup'), failing('solo')] },
    { walls: [{ globalId: 'dup', passed: true }, { globalId: 'dup', passed: true }, { globalId: 'solo', passed: true }] });
  assert.deepEqual(passingTwice.get('dup'), [ambiguous], 'a duplicated pass is never a resolution candidate');
  assert.deepEqual(passingTwice.get('solo'), [{ state: 'resolved' }]);
});

test('#7371 the same GlobalId in two different checks is two owners, not a duplicate', () => {
  const rows = reexamine({ walls: [failing('shared')], slabs: [failing('shared')] }, { walls: [failing('shared')], slabs: [failing('shared', 'no')] });
  assert.deepEqual(rows.get('shared'), [{ state: 'persisting' }, { state: 'changed' }]);
});

test('#7371 a saved failure without a GlobalId stays unresolved and is never matched', () => {
  const rows = reexamine({ walls: [{ passed: false }, failing('solo')] }, { walls: [{ passed: true }, failing('solo')] });
  assert.deepEqual(rows.get('(none)'), [{ state: 'notEvaluated', reason: 'identityUnavailable' }]);
  assert.deepEqual(rows.get('solo'), [{ state: 'persisting' }]);
});

/** Count how often the current run's entity rows are read: the per-check lookup is the only walk that scales. */
function countedRun(elements: number) {
  const current = report({ walls: Array.from({ length: elements }, (_, index) => failing(`g${index}`)) });
  let reads = 0;
  for (const spec of current.specificationResults) {
    const rows = spec.entityResults;
    Object.defineProperty(spec, 'entityResults', { get: () => { reads++; return rows; } });
  }
  return { current, reads: () => reads };
}

test('#7371 follow-up: the GlobalId lookup is built once per check and model, not once per saved row', () => {
  const elements = 5_000;
  const all = { walls: Array.from({ length: elements }, (_, index) => failing(`g${index}`)) };
  const one = countedRun(elements), many = countedRun(elements);
  reexamine({ walls: [failing('g0')] }, one.current);
  const rows = reexamine(all, many.current);
  assert.equal(rows.size, 2_000, 'every retained saved row (the saved evidence limit) was re-examined');
  assert.ok([...rows.values()].every(outcome => outcome[0].state === 'persisting'));
  assert.equal(many.reads(), one.reads(), '2,000 saved rows read the current results exactly as often as one row does');

  // Review recomputes on every input change; the same published report reuses its lookup.
  const before = many.reads();
  rows.again();
  assert.ok(many.reads() - before <= many.current.specificationResults.length,
    'a recompute reads each check at most once (its completeness), never once per saved row');
});

test('#7371 follow-up: a compatible run that could check none of the saved failures never says it checked them again', () => {
  const runNote = (before: Record<string, Element[]>, after: Record<string, Element[]>) => {
    const saved = validationReportSnapshot(report(before), models, 'saved');
    const current = report(after);
    validationReportSnapshot(current, models, 'current');
    const [run] = savedValidationFindings([{ id: 'saved', name: 'saved', snapshot: saved }], { report: current, stale: false, stamped: true }).runs;
    return run.incomplete.flatMap(gap => gap.message ? [gap.message] : []);
  };
  // The one saved failure's GlobalId occurs twice in the current run: nothing was checked again.
  assert.deepEqual(runNote({ walls: [failing('dup')] }, { walls: [failing('dup'), failing('dup', 'no')] }),
    [{ labelKey: 'reviewWorkspace.reexamination.compatibleNone', params: { count: 1 } }]);
  assert.deepEqual(runNote({ walls: [failing('dup'), { passed: false }] }, { walls: [failing('dup'), failing('dup', 'no')] }),
    [{ labelKey: 'reviewWorkspace.reexamination.compatibleNone', params: { count: 2 } }]);
  // Some checked again, some not: the partial sentence, with both counts.
  assert.deepEqual(runNote({ walls: [failing('dup'), failing('solo')] }, { walls: [failing('dup'), failing('dup', 'no'), failing('solo')] }),
    [{ labelKey: 'reviewWorkspace.reexamination.compatiblePartial', params: { count: 1, total: 2 } }]);
});
