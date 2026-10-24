// SPDX-License-Identifier: MPL-2.0
// #7955: actual Worker chain witness. UNRUN until parent qualification.
import { assert, request, response, u32, f64 } from './contract.mjs';
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const near = (a,b,t,label) => assert(Number.isFinite(a) && Math.abs(a-b)<=t,label);
// Shared by the real Worker witness and packet-only regression fixtures.
// Bit8/v3 is owned affine-domain coverage after explicit trim reconstruction,
// not exact endpoint equality. It is output evidence, never reusable authority.
export function validatePlaneChainPacket(payload, consumed, plane, side, mode, semantic) {
  assert(payload.length>=312 && payload.length<=2488,'bounded chain certificate');
  const cert=new DataView(payload.buffer,payload.byteOffset,payload.byteLength);
  const count=cert.getUint32(308,true);
  assert(count<=16 && payload.length===312+136*count,'bounded chain certificate');
  const method=cert.getUint32(20,true),version=cert.getUint32(16,true);
  assert(method>0 && (method & ~15)===0,'chain certificate allowed method');
  assert(version===(method&8?3:1),'chain certificate version/method');
  assert(cert.getUint32(24,true)===1,'chain certificate frame');
  assert(cert.getUint32(28,true)===0,'chain certificate nonempty');
  assert(consumed.length===16 && payload.slice(32,48).every((v,i)=>v===consumed[i]),'chain bound input');
  assert(payload.slice(48,64).every((v,i)=>v===payload[i]),'chain bound output');
  assert(cert.getInt32(64,true)===side && cert.getUint32(68,true)===mode,'chain requested side/mode');
  assert(plane.length===6 && plane.every((v,i)=>f64(v).every((byte,j)=>byte===payload[84+8*i+j])),
    'chain original plane bits');
  assert(semantic.length===4 && new DataView(semantic.buffer,semantic.byteOffset,semantic.byteLength)
    .getUint32(0,true)===cert.getUint32(28,true),'chain semantic outcome');
  return {method,version};
}

// #7955 WIRE-J1B-01: corrupt real response copies, never SDK state. Each
// fault must reach its own assertion; an incidental RangeError is not a kill.
export function runPlaneChainPacketFaults(payload, consumed, plane, side, mode, semantic) {
  validatePlaneChainPacket(payload,consumed,plane,side,mode,semantic);
  const faults=[
    ['unknown-v3', 'chain certificate allowed method', (b,v)=>{v.setUint32(16,3,true);v.setUint32(20,24,true);}],
    ['unknown-v1', 'chain certificate allowed method', (b,v)=>{v.setUint32(16,1,true);v.setUint32(20,17,true);}],
    ['zero-method', 'chain certificate allowed method', (b,v)=>{v.setUint32(16,1,true);v.setUint32(20,0,true);}],
    ['version', 'chain certificate version/method', (b,v)=>v.setUint32(16,2,true)],
    ['frame', 'chain certificate frame', (b,v)=>v.setUint32(24,0,true)],
    ['empty', 'chain certificate nonempty', (b,v)=>v.setUint32(28,1,true)],
    ['side', 'chain requested side/mode', (b,v)=>v.setInt32(64,-side,true)],
    ['mode', 'chain requested side/mode', (b,v)=>v.setUint32(68,mode===2?3:2,true)],
    ['input', 'chain bound input', b=>{b[44]^=1;}],
    ['output', 'chain bound output', b=>{b[60]^=1;}],
    ['count', 'bounded chain certificate', (b,v)=>v.setUint32(308,17,true)],
  ];
  for(let i=0;i<6;i++) faults.push([`plane-${i}`, 'chain original plane bits', b=>{b[84+8*i]^=1;}]);
  const zero=plane.findIndex(v=>v===0);
  if(zero>=0) faults.push(['signed-zero', 'chain original plane bits', b=>{b[91+8*zero]^=128;}]);
  const killed=[];
  function reject(name, expected, b, outcome=semantic) {
    let message;
    try { validatePlaneChainPacket(b,consumed,plane,side,mode,outcome); }
    catch(error) { message=error.message; }
    assert(message===expected,`chain packet fault ${name}: expected ${expected}, got ${message ?? 'accepted'}`);
    killed.push(name);
  }
  for(const [name,expected,mutate] of faults) {
    const b=payload.slice(); mutate(b,new DataView(b.buffer)); reject(name,expected,b);
  }
  reject('semantic-empty','chain semantic outcome',payload,u32(1));
  reject('semantic-invalid','chain semantic outcome',payload,u32(2));
  reject('semantic-length','chain semantic outcome',payload,new Uint8Array(0));
  reject('truncated','bounded chain certificate',payload.slice(0,-1));
  const extra=new Uint8Array(payload.length+1); extra.set(payload);
  reject('trailing','bounded chain certificate',extra);
  return killed;
}

export async function runPlaneChainContract(client) {
  const incarnation=client.incarnation;
  const call=async(op,...fields)=>response((await client.batch([request(op,...fields)],incarnation))[0]);
  const results=[];
  for(const survey of [false,true]) for(const affine of [false,true]) for(const middle of [false,true]) {
    const session=await call(1);
    let failed=true;
    try {
      const origin=survey?[5000000,-2000000,100]:[7,-5,11];
      const source=await call(3,session,...[0,0,0,4,6,8].map(f64));
      const matrix=[2,0,0,0,0,3,0,0,0,0,.5,0,...origin,1];
      const input=affine?(await call(18,session,source,...matrix.map(f64))).slice(0,16):
        await call(3,session,...[...origin,4,6,8].map(f64));
      const lengths=affine?[8,18,4]:[4,6,8];
      const bounds=[...origin,...origin.map((v,d)=>v+lengths[d])];
      const handles=[input], boxes=[[...bounds]], cuts=[];
      const volume=async(h)=>new DataView((await call(6,session,h,f64(1e-8))).buffer).getFloat64(0,true);
      async function oracle(h,b) {
        const expected=(b[3]-b[0])*(b[4]-b[1])*(b[5]-b[2]);
        near(await volume(h),expected,Math.max(1e-12,expected*2e-5),'chain analytic volume');
        const mesh=await call(9,session,h,f64(.001),f64(5));
        const info=new DataView((await call(10,session,mesh)).buffer);
        const nv=info.getUint32(0,true),nt=info.getUint32(4,true);
        assert(nv>0 && nt>0 && [12,16,20].every(i=>info.getUint32(i,true)===0),'closed chain mesh');
        async function read(stream,count,width) {
          const bytes=new Uint8Array(count*width);
          for(let offset=0;offset<count;offset+=480) bytes.set(
            await call(11,session,mesh,u32(stream),u32(offset),u32(Math.min(480,count-offset))),offset*width);
          return new DataView(bytes.buffer);
        }
        const p=await read(1,3*nv,8),ix=await read(2,3*nt,4);
        const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity],moment=[0,0,0];
        for(let i=0;i<nv;i++) for(let d=0;d<3;d++) {
          const x=p.getFloat64((3*i+d)*8,true); lo[d]=Math.min(lo[d],x); hi[d]=Math.max(hi[d],x);
        }
        let total=0;
        for(let i=0;i<nt;i++) {
          const q=[0,1,2].map(j=>{
            const index=ix.getUint32((3*i+j)*4,true); assert(index<nv,'chain mesh index');
            return [0,1,2].map(d=>p.getFloat64((3*index+d)*8,true)-b[d]);
          });
          let det=0;
          for(let d=0;d<3;d++) det+=q[0][d]*(q[1][(d+1)%3]*q[2][(d+2)%3]-q[1][(d+2)%3]*q[2][(d+1)%3]);
          const v=det/6; total+=v;
          for(let d=0;d<3;d++) moment[d]+=v*(q[0][d]+q[1][d]+q[2][d])/4;
        }
        near(total,expected,expected*2e-3,'positive chain mesh volume');
        for(let d=0;d<3;d++) {
          near(lo[d],b[d],1e-6,'chain lower bound'); near(hi[d],b[d+3],1e-6,'chain upper bound');
          near(moment[d]/total,(b[d+3]-b[d])/2,1e-6,'chain centroid');
        }
        await call(8,session,mesh);
      }
      await oracle(input,bounds);
      for(let cut=0;cut<3;cut++) {
        const plane=[0,0,0,0,0,0]; plane[cut]=(bounds[cut]+bounds[cut+3])/2; plane[cut+3]=1;
        const consumed=handles.at(-1);
        const payload=await call(20,session,consumed,...plane.map(f64),u32(1),u32(2));
        const semantic=await call(19,session,payload.slice(0,16));
        const {method,version}=validatePlaneChainPacket(payload,consumed,plane,1,2,semantic);
        const packetFaults=runPlaneChainPacketFaults(payload,consumed,plane,1,2,semantic);
        cuts.push({cut,method,version,packetFaults});
        // Consume the fresh copy before any volume/mesh oracle: SDK volume
        // integration creates missing UV trims, legitimately enabling method2.
        if(!survey && !affine && middle && cut===1)
          assert((method&8)!==0 && version===3,'missing-trim chain requires method8/v3');
        bounds[cut]=plane[cut]; handles.push(payload.slice(0,16)); boxes.push([...bounds]);
        for(let i=0;i<handles.length;i++) await oracle(handles[i],boxes[i]);
        if(cut===0 && middle) {
          handles.push((await call(18,session,handles.at(-1),...identity.map(f64))).slice(0,16));
          // Checked with every predecessor after the next clip certifies the
          // untouched copy. Keep this ordering symmetric with the native test.
          boxes.push([...bounds]);
        }
      }
      for(const h of handles.slice(0,-1)) await call(8,session,h);
      // No domain authority is accepted from a caller or retained by slot.
      // Exercise a stale generation after actual slot reuse and a live handle
      // under another session through the same real Worker protocol.
      const replacement=await call(3,session,...[0,0,0,1,1,1].map(f64));
      const replayPlane=[0,0,0,1,0,0];
      response((await client.batch([request(20,session,handles[0],...replayPlane.map(f64),u32(1),u32(2))],incarnation))[0],3);
      const other=await call(1);
      try {
        response((await client.batch([request(20,other,handles.at(-1),...replayPlane.map(f64),u32(1),u32(2))],incarnation))[0],3);
      } finally { await call(2,other); }
      await call(8,session,replacement);
      near(await volume(source),192,192*2e-5,'source survives releases');
      await call(8,session,source); await oracle(handles.at(-1),bounds);
      results.push({survey,affine,middle,cuts,lifecycleFaults:['released-generation','foreign-session'],volume:await volume(handles.at(-1))});
      await call(8,session,handles.at(-1)); failed=false;
    } finally {
      try { await call(2,session); } catch(error) { if(!failed) throw error; }
    }
  }
  return results;
}
