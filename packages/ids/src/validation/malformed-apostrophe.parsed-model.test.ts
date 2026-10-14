/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from './validator.js';
import { createDataAccessor } from '../bridge/data-accessor.js';

function requirement(entity: string, required: string) {
  return parseIDS(`<ids xmlns="http://standards.buildingsmart.org/IDS">
    <info><title>Retained malformed-apostrophe neighbours</title></info><specifications>
      <specification name="retained entities remain evaluated" ifcVersion="IFC4">
        <applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>${entity}</simpleValue></name></entity></applicability>
        <requirements>${required}</requirements>
      </specification>
    </specifications></ids>`);
}
const names = requirement('IFCWALL', '<attribute><name><simpleValue>Name</simpleValue></name></attribute>');
const fireRating = requirement('IFCSLAB', '<property><propertySet><simpleValue>Pset_SlabCommon</simpleValue></propertySet><baseName><simpleValue>FireRating</simpleValue></baseName></property>');

async function parse(text: string) {
  const diagnostics: string[] = [];
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, {
    disableWorkerScan: true, onDiagnostic: message => diagnostics.push(message),
  });
  return { store, diagnostics };
}

async function failureIds(text: string, ids: ReturnType<typeof parseIDS>) {
  const { store, diagnostics } = await parse(text);
  const report = await validateIDS(ids, createDataAccessor(store), {
    modelId: 'apostrophe-regression', schemaVersion: store.schemaVersion, entityCount: store.entityCount,
  });
  return { store, diagnostics, result: report.specificationResults[0] };
}

describe('malformed quoted records cannot hide valid IDS failures (#7541)', () => {
  it("retains the genuine unnamed wall 22 from the issue author's exact IFC", async () => {
    const text = readFileSync(resolve(process.cwd(), '../../tests/fixtures/step-apostrophe-pair.ifc'), 'utf8');
    const { store, diagnostics, result } = await failureIds(text, names);
    expect([...store.entityIndex.byId.keys()]).toEqual([1, 2, 3, 21, 22, 31]);
    expect(diagnostics.some(value => value.includes('incomplete view'))).toBe(true);
    expect(result.status).toBe('fail');
    expect(result.entityResults.filter(entity => !entity.passed).map(entity => entity.expressId)).toContain(22);
  });

  it('dropping damaged preceding types retains valid roof slabs and their FireRating failures', async () => {
    const text = readFileSync(resolve(process.cwd(), '../../apps/viewer/public/samples/building-architecture.ifc'), 'utf8');
    const baseline = await failureIds(text, fireRating);
    expect(baseline.store.entityIndex.byId.has(395)).toBe(true);
    expect(baseline.store.entityIndex.byId.has(425)).toBe(true);
    expect(baseline.result.entityResults.filter(entity => !entity.passed).map(entity => entity.expressId)).toEqual(expect.arrayContaining([395, 425]));
    const corrupted = text.split('\n').map(line => /^#(?:393|423)=/.test(line) ? line.replaceAll('\\X\\27', "'") : line).join('\n');
    expect(corrupted).not.toBe(text);
    const actual = await failureIds(corrupted, fireRating);
    expect(actual.store.entityIndex.byId.has(393)).toBe(false);
    expect(actual.store.entityIndex.byId.has(423)).toBe(false);
    expect(actual.store.entityIndex.byId.has(395)).toBe(true);
    expect(actual.store.entityIndex.byId.has(425)).toBe(true);
    expect(actual.diagnostics.some(value => value.includes('incomplete view'))).toBe(true);
    expect(actual.result.status).toBe('fail');
    expect(actual.result.entityResults.filter(entity => !entity.passed).map(entity => entity.expressId)).toEqual(expect.arrayContaining([395, 425]));
  });

  it('all four damaged descriptions are reported as omissions without fabricating slab values', async () => {
    const text = readFileSync(resolve(process.cwd(), '../../apps/viewer/public/samples/building-architecture.ifc'), 'utf8');
    const corrupted = text.replaceAll('\\X\\27', "'");
    expect(corrupted).not.toBe(text);
    const { store, diagnostics } = await parse(corrupted);
    for (const id of [393, 395, 423, 425]) expect(store.entityIndex.byId.has(id)).toBe(false);
    expect(diagnostics.some(value => value.includes('incomplete view'))).toBe(true);
    // No IDS-completeness assertion: evaluating only the remaining model does
    // not certify that malformed, omitted slabs satisfy the requirements.
  });
});
