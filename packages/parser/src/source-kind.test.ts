/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `sourceKind` says what backs a store, which its schema label does not (#9890).
 *
 * Both assertions here are contract-only by construction, which is why no
 * behavioural test can reach them: every gate asks `=== 'tabular'`, so a STEP
 * store that merely lost its `'step'` marker still behaves identically, and
 * today only the STEP parse path crosses the worker transport. Pinned anyway,
 * because the next tabular reader (and any gate that starts asking `'step'`)
 * depends on the marker being set at the parse and surviving the round trip.
 */
import { describe, expect, it } from 'vitest';
import { IfcParser } from './index.js';
import { fromTransport, toTransport } from './data-store-transport.js';

const STEP = `ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('3wdauVJT5Fx9drrREiDqA$',$,'Project',$,$,$,$,$,$);
#2=IFCWALL('1wdauVJT5Fx9drrREiDqA$',$,'Wall',$,$,$,$,$,$);
ENDSEC;END-ISO-10303-21;`;

async function parseStep() {
  const bytes = new TextEncoder().encode(STEP);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

describe('a parsed STEP store says STEP backs it (#9890)', () => {
  it('the parse marks the store, and the schema label is a separate fact', async () => {
    const store = await parseStep();

    expect(store.sourceKind).toBe('step');
    expect(store.schemaVersion).toBe('IFC4');
  });

  it('survives the worker transport, so a store that crossed it still knows what backs it', async () => {
    const store = await parseStep();

    const { payload } = toTransport(store);
    expect(payload.sourceKind).toBe('step');
    expect(fromTransport(payload, store.source).sourceKind).toBe('step');
  });
});
