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
    assert.match(String(failures[0]), /^Error: The file is /, file.name);
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

it('#9523 a load superseded before the content check reads no further and reports nothing', async () => {
  const file = new File([`{"error":"expired"}${' '.repeat(100_000)}`], 'house.ifc');
  let reads = 0;
  const realSlice = file.slice.bind(file);
  Object.defineProperty(file, 'slice', { value: (start?: number, end?: number) => { reads++; return realSlice(start, end); } });
  const failures: unknown[] = [];
  let finished = 0;
  const admission = createLocalIfcLoadAdmission(file, { isCurrent: () => false, signal: new AbortController().signal,
    onCancel: () => assert.fail('no consent prompt expected'), onFailure: (error) => failures.push(error), finish: () => { finished++; } });
  assert.equal(await admission.preflight(), null);
  assert.equal(reads, 1, 'only the 4 KiB head was read');
  assert.deepEqual(failures, [], 'a stale load reports nothing');
  assert.equal(finished, 1);
});

it('#9523 a load superseded while the content is scanned reports nothing', async () => {
  // Over 4 KiB, so the check reads its 64 KiB scan: that second read is where the load is superseded.
  const file = new File([`{"error":"expired"}${' '.repeat(5000)}`], 'house.ifc');
  let current = true, reads = 0, finished = 0;
  const realSlice = file.slice.bind(file);
  Object.defineProperty(file, 'slice', { value: (start?: number, end?: number) => { if (++reads === 2) current = false; return realSlice(start, end); } });
  const failures: unknown[] = [];
  const admission = createLocalIfcLoadAdmission(file, { isCurrent: () => current, signal: new AbortController().signal,
    onCancel: () => assert.fail('no consent prompt expected'), onFailure: (error) => failures.push(error), finish: () => { finished++; } });
  assert.equal(await admission.preflight(), null);
  assert.equal(reads, 2, 'the content scan ran');
  assert.deepEqual(failures, [], 'a refusal for a superseded load is not reported');
  assert.equal(finished, 1);
});
