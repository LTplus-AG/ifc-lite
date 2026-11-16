/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9523: an error response saved or served as a model (here under .ifc / .ifczip) is refused in the preflight,
 * which runs before the primary scene reset, so a failed open (an error page served as a model) never closes the
 * models already loaded. Real STEP and ZIP sources still pass.
 */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createLocalIfcLoadAdmission } from './confirmLocalIfcAdmission.js';

const step = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";

async function preflight(file: File): Promise<{ head: ArrayBuffer | null; failures: unknown[] }> {
  const failures: unknown[] = [];
  const admission = createLocalIfcLoadAdmission(file, { isCurrent: () => true, signal: new AbortController().signal,
    onCancel: () => assert.fail('no consent prompt expected'), onFailure: (error) => failures.push(error), finish: () => {} });
  return { head: await admission.preflight(), failures };
}

it('#9523 refuses a .ifc or .ifczip that is neither STEP nor ZIP before the scene reset', async () => {
  for (const file of [new File(['Access Denied'], 'house.ifc'), new File(['<h1>403</h1>'], 'house.IFC'), new File(['nope'], 'pack.ifczip')]) {
    const { head, failures } = await preflight(file);
    assert.equal(head, null, file.name);
    assert.match(String(failures[0]), /not a model/, file.name);
  }
});

it('#9523 still admits STEP (also behind leading whitespace) and ZIP sources', async () => {
  const sources = [
    new File([step], 'house.ifc'),
    new File([`${' '.repeat(300)}${step}`], 'spaced.ifc'),
    new File([zipSync({ 'model.ifc': strToU8(step) })], 'pack.ifczip'),
  ];
  for (const file of sources) {
    const { head, failures } = await preflight(file);
    assert.notEqual(head, null, file.name);
    assert.deepEqual(failures, [], file.name);
  }
});
