/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stitchShards } from '../../packages/geometry/dist/shard-stitch.js';

export function runMalformedApostropheContracts(api, test) {
  const text = readFileSync(new URL('../../tests/fixtures/step-apostrophe-pair.ifc', import.meta.url), 'utf8');
  test('#7541 real WASM text and byte scans report malformed pair and retain genuine wall 22', () => {
    const bytes = new TextEncoder().encode(text);
    for (const refs of [api.scanEntitiesFast(text), api.scanEntitiesFastBytes(bytes)]) {
      assert.ok(Array.isArray(refs));
      assert.deepEqual(refs.map(ref => ref.expressId), [1, 2, 3, 21, 22, 31]);
      assert.equal(refs.malformedRecordCount, 1);
      for (const ref of refs) {
        const span = new TextDecoder().decode(bytes.subarray(ref.byteOffset, ref.byteOffset + ref.byteLength));
        assert.equal(span, text.split('\n').find(line => line.startsWith(`#${ref.expressId}=`)));
      }
    }
  });
  test('#7541 legal escaped control retains every original WASM record', () => {
    const clean = text.replace("it's", "it''s").replace("Bob's", "Bob''s");
    for (const refs of [api.scanEntitiesFast(clean), api.scanEntitiesFastBytes(new TextEncoder().encode(clean))]) {
      assert.deepEqual(refs.map(ref => ref.expressId), [1, 2, 3, 20, 21, 22, 30, 31]);
      assert.equal(refs.malformedRecordCount, 0);
    }
  });
  test('#7541 WASM does not fabricate a declaration from a later quoted parameter', () => {
    const input = "#1=A('it's','valid;\n#999=B($);');\n#2=B($);";
    for (const refs of [api.scanEntitiesFast(input), api.scanEntitiesFastBytes(new TextEncoder().encode(input))]) {
      assert.deepEqual(refs.map(ref => ref.expressId), [2]);
      assert.equal(refs.malformedRecordCount, 1);
    }
  });

  test('#7541 real WASM refuses unclosed quote-suffix comments without minting their declarations', () => {
    const input = "#1=A('a' /* 'ghost',\n#999=B($);\n#2=B($);";
    for (const refs of [api.scanEntitiesFast(input), api.scanEntitiesFastBytes(new TextEncoder().encode(input))]) {
      assert.deepEqual(refs.map(ref => ref.expressId), []);
      assert.equal(refs.malformedRecordCount, 1);
    }
  });

  test('#7541 actual classified WASM shards carry all malformed offsets into authoritative stitching', () => {
    for (const clean of [false, true]) {
      const input = clean ? text.replace("it's", "it''s").replace("Bob's", "Bob''s") : text;
      const bytes = new TextEncoder().encode(input);
      const serial = api.scanEntitiesFastBytes(bytes);
      const whole = api.scanEntityIndexShard(bytes, 0, bytes.length);
      assert.deepEqual(Array.from(whole.ids), serial.map(ref => ref.expressId));
      assert.ok(whole.malformedRecordStarts instanceof Uint32Array);
      assert.equal(whole.malformedRecordStarts.length, clean ? 0 : 2);
      try {
        api.setSourceBytes(bytes);
        const owned = api.scanEntityIndexShardFromSource(0, bytes.length);
        assert.deepEqual(Array.from(owned.ids), Array.from(whole.ids));
        assert.deepEqual(Array.from(owned.malformedRecordStarts), Array.from(whole.malformedRecordStarts));
      } finally {
        api.clearPrePassCache();
      }
      for (const boundary of [bytes.length, input.indexOf('#21='), input.indexOf('#22=')]) {
        const shards = boundary === bytes.length ? [whole] : [
          api.scanEntityIndexShard(bytes, 0, boundary),
          api.scanEntityIndexShard(bytes, boundary, bytes.length),
        ];
        const stitched = stitchShards(shards);
        assert.ok(stitched, 'actual known record boundaries must be stitchable');
        assert.deepEqual(Array.from(stitched.ids), serial.map(ref => ref.expressId));
        assert.equal(stitched.malformedRecordCount, clean ? 0 : 1);
      }
    }
  });

  test('#7541 actual serial WASM prepass reports its established malformed boolean', () => {
    for (const clean of [false, true]) {
      const input = clean ? text.replace("it's", "it''s").replace("Bob's", "Bob''s") : text;
      const bytes = new TextEncoder().encode(input);
      const indexes = [];
      try {
        api.buildPrePassStreaming(bytes, event => { if (event.type === 'entity-index') indexes.push(event); }, 4096);
        assert.equal(indexes.length, 1);
        assert.equal(indexes[0].malformedRecordFound, !clean);
        assert.deepEqual(Array.from(indexes[0].ids), clean ? [1, 2, 3, 20, 21, 22, 30, 31] : [1, 2, 3, 21, 22, 31]);
      } finally {
        api.clearPrePassCache();
      }
    }
  });

  test('#7541 genuine speculative shard offsets cannot hide a later retained malformed record', () => {
    for (const broken of [false, true]) {
      const input = "DATA;\n#1=A('safe;\n#8=B(''bad''quote);\n#9=C($);\nmore');\n#2=B($);\n"
        + (broken ? "#3=A('it's');\n" : "#3=A('it''s');\n") + "#4=B($);\nENDSEC;";
      const bytes = new TextEncoder().encode(input);
      const boundary = input.indexOf('#8=');
      const shards = [api.scanEntityIndexShard(bytes, 0, boundary), api.scanEntityIndexShard(bytes, boundary, bytes.length)];
      const serial = api.scanEntitiesFastBytes(bytes);
      assert.deepEqual(serial.map(ref => ref.expressId), broken ? [1, 2, 4] : [1, 2, 3, 4]);
      assert.ok(Array.from(shards[1].ids).includes(2));
      assert.ok(Array.from(shards[1].ids).includes(4));
      assert.ok(shards[1].malformedRecordStarts[0] < input.indexOf('#2='), 'actual producer must report its speculative prefix');
      if (broken) assert.ok(Array.from(shards[1].malformedRecordStarts).includes(input.indexOf('#3=')), 'later real omission must survive after the prefix report');
      const stitched = stitchShards(shards);
      assert.ok(stitched);
      assert.deepEqual(Array.from(stitched.ids), serial.map(ref => ref.expressId));
      assert.equal(stitched.malformedRecordCount, broken ? 1 : 0);
    }
  });

}
