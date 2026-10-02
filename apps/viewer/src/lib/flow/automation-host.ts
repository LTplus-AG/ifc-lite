/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseCapabilities, parseCapability, hasCapability } from '@ifc-lite/extensions';
import type { FlowDocument } from '@ifc-lite/flow';
import type { SessionAutomationHost } from '@ifc-lite/flow-nodes';
import { useViewerStore } from '@/store';
import { buildReportDocument, type DocumentReportResult, type DocumentResultMapping } from '@/lib/document/build-report-document';
import { prepareDocument } from '@/lib/document/prepare-document';
import { exportPreparedDocument, documentPdfWarnings } from '@/lib/document/export-prepared-document';
import { migrateDocumentSpec, validateDocumentSpec, type DocumentSpec } from '@/lib/document/types';
import { sanitizeFilename } from '@/lib/export/download';
import { sameReportEvidence } from './report-provenance';
import type { DocumentRunContext } from '@/lib/document/build-report-document';
import { retainComparisonReport } from './report-retention';
import { loadSessionModels, assignSessionTags, checkWorkflowModelPins, type AddLocalModel } from './local-models';
import { validateChecks, compareChecks } from './check-host';
import { filesResource, readHistorical, historicalJobId } from './check-resources';
import type { WorkflowRun } from './run-session';

import type { WorkflowArtifact } from './artifact';
export function createAutomationHost(run: WorkflowRun, doc: FlowDocument, addModel: AddLocalModel, onArtifact: (artifact: WorkflowArtifact) => void): SessionAutomationHost {
  const capabilities = parseCapabilities(doc.capabilities);
  if (!capabilities.ok) throw new Error(capabilities.errors.map((e) => e.message).join('; '));
  const guard = (...raw: string[]) => {
    run.check(); checkWorkflowModelPins(run);
    for (const c of raw) {
      const parsed = parseCapability(c);
      if (!parsed.ok || !hasCapability(capabilities.value, parsed.value)) throw new Error(`Workflow capability denied: ${c}`);
    }
  };
  const reports = (token: unknown) => token == null ? [] : run.get<readonly DocumentReportResult[]>(token, 'reports');
  const startedAt = new Date().toISOString();
  return {
    loadModels: async (files, selectors) => {
      guard('model.create');
      return loadSessionModels(run, doc.id, addModel, files, selectors);
    },
    assignTags: async (models, rules) => {
      guard('storage.write:modelTags');
      return assignSessionTags(run, models, rules);
    },
    validate: async (models, jobs, files) => {
      guard('model.read', 'storage.write:validationReports');
      return run.withModelRead(() => validateChecks(run, doc.id, models, jobs, files));
    },
    compare: async (models, jobs, files) => {
      guard('model.read', 'storage.write:savedComparisons');
      return run.withModelRead(() => compareChecks(run, doc.id, models, jobs, files));
    },
    importComparisons: async (files) => {
      guard('storage.write:savedComparisons'); run.progress('Importing historical evidence');
      const results: DocumentReportResult[] = [];
      for (const [slotId, selected] of Object.entries(filesResource(run, files))) for (const [index, file] of selected.entries()) {
        const imported = await readHistorical(run, file);
        run.check();
        const old = useViewerStore.getState().savedComparisons.find((c) => sameReportEvidence({ ...c, id: '' }, { ...imported, id: '' }));
        // External IDs may belong to deleted or unreadable library rows. A new
        // import gets local identity; identical live evidence remains idempotent.
        const entry = old ?? { ...imported, id: crypto.randomUUID() };
        const retained = await retainComparisonReport(entry, useViewerStore);
        for (const warning of retained.warnings) run.warn(warning);
        results.push({ jobId: historicalJobId(slotId, index, file.name), resultId: imported.id, kind: 'comparison', comparison: entry });
      }
      return run.put('reports', results);
    },
    buildDocument: async (validation, comparisons, historical, config) => {
      guard('storage.write:documents'); run.progress('Building document');
      const c = config !== null && typeof config === 'object' ? config as Record<string, unknown> : {};
      const template = c.template as DocumentSpec | undefined;
      if (template && validateDocumentSpec(migrateDocumentSpec(template)).length) throw new Error('Invalid native document template');
      const state = useViewerStore.getState();
      const results = [...reports(validation), ...reports(comparisons), ...reports(historical)];
      const document = buildReportDocument({ name: typeof c.name === 'string' ? c.name : `${doc.name} report`, results,
        template, mappings: c.mappings as DocumentResultMapping[] | undefined,
        context: { workflowName: doc.name, runId: run.id, startedAt,
          models: results.flatMap((r): DocumentRunContext['models'][number][] => {
            const evidence = r.kind === 'comparison' ? r.comparison.automation : r.snapshot.automation;
            return evidence?.models ? [...evidence.models] : (r.kind === 'comparison'
              ? [r.comparison.report.baseModel, r.comparison.report.headModel].map((name) => ({ name }))
              : (r.snapshot.reportModels ?? []).map((m) => ({ name: m.name, sourceFingerprint: m.fingerprint })));
          }).filter((m, index, all) => all.findIndex((other) => other.name === m.name && other.sourceFingerprint === m.sourceFingerprint) === index),
          summary: run.warnings.join('\n') } });
      run.check(); checkWorkflowModelPins(run);
      if (!(await state.upsertDocument(document))) run.warn('Document is available in memory but browser storage refused the save');
      return run.put('document', document);
    },
    exportPdf: (token) => run.withModelRead(async () => {
      guard('export.create:pdf'); run.progress('Generating PDF');
      const document = run.get<DocumentSpec>(token, 'document');
      const documentSignature = JSON.stringify(document);
      const input = await prepareDocument(document, useViewerStore.getState(), { signal: run.controller.signal });
      run.check(); checkWorkflowModelPins(run);
      const pdf = await exportPreparedDocument(input, { signal: run.controller.signal });
      run.check(); checkWorkflowModelPins(run);
      const currentDocument = useViewerStore.getState().documents.find((d) => d.id === document.id);
      if (!currentDocument || JSON.stringify(currentDocument) !== documentSignature) {
        run.cancel(); throw new DOMException('Report document changed during PDF generation', 'AbortError');
      }
      const warnings = documentPdfWarnings(pdf);
      for (const warning of warnings) run.warn(warning);
      const artifact: WorkflowArtifact = { documentId: document.id, documentSignature, id: crypto.randomUUID(), blob: pdf.blob, pages: pdf.pages, warnings,
        name: `${sanitizeFilename(doc.name, { fallback: 'workflow-report' })}-${startedAt.replace(/[:.]/g, '-')}.pdf` };
      onArtifact(artifact);
      return run.put('artifact', { id: artifact.id, name: artifact.name, pages: artifact.pages });
    }),
  };
}
