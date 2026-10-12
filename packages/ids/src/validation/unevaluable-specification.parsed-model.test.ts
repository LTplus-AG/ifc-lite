/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7482 on a real parsed model (IfcParser + createDataAccessor), the controls
 * asked for in review:
 *
 * - A genuine rejected IDS pattern still fails only its own specification.
 * - An `UnsafeRegexPatternError` thrown by the host's own `onProgress` while a
 *   specification validates ends the run with that exception. On `main` it
 *   was caught as that specification's evaluation error, because the catch
 *   tested only the class, not where the error came from.
 * - A function-valued abort reason passed to `AbortController.abort()` and
 *   thrown by `signal.throwIfAborted()` after the native accessor has
 *   enumerated ends the run with that exact reason, and the parsed model
 *   validates again afterwards exactly as before.
 * - On the committed sample `building-architecture.ifc` (walls, slabs, walls:
 *   4/3/4), a value that cannot be printed (`Object.create(null)`), thrown
 *   after the real slab enumeration, fails only the slab specification with a
 *   stable reason; the wall specifications before and after it keep their
 *   native results. Formatting that reason used to throw a TypeError and
 *   reject the whole run.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { UnsafeRegexPatternError } from '@ifc-lite/regex-guard';
import { parseIDS } from '../parser/xml-parser.js';
import { createDataAccessor } from '../bridge/index.js';
import { validateIDS } from './validator.js';
import type { IDSValidationReport, IFCDataAccessor, ValidationProgress } from '../types.js';

const gid = (n: number) => String(n).padStart(22, '0');

const STEP = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
  "FILE_NAME('controls.ifc','2026-10-12T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  `#1=IFCPROJECT('${gid(1)}',$,'Project',$,$,$,$,$,#3);`,
  '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
  '#3=IFCUNITASSIGNMENT((#2));',
  `#10=IFCWALL('${gid(10)}',$,'W-1',$,$,$,$,$,$);`,
  `#11=IFCWALL('${gid(11)}',$,'W-2',$,$,$,$,$,$);`,
  `#20=IFCSLAB('${gid(20)}',$,'S-1',$,$,$,$,$,$);`,
  'ENDSEC;',
  'END-ISO-10303-21;',
].join('\n');

const spec = (name: string, entity: string, nameValue = '') => `
    <specification name="${name}" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>${entity}</simpleValue></name></entity></applicability>
      <requirements><attribute><name><simpleValue>Name</simpleValue></name>${nameValue}</attribute></requirements>
    </specification>`;

const IDS = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Host failure controls</title></info>
  <specifications>${spec('Walls have a Name', 'IFCWALL')}${spec(
    'Wall names match a rejected pattern',
    'IFCWALL',
    '<value><xs:restriction base="xs:string"><xs:pattern value="(a+)+b"/></xs:restriction></value>'
  )}${spec('Slabs have a Name', 'IFCSLAB')}
  </specifications>
</ids>`;

async function parsedModel() {
  const bytes = new TextEncoder().encode(STEP);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return { store, modelInfo: { modelId: 'controls', schemaVersion: String(store.schemaVersion ?? 'IFC4'), entityCount: 0 } };
}

/** Status, counts and error of each specification: what a rerun must reproduce. */
const outcome = (report: IDSValidationReport) =>
  report.specificationResults.map((r) => [r.specification.name, r.status, r.applicableCount, r.passedCount, r.failedCount, r.error ?? null]);

describe('host failures on a real parsed model (#7482)', () => {
  it('a genuine rejected IDS pattern still fails only its own specification', async () => {
    const { store, modelInfo } = await parsedModel();
    const report = await validateIDS(parseIDS(IDS), createDataAccessor(store), modelInfo);
    const [walls, pattern, slabs] = report.specificationResults;
    expect([walls.status, walls.error]).toEqual(['pass', undefined]);
    expect(pattern.status).toBe('fail');
    expect(pattern.error).toMatch(/^Specification could not be evaluated: unsafe regex pattern rejected/);
    expect([slabs.status, slabs.error]).toEqual(['pass', undefined]);
  });

  it("an UnsafeRegexPatternError thrown by the host's onProgress while validating ends the run with that exception", async () => {
    const { store, modelInfo } = await parsedModel();
    const hostFailure = new UnsafeRegexPatternError('host', 'thrown by the host progress callback');
    const onProgress = (progress: ValidationProgress) => {
      if (progress.phase === 'validating') throw hostFailure;
    };
    await expect(validateIDS(parseIDS(IDS), createDataAccessor(store), modelInfo, { onProgress })).rejects.toBe(hostFailure);
  });

  it('a function-valued abort reason thrown after native enumeration ends the run with that reason; the model validates again unchanged', async () => {
    const { store, modelInfo } = await parsedModel();
    const before = outcome(await validateIDS(parseIDS(IDS), createDataAccessor(store), modelInfo));

    const controller = new AbortController();
    function AbortError(): void {}
    const native = createDataAccessor(store);
    const cancellable: IFCDataAccessor = {
      ...native,
      getEntitiesByType: (type: string) => {
        const ids = native.getEntitiesByType(type); // the real enumeration runs first
        controller.signal.throwIfAborted();
        return ids;
      },
    };
    // The host cancels once the two wall specifications are done; the slab
    // specification's enumeration is the first to see the signal.
    const onProgress = (progress: ValidationProgress) => {
      if (progress.phase === 'filtering' && progress.specificationIndex === 2) controller.abort(AbortError);
    };
    await expect(validateIDS(parseIDS(IDS), cancellable, modelInfo, { onProgress })).rejects.toBe(AbortError);

    const after = outcome(await validateIDS(parseIDS(IDS), createDataAccessor(store), modelInfo));
    expect(after).toEqual(before);
  });

  it('a value that cannot be printed, thrown after the real slab enumeration of the sample model, fails only the slab specification', async () => {
    const sample = join(dirname(fileURLToPath(import.meta.url)), '../../../../apps/viewer/public/samples/building-architecture.ifc');
    const bytes = readFileSync(sample);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const modelInfo = { modelId: 'building-architecture', schemaVersion: String(store.schemaVersion ?? 'IFC4'), entityCount: 0 };
    const doc = parseIDS(`<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Unprintable value</title></info>
  <specifications>${spec('Walls have a Name', 'IFCWALL')}${spec('Slabs have a Name', 'IFCSLAB')}${spec('Walls have a GlobalId', 'IFCWALL').replace(
    '<simpleValue>Name</simpleValue>',
    '<simpleValue>GlobalId</simpleValue>'
  )}
  </specifications>
</ids>`);

    const native = createDataAccessor(store);
    const baseline = outcome(await validateIDS(doc, native, modelInfo));
    expect(baseline.map(([, status, applicable]) => [status, applicable])).toEqual([['pass', 4], ['pass', 3], ['pass', 4]]);

    const unprintable = Object.create(null);
    const report = await validateIDS(doc, {
      ...createDataAccessor(store),
      getEntitiesByType: (type: string) => {
        const ids = native.getEntitiesByType(type); // the real enumeration runs first
        if (type.toUpperCase() === 'IFCSLAB') throw unprintable;
        return ids;
      },
    }, modelInfo);

    const [walls, slabs, wallsAgain] = outcome(report);
    expect(walls).toEqual(baseline[0]);
    expect(slabs).toEqual(['Slabs have a Name', 'fail', 0, 0, 0, 'Specification could not be evaluated: the thrown object cannot be converted to text']);
    expect(wallsAgain).toEqual(baseline[2]);
  });
});
