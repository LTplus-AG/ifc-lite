/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { exportCsvFromBytes, type CsvProcessor, type CsvMode } from './csv.js';

/** A stub `GeometryProcessor` slice that records how the helper drove it. */
function makeStub(result: string | null | (() => never)) {
  const calls = {
    init: 0,
    dispose: 0,
    exportArgs: [] as Array<{ mode: string; delimiter: string; includeProperties: boolean }>,
  };
  const gp: CsvProcessor = {
    async init() {
      calls.init++;
    },
    exportCsv(_bytes: Uint8Array, mode: CsvMode = 'entities', delimiter = ',', includeProperties = false) {
      calls.exportArgs.push({ mode, delimiter, includeProperties });
      if (typeof result === 'function') result();
      return result as string | null;
    },
    dispose() {
      calls.dispose++;
    },
  };
  return { gp, calls };
}

const BYTES = new Uint8Array([0x49, 0x53, 0x4f]); // arbitrary

describe('exportCsvFromBytes', () => {
  it('returns the CSV and forwards mode with comma/no-properties defaults', async () => {
    const { gp, calls } = makeStub('expressId,type\n1,IfcWall');

    const csv = await exportCsvFromBytes(BYTES, 'entities', {}, () => gp);

    assert.equal(csv, 'expressId,type\n1,IfcWall');
    assert.equal(calls.init, 1);
    assert.equal(calls.dispose, 1);
    assert.deepEqual(calls.exportArgs[0], { mode: 'entities', delimiter: ',', includeProperties: false });
  });

  it('forwards a custom delimiter and includeProperties', async () => {
    const { gp, calls } = makeStub('a;b');

    await exportCsvFromBytes(BYTES, 'properties', { delimiter: ';', includeProperties: true }, () => gp);

    assert.deepEqual(calls.exportArgs[0], { mode: 'properties', delimiter: ';', includeProperties: true });
  });

  it('throws when the exporter returns no data, still disposing', async () => {
    const { gp, calls } = makeStub(null);

    await assert.rejects(() => exportCsvFromBytes(BYTES, 'spatial', {}, () => gp), /CSV export returned no data/);
    assert.equal(calls.dispose, 1, 'dispose runs in finally even on failure');
  });
});
