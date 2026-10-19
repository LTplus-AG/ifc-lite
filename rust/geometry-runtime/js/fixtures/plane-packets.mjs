// SPDX-License-Identifier: MPL-2.0
// Structural packet templates only. These are not native numerical evidence.
export function sourceExtension(original, count = 1) {
  const base = original.length, bytes = new Uint8Array(base + 16 + 1376*count);
  bytes.set(original);
  const view = new DataView(bytes.buffer), u = (i,v) => view.setUint32(i,v,true), f = (i,v) => view.setFloat64(i,v,true);
  u(16,2); u(20,view.getUint32(20,true)|8); u(72,32); u(80,512);
  u(base,count);u(base+4,1376);u(base+8,248);
  for (let n = 0; n < count; n++) {
    const r = base + 16 + 1376*n;
    for (const [i,v] of [[0,1],[4,n+1],[12,1],[16,2],[20,1],[28,4],[32,12]]) u(r+i,v);
    for (const [i,values] of [[48,[-0,0,0,-Number.MAX_VALUE,0,1,0,1,1,0,0,1,1,1,0,1]],
      [176,[0,0,1,1]],[208,[0,0,1,1]],[240,[0,0,0,1,1,0]],[288,[0,0,1,1]],
      [320,[0,1,-0,1,0,1,0,1]]]) values.forEach((v,j) => f(r+i+8*j,v));
    [[0,1],[1,3],[3,2],[2,0]].forEach(([start,end],j) => {
      const e = r + 384 + 248*j;
      u(e+4,start);u(e+8,end);
      const a = [start&1,start>>1,0], z = [end&1,end>>1,0];
      a.forEach((v,k) => {f(e+16+8*k,v);f(e+128+8*k,v);});
      z.forEach((v,k) => {f(e+48+8*k,v);f(e+152+8*k,v);});
      for (const i of [40,72,96,104,120]) f(e+i,1);
    });
  }
  return bytes;
}
export function planePacket(cylinders = 0) {
  const bytes = new Uint8Array(312 + 136*cylinders), v = new DataView(bytes.buffer);
  const u = (i,n) => v.setUint32(i,n,true), f = (i,n) => v.setFloat64(i,n,true);
  for (const base of [0,32,48]) {v.setBigUint64(base,42n,true);u(base+8,base === 32 ? 1 : 2);u(base+12,1);}
  for (const [i,n] of [[16,1],[20,cylinders ? 5 : 1],[24,1],[64,1],[68,2],[72,32],[76,64],[80,512],[308,cylinders]]) u(i,n);
  for (const [base,values] of [[84,[0,0,0.5,0,0,1]],[132,[1,0,0,0,1,0,0,0,1]],
    [204,[-1,-1,0,1,1,1]],[252,[-2,-2,0,2,2,2]]]) values.forEach((n,i) => f(base+8*i,n));
  f(300,1e-6);
  for (let i = 0; i < cylinders; i++) {
    const base = 312+136*i;
    u(base,i === 0 ? 0 : 16+i);
    for (const j of [0,4,8]) f(base+40+8*j,1);
    f(base+112,1);f(base+128,1);
  }
  return bytes;
}
