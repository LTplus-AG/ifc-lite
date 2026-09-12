/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Offline F8 fidelity-report evidence (#4406). Decodes one PDF page with the
 * pinned viewer adapter and records the canonical `IfcAPI.preparePdfVectorPage`
 * verdict: convertible paths, omission kinds with counts, visibility and
 * page-space extent, exact / raster-only. It converts nothing and the record
 * contains no page content, only counts, extents and digests.
 *
 *   TSX_TSCONFIG_PATH=apps/viewer/tsconfig.json node --import tsx \
 *     --import ./apps/viewer/src/test/vite-module-hooks.mjs \
 *     tools/texture-authoring/pdf-fidelity-evidence.mjs <input.pdf | control:<name>> <page> <output.json> [accepted.ifc]
 *
 * `control:<name>` builds one of the CC0 controlled pages from
 * apps/viewer/src/lib/appearance/pdf/fixtures.ts instead of reading a file.
 * With `accepted.ifc`, a convertible page is also planned against the textured
 * product fixture — quoting the report digest as the user's acceptance when the
 * page is partial — applied through StoreEditor and exported with StepExporter,
 * so an independent reader can check the provenance property set. Beside it,
 * `<accepted>-plan.json` records the native plan geometry and, for a control,
 * `<accepted>.pdf` the CC0 source bytes, so `pdf-fidelity-oracle.py` can
 * compare an independent raster of the page against the native output.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runPdfJob } from '../../apps/viewer/src/lib/appearance/pdf/engine.ts';
import { fidelityControlPdf } from '../../apps/viewer/src/lib/appearance/pdf/fixtures.ts';
import { texturedProductSource } from '../../apps/viewer/src/test/textured-product-fixture.ts';
import { initSync, IfcAPI } from '../../packages/wasm/pkg/ifc-lite.js';
import { IfcParser } from '../../packages/parser/dist/index.js';
import { MutablePropertyView, StoreEditor } from '../../packages/mutations/dist/index.js';
import { StepExporter } from '../../packages/export/dist/index.js';

const require = createRequire(new URL('../../apps/viewer/package.json', import.meta.url));
const pdf = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const [input, pageText = '1', output, ifcOutput] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: pdf-fidelity-evidence.mjs <input.pdf | control:<name>> <page> <output.json> [accepted.ifc]');
const pageNumber = Number(pageText);
if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 10_000) throw new Error('Invalid page number');
const control = input.startsWith('control:') ? input.slice('control:'.length) : null;
const source = control ? fidelityControlPdf(control) : new Uint8Array(await readFile(input));
if (source.length > 64 * 1024 * 1024) throw new Error('PDF exceeds the evidence-tool byte budget');
initSync({ module: await readFile(new URL('../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)) });
const api = new IfcAPI();
const backend = { getDocument: pdf.getDocument, vectorDecoder: { version: pdf.version, ops: pdf.OPS },
  options: { disableFontFace: true, useSystemFonts: false }, surface() { throw new Error('No raster in vector decode'); } };
// Nominal evidence calibration: report extents are PDF user-space points regardless of it; only the
// metric tolerance and the bound calibration identity depend on it.
// PDF_FIDELITY_TOLERANCE_METRES overrides the declared tolerance (a curved control planned at 0.1 mm exceeds the composition budget).
const toleranceOverride = process.env.PDF_FIDELITY_TOLERANCE_METRES ? Number(process.env.PDF_FIDELITY_TOLERANCE_METRES) : null;
if (toleranceOverride !== null && !(toleranceOverride > 0 && toleranceOverride <= 0.1)) throw new Error('PDF_FIDELITY_TOLERANCE_METRES must be in (0, 0.1]');
const calibration = control
  ? { modelMetresFromPdf: [1 / 30, 0, 0, 1 / 30, 0, 0], calibrationKey: 'synthetic-control-30-pdf-units-per-metre', toleranceMetres: toleranceOverride ?? 0.0001 }
  : { modelMetresFromPdf: [0.01, 0, 0, 0.01, 0, 0], calibrationKey: 'evidence-nominal-100-pdf-units-per-metre', toleranceMetres: toleranceOverride ?? 0.001 };
try {
  const decoded = await runPdfJob(backend, source, { kind: 'vectors', request: { pageNumber, ...calibration } });
  if (decoded.kind !== 'vectors') throw new Error('Wrong decoder response');
  const page = decoded.page;
  const prepared = JSON.parse(new TextDecoder().decode(api.preparePdfVectorPage(JSON.stringify(page))));
  const operators = {};
  for (const { operation } of page.operations) operators[operation.kind] = (operators[operation.kind] ?? 0) + 1;
  const { omissions, ...fidelity } = prepared.fidelity;
  const record = {
    input: control ? `control:${control}` : input.replace(/\\/g, '/').split('/').pop(),
    sourceBytes: source.length, sourceSha256: createHash('sha256').update(source).digest('hex'),
    decoderVersion: page.decoderVersion, pageNumber, viewBox: page.viewBox, userUnit: page.userUnit, intrinsicRotation: page.intrinsicRotation,
    calibration, operations: page.operations.length, operators,
    preparation: { algorithm: prepared.algorithm, requestSha256: prepared.requestSha256, pageClipPdf: prepared.pageClipPdf },
    fidelity: { ...fidelity, listedOmissions: omissions.length },
  };
  if (ifcOutput) {
    const data = await new IfcParser().parseColumnar(texturedProductSource.slice().buffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(data.properties, 'pdf-fidelity'), editor = new StoreEditor(data, view);
    const request = { schema: 'IFC4', sourceRevision: 'fidelity-evidence', nextExpressId: view.peekNextExpressId(), containerId: 40,
      GlobalId: '0aaaaaaaaaaaaaaaaaaaaa', containmentGlobalId: '0bbbbbbbbbbbbbbbbbbbbb', propertySetGlobalId: '0cccccccccccccccccccc1',
      propertyRelationGlobalId: '0cccccccccccccccccccc2', Name: `PDF fidelity evidence ${record.input}`,
      frame: { origin: [2, 3, 4], axisU: [1, 0, 0], axisV: [0, 0, 1], sizeMetres: [8, 8] }, page,
      acceptedFidelitySha256: fidelity.exact ? null : fidelity.sha256 };
    const plan = JSON.parse(new TextDecoder().decode(api.planPdfFillAnnotation(texturedProductSource, JSON.stringify(request))));
    for (const row of plan.plan.created) { if (editor.addEntity(row.type, row.attributes).expressId !== row.expressId) throw new Error('Allocation mismatch'); }
    const step = await new StepExporter(data, view).exportAsync({ schema: 'IFC4', applyMutations: true, includeGeometry: true });
    await writeFile(ifcOutput, typeof step.content === 'string' ? step.content : Buffer.from(step.content));
    const planOutput = ifcOutput.replace(/\.ifc$/, '') + '-plan.json';
    await writeFile(planOutput, `${JSON.stringify({ pageNumber, viewBox: page.viewBox, intrinsicRotation: page.intrinsicRotation, userUnit: page.userUnit,
      modelMetresFromPdf: calibration.modelMetresFromPdf, frame: request.frame, rtcOffset: plan.rtcOffset, coordinateSpace: plan.coordinateSpace,
      annotationId: plan.annotationId, regions: plan.regions, fidelity: { exact: fidelity.exact, summary: fidelity.summary },
      meshes: plan.meshes.map(mesh => ({ positions: mesh.positions, indices: mesh.indices, color: mesh.color, origin: mesh.origin ?? [0, 0, 0] })) })}\n`);
    if (control) await writeFile(ifcOutput.replace(/\.ifc$/, '') + '.pdf', source);
    record.accepted = { ifc: ifcOutput.replace(/\\/g, '/').split('/').pop(), plan: planOutput.replace(/\\/g, '/').split('/').pop(),
      annotationId: plan.annotationId, propertySetId: plan.propertySetId,
      regions: plan.regions.length, requestSha256: plan.requestSha256, acceptedFidelitySha256: request.acceptedFidelitySha256 };
  }
  await writeFile(output, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ input: record.input, exact: fidelity.exact, rasterOnly: fidelity.rasterOnly, convertiblePaths: fidelity.convertiblePaths,
    summary: fidelity.summary.map(entry => `${entry.kind}:${entry.visibleCount}/${entry.count}`) }));
} finally { api.free(); }
