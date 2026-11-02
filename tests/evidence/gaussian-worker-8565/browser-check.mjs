// SPDX-License-Identifier: MPL-2.0
// Manual browser witness: evaluate this expression in the viewer Vite dev page.
// No GPU upload/production-build qualification is claimed. #8565
(async () => {
 const {decodeGaussianInWorker: decode} = await import('/src/hooks/ingest/gaussianWorker.ts');
 const original = window.Worker; let created=0, terminated=0; const checks=[];
 window.Worker = class extends original { constructor(...args){super(...args);created++;} terminate(){terminated++;super.terminate();} };
 const check=(condition,name)=>{if(!condition)throw new Error(name);checks.push(name);};
 const splat=()=>{const b=new Uint8Array(32),v=new DataView(b.buffer);[1,-2,3,2,3,4].forEach((x,i)=>v.setFloat32(i*4,x,true));b.set([128,64,255,128,255,128,128,128],24);return b;};
 const refusal=async(file,controller,pattern)=>{try{await decode(file,controller.signal);throw new Error('Unexpected success');}catch(e){check(pattern.test(e.message+' '+e.name),'refused: '+pattern.source);}};
 try {
  for(let i=0;i<10;i++){const r=await decode(new File([splat()],'capture.splat'),new AbortController().signal);check(r.count===1&&r.columns.x[0]===1&&r.columns.y[0]===-2&&r.columns.z[0]===3,'splat transfer '+i);}
  const names=['x','y','z','rot_0','rot_1','rot_2','rot_3','scale_0','scale_1','scale_2','opacity','f_dc_0','f_dc_1','f_dc_2',...Array.from({length:45},(_,i)=>'f_rest_'+i)];
  const bytes=new ArrayBuffer(names.length*4);const view=new DataView(bytes);names.forEach((name,i)=>view.setFloat32(i*4,name==='rot_0'?1:i/100,true));
  const header='ply\nformat binary_little_endian 1.0\nelement vertex 1\n'+names.map(n=>'property float '+n+'\n').join('')+'end_header\n';
  const sh=await decode(new File([header,bytes],'sh3.ply'),new AbortController().signal);
  check(sh.shDegree===3&&sh.columns.f_rest_44[0]===Math.fround(0.58),'SH3 transferred without truncation');
  const invalid=splat();new DataView(invalid.buffer).setFloat32(0,NaN,true);
  await refusal(new File([invalid],'nan.splat'),new AbortController(),/Non-finite/);
  await refusal(new File([new Uint8Array(31)],'truncated.splat'),new AbortController(),/Truncated/);
  const before=created,pre=new AbortController();pre.abort();
  await refusal(new File([splat()],'cancel.splat'),pre,/AbortError/);
  check(created===before,'pre-abort starts no worker');
  const live=new AbortController();const pending=refusal(new File([splat()],'cancel.splat'),live,/AbortError/);live.abort();await pending;
  check(created===terminated,'every created worker terminated on success/error/cancel');
  return {source:'4abef96f3ba7e69e618c4f850e8305fbe43805af',mode:'real T3 Chromium module worker via Vite dev; no renderer upload',checks,created,terminated,userAgent:navigator.userAgent};
 } finally {window.Worker=original;}
})();
