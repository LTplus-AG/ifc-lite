// SPDX-License-Identifier: MPL-2.0
// Actual parser, synthetic packets. No geometry or browser qualification claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planeCertificate } from './plane-certificate.mjs';
import { planePacket, sourceExtension } from './fixtures/plane-packets.mjs';
const parse = bytes => planeCertificate(bytes,planePacket().slice(32,48),[0,0,0.5,0,0,1],1,2);
test('frozen v1/v2 packets: max layout and immutable raw sentinel/signed-zero evidence', () => {
  for (const cylinders of [0,1,16]) {
    assert.equal(parse(planePacket(cylinders)).version,1);
    for (const count of [1,16]) {
      const b = sourceExtension(planePacket(cylinders),count), c = parse(b), r = c.rectangles[0];
      assert.equal(c.version,2);assert.equal(c.rectangles.length,count);
      assert.equal(r.controls[3],-Number.MAX_VALUE);assert.ok(Object.is(r.controls[0],-0));
      assert.ok(Object.is(r.inverse[2],-0));
      assert.deepEqual(r.edges[0].knots,[0,0,1,1]);
      b.fill(0);assert.equal(r.controls[3],-Number.MAX_VALUE);
      assert.throws(() => {r.controls[0] = 7;},TypeError);
      assert.throws(() => {r.edges[0].flags = 3;},TypeError);
    }
  }
  assert.equal(sourceExtension(planePacket(16),16).length+12,24532);
});
test('v2 parser rejects layout, flags, inventory, stale identity and coefficient drift', () => {
  const original = sourceExtension(planePacket(1),2), base = 448, r = base+16;
  for (const [i,n] of [[16,1],[16,3],[20,5],[20,24],[base,0],[base,17],[base,0xffffffff],
    [base+4,1375],[base+8,247],[base+12,1],[r,2],[r+4,32],[r+4,0],[r+12,0],
    [r+20,2],[r+24,1],[r+28,3],[r+32,13],[r+36,1],[r+40,1],[r+44,1],[r+1376+4,1],
    [r+384,4],[r+384,2],[r+388,4],[r+392,2],[r+396,1],[r+384+248+4,0],[44,2],[60,0]]) {
    const b = original.slice();new DataView(b.buffer).setUint32(i,n,true);assert.throws(() => parse(b),`${i}: ${n}`);
  }
  for (const [i,n] of [[r+48,NaN],[r+72,2],[r+176,2],[r+240,2],[r+288,0.1],
    [r+336,0],[r+384+16,Infinity],[r+384+80,2],[r+384+112,1],[r+384+176,1],[r+384+128,0.5],[r+384+16,-1]]) {
    const b = original.slice();new DataView(b.buffer).setFloat64(i,n,true);assert.throws(() => parse(b),`${i}: ${n}`);
  }
  for (const length of [0,1,311,312,base,base+15,original.length-1]) assert.throws(() => parse(original.slice(0,length)));
  const extra = new Uint8Array(original.length+1);extra.set(original);assert.throws(() => parse(extra));
});
test('boundary flag bits and raw canonical fields are retained', () => {
  const bytes = sourceExtension(planePacket()), e = 328+384, v = new DataView(bytes.buffer);
  v.setUint32(e,3,true);v.setFloat64(e+200,1,true);v.setFloat64(e+232,1,true);v.setFloat64(e+240,1,true);
  const edge = parse(bytes).rectangles[0].edges[0];
  assert.equal(edge.flags,3);assert.deepEqual(edge.step,[0,1]);assert.equal(edge.scale,1);
});
