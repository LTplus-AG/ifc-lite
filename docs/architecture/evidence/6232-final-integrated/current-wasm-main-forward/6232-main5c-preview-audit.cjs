const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root='/tmp/6232-final-main5c-preview-diagnostic', expected='730f9e6da331c46febc31eded37d131a8f862b9a',wasm='a050aed5572273e63c8a08a243f5ebe6180da0ea202875e6cf97b7e6d726b23b';
const receipts=[];
for(const command of ['align','move','rotate'])for(const count of [1,2]){
 const dir=path.join(root,`registered-${command}-preview`), file=path.join(dir,`${count}-browser.json`),bytes=fs.readFileSync(file),r=JSON.parse(bytes),s=JSON.parse(fs.readFileSync(path.join(dir,`${count}-runtime.json`))).started;
 assert.equal(r.source.head,expected);assert.equal(r.source.dirty,'');assert.equal(r.source.wasmSHA256,wasm);assert.equal(r.count,count);assert.equal(r.proofs.length,command==='align'?4:5);
 assert.ok(r.wasmResponses.some(x=>x.sha256===wasm&&x.status===200));assert.ok(r.calls.every(x=>!x.reply.error));
 assert.equal(s.loadedViewBefore,true);assert.equal(s.editorPresentBefore,false);assert.equal(s.loadedViewRetained,true);assert.equal(s.effectiveOverlayEmpty,true);assert.deepEqual(s.journal,[]);assert.deepEqual(s.records,[]);assert.ok(s.ghostCount>0&&s.ghostsFinite);assert.deepEqual(s.roots,[1222]);assert.ok(s.carried.includes(1407));assert.equal(s.allocator,9993);
 const target=p=>p.models.find(x=>x.modelId===r.modelId),peer=p=>p.models.filter(x=>x.modelId!==r.modelId),base=target(r.proofs[0]);assert.equal(peer(r.proofs[0]).length,count-1);assert.equal(base.allocator,1);
 for(const p of r.proofs){const t=target(p);assert.deepEqual(peer(p),peer(r.proofs[0]));for(const key of ['canonicalGraph','meshes','records','journal','undo','redo','undoRows','redoRows'])assert.deepEqual(t[key],base[key],key);if(['preview-native-source','registered-preview','cancelled-preview'].includes(p.stage))assert.equal(t.allocator,s.allocator);}
 assert.equal(r.proofs.at(-1).stage,'cancelled-preview');
 receipts.push({command,count,path:file,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),stages:r.proofs.length,source:r.source.head,canonicalAllocatorInitialization:[1,9993],noAllocationAfterInitialization:true,graphGeometryOverlayHistoryPeerUnchanged:true});
}
const out={source:expected,wasm,receipts,count:receipts.length,stages:receipts.reduce((n,r)=>n+r.stages,0),scope:'Real registered first-authoring preview and Escape cancellation; loaded empty view, not missing-view browser reproduction. Native missing-view controls and independent-reference commit controls separate.',exit:0};fs.writeFileSync('/tmp/6232-final-main5c-preview-audit.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({count:out.count,stages:out.stages,verdict:'PASS'}));
