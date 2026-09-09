/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Offline F8 evidence tool (#4406), not a converter or a production fidelity classifier.
 * node tools/texture-authoring/pdf-vector-census.mjs input.pdf [page=1]
 * Requires the workspace's installed, pinned viewer PDF.js dependency.
 * Decode happens in a disposable worker with a 60s deadline and 256MiB JS heap.
 * Full PDF.js operator-list allocation precedes census budgets; those budgets do
 * not establish a bounded browser import path or bound native decoder memory.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const limits = { bytes: 64 * 1024 * 1024, operations: 100_000, pathNumbers: 2_000_000, deadlineMs: 60_000 };
const expectedVersion = '6.3.289';
const requireViewer = createRequire(new URL('../../apps/viewer/package.json', import.meta.url));

async function inspect(input, pageNumber) {
  const size = (await stat(input)).size;
  if (size > limits.bytes) throw new Error('PDF exceeds the evidence-tool byte budget');
  const bytes = new Uint8Array(await readFile(input));
  if (bytes.length > limits.bytes) throw new Error('PDF changed beyond byte budget while reading');
  const sourceBytes = bytes.length;
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const { getDocument, OPS, version } = await import(pathToFileURL(requireViewer.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  if (version !== expectedVersion) throw new Error(`Requalify operator encoding before using PDF.js ${version}`);
  const loading = getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const document = await loading.promise;
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) throw new Error('Invalid page number');
    const page = await document.getPage(pageNumber);
    const list = await page.getOperatorList({ intent: 'display' });
    if (list.fnArray.length !== list.argsArray.length || list.fnArray.length > limits.operations) throw new Error('Operator-list budget/shape refused');
    const names = new Map(Object.entries(OPS).map(([name, id]) => [id, name]));
    const operators = {}, pathCommands = {}, paints = {};
    let totalNumbers = 0, saveDepth = 0, maxSaveDepth = 0;
    const arities = [2, 2, 6, 4, 0];
    const drawNames = ['moveTo', 'lineTo', 'curveTo', 'quadraticCurveTo', 'closePath'];
    for (let i = 0; i < list.fnArray.length; i++) {
      const name = names.get(list.fnArray[i]);
      if (!name) throw new Error(`Unknown operator ${list.fnArray[i]}`);
      operators[name] = (operators[name] ?? 0) + 1;
      if (name === 'save') maxSaveDepth = Math.max(maxSaveDepth, ++saveDepth);
      if (name === 'restore' && --saveDepth < 0) throw new Error('Unbalanced graphics-state restore');
      if (name !== 'constructPath') continue;
      const args = list.argsArray[i];
      if (!Array.isArray(args) || args.length !== 3 || !Array.isArray(args[1])) throw new Error('Unqualified constructPath layout');
      const paint = names.get(args[0]);
      if (!paint) throw new Error('Unknown path paint operation');
      paints[paint] = (paints[paint] ?? 0) + 1;
      const path = args[1][0];
      if (!path && !args[2]) continue; // Empty path consumes pending paint/clip state.
      if (!(path instanceof Float32Array)) throw new Error('Unqualified path buffer type');
      totalNumbers += path.length;
      if (totalNumbers > limits.pathNumbers) throw new Error('Path-number budget refused');
      for (let at = 0; at < path.length;) {
        const opcode = path[at++];
        const arity = arities[opcode];
        if (arity === undefined || at + arity > path.length) throw new Error('Unknown/truncated DrawOPS command');
        const command = drawNames[opcode];
        pathCommands[command] = (pathCommands[command] ?? 0) + 1;
        for (let j = 0; j < arity; j++) if (!Number.isFinite(path[at++])) throw new Error('Non-finite path coordinate');
      }
    }
    if (saveDepth !== 0) throw new Error('Unbalanced graphics-state save');
    const categories = {
      clipping: ['clip', 'eoClip'],
      text: ['showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText'],
      groups: ['beginGroup'], forms: ['paintFormXObjectBegin'],
      optionalContent: ['beginMarkedContentProps'],
      graphicsState: ['setGState'],
      rasterImages: ['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintImageXObjectRepeat', 'paintImageMaskXObjectRepeat', 'paintSolidColorImageMask', 'paintInlineImageXObjectGroup', 'paintImageMaskXObjectGroup'],
      shading: ['shadingFill', 'setFillColorN', 'setStrokeColorN'],
    };
    return {
      purpose: 'operator inventory only; no conversion or fidelity verdict',
      sourceSha256, sourceBytes, pdfjs: version, pageNumber, pageCount: document.numPages,
      page: { viewBox: page.view, userUnit: page.userUnit, rotation: page.rotate, pdfToPage: page.getViewport({ scale: 1 }).transform },
      operationCount: list.fnArray.length, operators, paints, pathCommands, totalPathNumbers: totalNumbers, maxExplicitSaveDepth: maxSaveDepth,
      fidelityWork: Object.fromEntries(Object.entries(categories).map(([category, ops]) => [category, ops.reduce((sum, op) => sum + (operators[op] ?? 0), 0)])),
      limits,
      caveats: ['Paint counts do not measure visible area; clipping/optional content/groups need full interpretation.', 'Operator indices are not render-operation filter indices.', 'PDF.js may normalize or repair input; original PDF syntax is not inventoried.', 'Fonts, ICC colors, transparency, paint order and line semantics have not been converted or compared.', 'Page paper units do not establish architectural drawing scale.'],
    };
  } finally { await loading.destroy(); }
}

if (isMainThread) {
  const [, , input, page = '1'] = process.argv;
  if (!input) throw new Error('Usage: pdf-vector-census.mjs input.pdf [page=1]');
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: { input, pageNumber: Number(page) },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('PDF inspection exceeded 60s; worker terminated'));
    }, limits.deadlineMs);
    worker.once('message', message => {
      clearTimeout(timer);
      void worker.terminate();
      if (message.error) reject(new Error(message.error)); else resolve(message.result);
    });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); reject(new Error(`PDF worker exited ${code} without a report`)); });
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  try { parentPort.postMessage({ result: await inspect(workerData.input, workerData.pageNumber) }); }
  catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
}
