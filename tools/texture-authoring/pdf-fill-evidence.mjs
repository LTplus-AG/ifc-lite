/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runPdfJob } from '../../apps/viewer/src/lib/appearance/pdf/engine.ts';
import { texturedProductSource } from '../../apps/viewer/src/test/textured-product-fixture.ts';
import { initSync, IfcAPI } from '../../packages/wasm/pkg/ifc-lite.js';
import { IfcParser } from '../../packages/parser/dist/index.js';
import { MutablePropertyView, StoreEditor } from '../../packages/mutations/dist/index.js';
import { StepExporter } from '../../packages/export/dist/index.js';
const require=createRequire(new URL('../../apps/viewer/package.json', import.meta.url));
const pdf=await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
initSync({module:await readFile(new URL('../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url))});
const api=new IfcAPI();
const backend={getDocument:pdf.getDocument,vectorDecoder:{version:pdf.version,ops:pdf.OPS},options:{disableFontFace:true,useSystemFonts:false},surface(){throw new Error('No raster in vector decode');}};
const [pdfPath, output, pageCountText = '2', toleranceText = '0.0001'] = process.argv.slice(2);
const pageCount = Number(pageCountText), toleranceMetres = Number(toleranceText);
if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 128 || !Number.isFinite(toleranceMetres) || toleranceMetres <= 0) throw new Error('Invalid evidence page count or metric tolerance');
if (!pdfPath || !output) throw new Error('Usage: pdf-fill-evidence.mjs control.pdf output-directory');
await mkdir(output, {recursive:true});
const source=new Uint8Array(await readFile(pdfPath));
try {
 for(let pageNumber = 1; pageNumber <= pageCount; pageNumber++){
  const decoded=await runPdfJob(backend,source,{kind:'vectors',request:{pageNumber,modelMetresFromPdf:[1/30,0,0,1/30,0,0],calibrationKey:'synthetic-control-30-pdf-units-per-metre',toleranceMetres}});
  if(decoded.kind!=='vectors')throw new Error('Wrong decoder response');
  const data=await new IfcParser().parseColumnar(texturedProductSource.slice().buffer,{disableWorkerScan:true});
  const view=new MutablePropertyView(data.properties,'pdf-fill'),editor=new StoreEditor(data,view);
  const request={schema:'IFC4',sourceRevision:'actual-pdf-control',nextExpressId:view.peekNextExpressId(),containerId:40,GlobalId:'0aaaaaaaaaaaaaaaaaaaaa',containmentGlobalId:'0bbbbbbbbbbbbbbbbbbbbb',Name:'Actual PDF fill control',frame:{origin:[2,3,4],axisU:[1,0,0],axisV:[0,0,1],sizeMetres:[8,8]},page:decoded.page};
  const result=JSON.parse(new TextDecoder().decode(api.planPdfFillAnnotation(texturedProductSource,JSON.stringify(request))));
  for(const row of result.plan.created){const actual=editor.addEntity(row.type,row.attributes);if(actual.expressId!==row.expressId)throw new Error('Allocation mismatch');}
  const step=await new StepExporter(data,view).exportAsync({schema:'IFC4',applyMutations:true,includeGeometry:true});
  const content=step.content;
  await writeFile(`${output}/page-${pageNumber}.ifc`,content);
  await writeFile(`${output}/page-${pageNumber}.json`,JSON.stringify({request,result},null,2));
  console.log(JSON.stringify({pageNumber,regions:result.regions.length,triangles:result.meshes.reduce((n,m)=>n+m.indices.length/3,0),sourceSha:decoded.page.pdfSha256,grid:result.gridSizeMetres,work:result.geometryWork}));
 }
}finally{api.free();}
