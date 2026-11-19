/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from '@/lib/features';
import { model, parseStep, seed, viewerHost } from '@/test/agent-tools-fixture';
import { discoverFilterValues } from '@/lib/search/filter-schema';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';
import { boundedFieldValues, boundedPropertyValues } from './fields';
import { MAX_RESULT_BYTES } from './result-limit';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(initial); resetFeaturesForTest(); });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

test('fields.values keeps property keys only while they fit the result budget', () => {
  const many = Array.from({ length: 100 }, (_, i): [string, string[]] => [`Pset.Key${i}`, Array.from({ length: 200 }, (_, j) => `${'v'.repeat(60)}${j}`)]);
  const bounded = boundedPropertyValues(many, 900_000);
  assert.ok(bytes(bounded) <= 900_000);
  assert.ok(Object.keys(bounded).length > 0 && Object.keys(bounded).length < 100);
  const all = Object.fromEntries(many.slice(0, 3));
  assert.deepEqual(boundedPropertyValues(many.slice(0, 3), bytes(all)), all, 'a budget of exactly the full size keeps every key');
});

test('fields.values shares one byte budget across all five fields and names the cut ones (#10598)', () => {
  const long = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(5, '0')}${'é'.repeat(100)}`);
  const values = { materials: ['Brick', 'Concrete'], classificationSystems: long('System', 5000), classifications: long('Code', 5000),
    predefinedTypes: ['STANDARD'], propertyValues: new Map([['Pset_WallCommon.FireRating', ['EI60', 'EI90']]]) };
  const budget = 400_000;
  const bounded = boundedFieldValues(values, budget);
  assert.ok(bytes(bounded) <= budget, `${bytes(bounded)} bytes exceeds ${budget}`);
  assert.deepEqual(bounded.truncated, ['classificationSystems', 'classifications']);
  // Small fields stay whole; the two large ones split the rest evenly.
  assert.deepEqual(bounded.materials, values.materials);
  assert.deepEqual(bounded.predefinedTypes, values.predefinedTypes);
  assert.deepEqual(bounded.propertyValues, Object.fromEntries(values.propertyValues));
  // Each cut field leaves less than one item unused, so the result nearly fills the budget.
  assert.ok(bytes(bounded) > budget - 2 * bytes(values.classificationSystems[0]) - 200, `${bytes(bounded)} bytes leaves budget unused`);
  assert.deepEqual(bounded.classifications, values.classifications.slice(0, bounded.classifications.length), 'a cut list keeps its sorted prefix');
  const whole = boundedFieldValues(values, Number.MAX_SAFE_INTEGER);
  assert.equal(whole.truncated, undefined);
  assert.equal(whole.classifications.length, 5000);
});

/** 5,000 walls, each classified under its own ~250-byte system name: over 1 MB of classification values. */
function oversizedStore(): Promise<IfcDataStore> {
  const lines: string[] = [];
  const guid = (n: number) => String(n).padStart(22, '0');
  for (let i = 0; i < 5000; i++) {
    const wall = 10 + i * 4;
    lines.push(`#${wall}=IFCWALL('${guid(wall)}',$,'Wall ${i}',$,$,$,$,$,.STANDARD.);`,
      `#${wall + 1}=IFCCLASSIFICATION($,$,$,'System ${String(i).padStart(5, '0')} ${'x'.repeat(240)}',$,$,$);`,
      `#${wall + 2}=IFCCLASSIFICATIONREFERENCE($,'C${i}','Class ${i}',#${wall + 1},$,$);`,
      `#${wall + 3}=IFCRELASSOCIATESCLASSIFICATION('${guid(wall + 3)}',$,$,$,(#${wall}),#${wall + 2});`);
  }
  const text = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('fields.ifc','2026-11-19',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('${guid(1)}',$,'Fields',$,$,$,$,$,$);\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;`;
  return parseStep(new TextEncoder().encode(text));
}

test('a cut field passes the share it cannot use to the next cut field (#10598)', () => {
  // One property key far larger than any share: propertyValues keeps nothing, and its share goes to classifications.
  const values = { materials: [], classificationSystems: [], classifications: Array.from({ length: 5000 }, (_, i) => `Code${String(i).padStart(5, '0')}${'x'.repeat(200)}`),
    predefinedTypes: [], propertyValues: new Map([['Pset.Huge', ['y'.repeat(300_000)]]]) };
  const bounded = boundedFieldValues(values, 200_000);
  assert.deepEqual(bounded.truncated, ['classifications', 'propertyValues']);
  assert.deepEqual(bounded.propertyValues, {});
  assert.ok(bytes(bounded.classifications) > 190_000, `${bytes(bounded.classifications)} bytes of classifications`);
});

test('fields.values returns a result under the executor limit for a model whose classifications alone exceed it (#10598)', async () => {
  resetFeaturesForTest();
  const store = await oversizedStore();
  seed([model('A', store)]);
  const sampled = discoverFilterValues(store);
  assert.ok(bytes(sampled.classificationSystems) > MAX_RESULT_BYTES, 'the fixture alone exceeds the limit');
  const result = await dispatchMainViewerTool(viewerHost(), 'viewer_operation_execute', { model_id: 'A', operation_id: 'fields.values', input: {} }, { canEdit: () => true });
  assert.equal(result.isError, false, result.text);
  const values = (result.structured as { result: { classificationSystems: string[]; classifications: string[]; predefinedTypes: string[]; truncated?: string[] } }).result;
  assert.ok(bytes(values) <= MAX_RESULT_BYTES);
  assert.deepEqual(values.truncated, ['classificationSystems']);
  assert.deepEqual(values.classificationSystems, sampled.classificationSystems.slice(0, values.classificationSystems.length));
  assert.deepEqual(values.classifications, sampled.classifications, 'the smaller classification field stays whole');
  assert.deepEqual(values.predefinedTypes, sampled.predefinedTypes);
});
