/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { MemoCache, parseFlowDocument } from '@ifc-lite/flow';
import { parseRuleSetFile } from '@ifc-lite/rules';
import { openFlowSample } from '@/test/flow-sample-fixture';
import { useViewerStore } from '@/store';
import type { DocumentReportResult } from '@/lib/document/build-report-document';
import type { DocumentSpec } from '@/lib/document/types';
import { loadValidationReports } from '@/lib/validation/reports/persistence';
import { waitForValidationReportsCommit } from '@/test/content-fixture';
import { startWorkflowRun } from './run-session';
import { preflightWorkflow } from './preflight';
import { createAutomationHost } from './automation-host';
import { runFlowInViewer, viewerFlowFeatures } from './runner';
import type { WorkflowArtifact } from './artifact';

async function example() {
  return parseFlowDocument(await readFile(new URL('./examples/09-coordination-startup.flow.json', import.meta.url), 'utf8'));
}

it('requires the example model and check file slots before any report publication (#6942)', async () => {
  const doc = await example();
  const run = startWorkflowRun();
  try {
    const original = useViewerStore.getState().savedValidationReports;
    await assert.rejects(preflightWorkflow(run, doc, {}, viewerFlowFeatures(true)), /required|choose/i);
    assert.equal(useViewerStore.getState().savedValidationReports, original);
    assert.equal(run.resources.size, 0);
    const loadedOnly = { ...doc, inputs: doc.inputs.filter(input => input.nodeId !== 'load'),
      nodes: doc.nodes.map(node => node.id === 'load' ? { ...node,
        params: { files: {}, selectors: [{ kind: 'filename', filename: 'building-architecture.ifc' }] } } : node) };
    await assert.rejects(preflightWorkflow(run, loadedOnly, {}, viewerFlowFeatures(true)), /required|choose/i);
    assert.equal(useViewerStore.getState().savedValidationReports, original);
  } finally { run.release(); }
});

it('runs the loaded-model variant through the real graph, retained report, native document and PDF (#6942)', async () => {
  const model = await openFlowSample();
  assert.equal(model.bim.query().byType('IfcWall').toArray().length, 4, 'real SketchUp sample ground truth');
  const original = await example();
  // This is an explicit authored variation, not a claim that a required Models input can be left empty.
  const filename = useViewerStore.getState().models.get('arch')!.name;
  const doc = { ...original, inputs: original.inputs.filter(input => input.nodeId !== 'load'),
    nodes: original.nodes.map(node => node.id === 'load' ? { ...node,
      params: { files: {}, selectors: [{ kind: 'filename', filename }] } } : node) };
  const run = startWorkflowRun();
  const artifacts: WorkflowArtifact[] = [];
  const previousJspdf = Reflect.get(window, 'jspdf');
  Reflect.set(window, 'jspdf', await import('jspdf'));
  try {
    const rulesText = await readFile(new URL('./examples/09-coordination-walls.rules.json', import.meta.url), 'utf8');
    const parsed = parseRuleSetFile(JSON.parse(rulesText));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) assert.fail(parsed.error);
    assert.equal(parsed.file.name, 'Walls have names');
    const inputs = await preflightWorkflow(run, doc, {
      'validation.files': { checks: [new File([rulesText], 'walls.rules.json')] },
    }, viewerFlowFeatures(true));
    const host = createAutomationHost(run, doc, async () => assert.fail('loaded selector must reuse the actual model'),
      artifact => artifacts.push(artifact));
    const result = await runFlowInViewer({ doc, bim: model.bim, pin: model.sourceFingerprint,
      cache: new MemoCache(), inputs, automation: host, signal: run.controller.signal });
    assert.equal(result.ok, true, JSON.stringify(result.log));
    const reportOutput = result.outputs.get('validation')?.get('reports');
    assert.equal(reportOutput?.kind, 'item');
    if (reportOutput?.kind !== 'item') assert.fail('native reports output expected');
    const reportToken = reportOutput.value;
    const reports = run.get<DocumentReportResult[]>(reportToken, 'reports');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].kind, 'validation');
    if (reports[0].kind !== 'validation') assert.fail('native validation evidence expected');
    assert.equal(reports[0].snapshot.summary.passed, 4);
    assert.equal(reports[0].snapshot.summary.failed, 0);
    assert.equal(reports[0].snapshot.automation?.jobId, 'validation.files/checks:0:walls.rules.json');
    await waitForValidationReportsCommit();
    assert.equal((await loadValidationReports()).length, 1);
    const documentOutput = result.outputs.get('document')?.get('document');
    assert.equal(documentOutput?.kind, 'item');
    if (documentOutput?.kind !== 'item') assert.fail('native document output expected');
    const document = run.get<DocumentSpec>(documentOutput.value, 'document');
    assert.ok(document.blocks.some(block => block.kind === 'ids-report'));
    assert.equal(useViewerStore.getState().documents.find(saved => saved.id === document.id)?.name, 'Coordination report');
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].documentId, document.id);
    assert.equal(artifacts[0].documentSignature, JSON.stringify(document));
    assert.ok(artifacts[0].pages > 0);
    const bytes = new Uint8Array(await artifacts[0].blob.arrayBuffer());
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), '%PDF-');
    const require = createRequire(import.meta.url);
    const reader = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = reader.getDocument({ data: bytes, stopAtErrors: true,
      standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
    try {
      const pdf = await task.promise;
      assert.equal(pdf.numPages, artifacts[0].pages);
      const text: string[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        try { text.push((await page.getTextContent()).items.flatMap(item => 'str' in item ? [item.str] : []).join(' ')); }
        finally { page.cleanup(); }
      }
      assert.match(text.join('\n'), /Coordination report/);
      assert.match(text.join('\n'), /Walls have names|Wall Name/);
    } finally { await task.destroy(); }
  } finally { Reflect.set(window, 'jspdf', previousJspdf); run.release(); }
});
