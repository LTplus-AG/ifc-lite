/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser, scanIfcEntities } from '../src/index.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import { WorkerIndexPublisher, WorkerIndexReceiver } from '../src/worker-index-publication.js';

const original = readFileSync(new URL('../../../tests/fixtures/step-apostrophe-pair.ifc', import.meta.url), 'utf8');

describe('#7541 actual malformed-source provenance survives partial and worker publication', () => {
  for (const clean of [false, true]) {
    it(`retains observed omission flag in ${clean ? 'valid doubled-quote' : 'malformed'} source`, async () => {
      const text = clean ? original.replace("it's", "it''s").replace("Bob's", "Bob''s") : original;
      const expectedIds = clean ? [1, 2, 3, 20, 21, 22, 30, 31] : [1, 2, 3, 21, 22, 31];
      const flag = clean ? 0 : 1;
      let partial: IfcDataStore | undefined;
      const parsed = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, {
        disableWorkerScan: true, onSpatialReady(store) { partial = store; },
      });
      expect(Array.from(parsed.entityIndex.byId.keys())).toEqual(expectedIds);
      expect(parsed.malformedRecordCount).toBe(flag);
      expect(partial).toBeDefined();
      expect(partial!.malformedRecordCount).toBe(flag);
      for (const enabled of [false, true]) {
        const publisher = new WorkerIndexPublisher(enabled);
        const receiver = new WorkerIndexReceiver();
        receiver.capturePartial(structuredClone(publisher.serialize(partial!, false).payload));
        publisher.publishedPartial(partial!);
        const hydrated = receiver.hydrate(structuredClone(publisher.serialize(parsed, true).payload), parsed.source);
        expect(Array.from(hydrated.entityIndex.byId.keys())).toEqual(expectedIds);
        expect(hydrated.getEntity(22)?.expressId).toBe(22);
        expect(hydrated.malformedRecordCount).toBe(flag);
      }
    });
  }
  it('keeps an unobserved valid pre-scanned handoff unknown instead of inventing observed zero', async () => {
    const bytes = new TextEncoder().encode(original.replace("it's", "it''s").replace("Bob's", "Bob''s")).buffer;
    const actual = await scanIfcEntities(bytes, { disableWorkerScan: true });
    expect(actual.entityRefs.map(ref => ref.expressId)).toEqual([1, 2, 3, 20, 21, 22, 30, 31]);
    const columns = {
      ids: Uint32Array.from(actual.entityRefs.map(ref => ref.expressId)),
      starts: Uint32Array.from(actual.entityRefs.map(ref => ref.byteOffset)),
      lengths: Uint32Array.from(actual.entityRefs.map(ref => ref.byteLength)),
    };
    const witness = await scanIfcEntities(bytes, { disableWorkerScan: true, preScannedEntityIndex: columns });
    expect(witness.scanPath).toBe('pre-scanned');
    const parsed = await new IfcParser().parseColumnar(bytes, { disableWorkerScan: true, preScannedEntityIndex: columns });
    expect(Array.from(parsed.entityIndex.byId.keys())).toEqual(actual.entityRefs.map(ref => ref.expressId));
    expect(parsed.malformedRecordCount).toBeUndefined();
    const payload = new WorkerIndexPublisher(true).serialize(parsed, true).payload;
    expect(new WorkerIndexReceiver().hydrate(structuredClone(payload), parsed.source).malformedRecordCount).toBeUndefined();
  });

});
