/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Its own file, importing only what main already exports, so the revert oracle can load it with the fix reverted.
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from '@/lib/features';
import { model, parseStep, seed, viewerHost } from '@/test/agent-tools-fixture';
import { discoverFilterValues } from '@/lib/search/filter-schema';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';
import { MAX_RESULT_BYTES } from './result-limit';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(initial); resetFeaturesForTest(); });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** 1,000 walls, each classified under its own ~1,100-byte system name: over 1 MB of classification values. */
function oversizedStore(): Promise<IfcDataStore> {
  const lines: string[] = [];
  const guid = (n: number) => String(n).padStart(22, '0');
  for (let i = 0; i < 1000; i++) {
    const wall = 10 + i * 4;
    lines.push(`#${wall}=IFCWALL('${guid(wall)}',$,'Wall ${i}',$,$,$,$,$,.STANDARD.);`,
      `#${wall + 1}=IFCCLASSIFICATION($,$,$,'System ${String(i).padStart(5, '0')} ${'x'.repeat(1100)}',$,$,$);`,
      `#${wall + 2}=IFCCLASSIFICATIONREFERENCE($,'C${i}','Class ${i}',#${wall + 1},$,$);`,
      `#${wall + 3}=IFCRELASSOCIATESCLASSIFICATION('${guid(wall + 3)}',$,$,$,(#${wall}),#${wall + 2});`);
  }
  const text = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('fields.ifc','2026-11-19',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('${guid(1)}',$,'Fields',$,$,$,$,$,$);\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;`;
  return parseStep(new TextEncoder().encode(text));
}

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
  // The cut keeps a real prefix and spends the budget: less than one name (about 1.1 KB) is left unused, plus under
  // 100 bytes the operation reserves for the keys and a full `truncated` list. One name fewer would leave too much.
  assert.ok(values.classificationSystems.length > 0, 'the cut field keeps a prefix');
  const unused = MAX_RESULT_BYTES - bytes(values);
  assert.ok(unused < bytes(sampled.classificationSystems[0]) + 1 + 100, `${unused} bytes left unused`);
  assert.deepEqual(values.classifications, sampled.classifications, 'the smaller classification field stays whole');
  assert.deepEqual(values.predefinedTypes, sampled.predefinedTypes);
});
