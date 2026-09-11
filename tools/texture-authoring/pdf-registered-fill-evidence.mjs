/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Replay a frozen host registration with original decoder bytes and ordinary
// StoreEditor/STEP export. No registration or IFC geometry is fabricated here.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runPdfJob } from '../../apps/viewer/src/lib/appearance/pdf/engine.ts';
import { initSync, IfcAPI } from '../../packages/wasm/pkg/ifc-lite.js';
import { IfcParser } from '../../packages/parser/dist/index.js';
import { MutablePropertyView, StoreEditor } from '../../packages/mutations/dist/index.js';
import { StepExporter } from '../../packages/export/dist/index.js';
const [pdfPath, ifcPath, requestPath, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: pdf-registered-fill-evidence.mjs source.pdf source.ifc request.json output-directory');
const require=createRequire(new URL('../../apps/viewer/package.json',import.meta.url));
const pdf=await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
const request=JSON.parse(await readFile(requestPath,'utf8'));
const originalPdf=new Uint8Array(await readFile(pdfPath));
const source=new Uint8Array(await readFile(ifcPath));
const backend={getDocument:pdf.getDocument,vectorDecoder:{version:pdf.version,ops:pdf.OPS},options:{disableFontFace:true,useSystemFonts:false},surface(){throw new Error('No raster requested');}};
const page=request.page;
const decoded=await runPdfJob(backend,originalPdf,{kind:'vectors',request:{pageNumber:page.pageNumber,modelMetresFromPdf:page.modelMetresFromPdf,calibrationKey:page.calibrationKey,toleranceMetres:page.toleranceMetres}});
if(decoded.kind!=='vectors'||!isDeepStrictEqual(decoded.page,page))throw new Error('Frozen request does not match original PDF decoder output');
initSync({module:await readFile(new URL('../../packages/wasm/pkg/ifc-lite_bg.wasm',import.meta.url))});
const api=new IfcAPI();
try {
 const result=JSON.parse(new TextDecoder().decode(api.planPdfFillAnnotation(source,JSON.stringify(request))));
 if(result.sourceIfcSha256!==createHash('sha256').update(source).digest('hex'))throw new Error('Source IFC binding mismatch');
 if(result.plan.edits.length||result.plan.removed.length)throw new Error('Registered creation evidence requires a creation-only plan');
 const data=await new IfcParser().parseColumnar(source.slice().buffer,{disableWorkerScan:true});
 const view=new MutablePropertyView(data.properties,'registered-page'),editor=new StoreEditor(data,view);
 if(view.peekNextExpressId()!==request.nextExpressId)throw new Error('Frozen allocation no longer matches source');
 for(const row of result.plan.created){const entity=editor.addEntity(row.type,row.attributes);if(entity.expressId!==row.expressId)throw new Error('Allocation mismatch');}
 const exported=await new StepExporter(data,view).exportAsync({schema:'IFC4',applyMutations:true,includeGeometry:true});
 await mkdir(output,{recursive:true});
 await writeFile(`${output}/registered.ifc`,exported.content);
 await writeFile(`${output}/registered.json`,JSON.stringify({request,result},null,2));
 console.log(JSON.stringify({sourcePdfSha256:page.pdfSha256,sourceIfcSha256:result.sourceIfcSha256,regions:result.regions.length,triangles:result.meshes.reduce((n,m)=>n+m.indices.length/3,0),geometryWork:result.geometryWork}));
} finally {api.free();}
