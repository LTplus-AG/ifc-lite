// SPDX-License-Identifier: MPL-2.0
// Memory/transport packets only; no native SDK or numerical oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchOwned } from './module.mjs';
import { SmlibWorkerTransport } from './client.mjs';
function request(opcode,size = 12) {
  const b = new ArrayBuffer(size), v = new DataView(b);
  v.setUint32(0,1,true);v.setUint32(4,7,true);v.setUint32(8,opcode,true);return b;
}
function allocation(size,status = 0) {
  const HEAPU8 = new Uint8Array(65536), view = new DataView(HEAPU8.buffer), freed = [];
  let next = 64;
  return { HEAPU8, freed, _malloc(n) {const p = next;next += n;return p;}, _free(p) {freed.push(p);},
    _ifclite_smlib_dispatch_owned(_p,_n,out,length) {
      view.setUint32(out,8192,true);view.setUint32(length,size,true);
      view.setUint32(8192,1,true);view.setUint32(8196,7,true);view.setInt32(8200,status,true);return 0;
    },
  };
}
test('owned module allows only opcode20 bounded success; frees every allocation on rejection', () => {
  for (const [opcode,size,status,accepted] of [[20,24532,0,true],[20,24533,0,false],
    [19,4097,0,false],[18,24532,0,false],[20,4097,7,false],[20,4097,8,false],[19,4096,0,true]]) {
    const module = allocation(size,status);
    if (accepted) assert.equal(dispatchOwned(module,request(opcode)).byteLength,size);
    else assert.throws(() => dispatchOwned(module,request(opcode)));
    assert.equal(module.freed.length,3);
  }
  const module = allocation(12);
  assert.throws(() => dispatchOwned(module,request(20,4097)),/request frame/);
  assert.deepEqual(module.freed,[]);
});
class Peer {
  static last;
  constructor() {Peer.last = this;}
  terminate() {this.terminated = true;}
  postMessage(message,transfers) {this.message = structuredClone(message,{transfer:transfers});}
  reply(sizes,status = 0) {
    this.onmessage({data:{id:this.message.id,frames:sizes.map(size => {
      const b = new ArrayBuffer(size), v = new DataView(b);v.setUint32(0,1,true);v.setInt32(8,status,true);return b;
    })}});
  }
}
test('client captures per-command response caps before transfer and retires invalid batches', async () => {
  const old = globalThis.Worker;globalThis.Worker = Peer;
  try {
    for (const [opcodes,sizes,status,accepted] of [[[20,19],[24532,4096],0,true],
      [[19,20],[24532,12],0,false],[[20],[24533],0,false],[[20],[4097],8,false]]) {
      const client = new SmlibWorkerTransport(), incarnation = client.incarnation;
      const frames = opcodes.map(op => request(op)), pending = client.batch(frames,incarnation);
      assert.ok(frames.every(f => f.byteLength === 0));
      Peer.last.reply(sizes,status);
      if (accepted) {assert.equal((await pending)[0].byteLength,sizes[0]);assert.equal(client.incarnation,incarnation);}
      else {await assert.rejects(pending,/invalid worker response/);assert.equal(client.incarnation,undefined);assert.ok(Peer.last.terminated);}
      client.dispose();
    }
    const client = new SmlibWorkerTransport(), frame = request(20,4097);
    await assert.rejects(client.batch([frame],client.incarnation),/invalid frame batch/);
    assert.equal(frame.byteLength,4097);client.dispose();
  } finally {globalThis.Worker = old;}
});
