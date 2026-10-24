// SPDX-License-Identifier: MPL-2.0
// #7955 WIRE-J1B-01: packet behavior only, no numerical/Worker qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { u32, f64 } from '../native/smlib-adapter/browser/contract.mjs';
import { validatePlaneChainPacket, runPlaneChainPacketFaults } from '../native/smlib-adapter/browser/plane-chain-contract.mjs';

function fixture(method, version) {
  const consumed=new Uint8Array(16); consumed.set(u32(42)); consumed.set(u32(1),8); consumed.set(u32(3),12);
  const output=consumed.slice(); output.set(u32(2),8); output.set(u32(7),12);
  const payload=new Uint8Array(312); payload.set(output); payload.set(consumed,32); payload.set(output,48);
  const view=new DataView(payload.buffer);
  for(const [offset,value] of [[16,version],[20,method],[24,1],[64,1],[68,2]]) view.setUint32(offset,value,true);
  const plane=[0,0,.5,0,0,1]; plane.forEach((v,i)=>payload.set(f64(v),84+8*i));
  return [payload,consumed,plane,1,2,u32(0)];
}
for(const [method,version] of [[1,1],[8,3]]) {
  test(`#7955 chain certificate v${version} rejects targeted packet faults`,()=>{
    const args=fixture(method,version);
    assert.deepEqual(validatePlaneChainPacket(...args),{method,version});
    const kills=runPlaneChainPacketFaults(...args);
    assert.equal(kills.length,23);
    assert.equal(new Set(kills).size,kills.length);
  });
}
