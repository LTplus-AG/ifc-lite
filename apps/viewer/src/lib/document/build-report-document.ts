/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SavedComparison } from '../compare/savedComparisonSchema';
import { isSavedComparisonChart } from '../charts/comparison-source';
import { savedReportBlock, type SavedValidationReport } from '../validation/reports/history';
import { DOCUMENT_VERSION, migrateDocumentSpec, validateDocumentSpec, type DocumentSpec, type DocumentBlock, type IdsReportBlock } from './types';
import { setBlockTitleFields } from './block-title';
import { copyDocumentBlock, freshBlockId, freshDocumentId } from './persistence';
import { detachAiProvenance } from './ai-report-types';
import { literalTemplateText } from './bindings';

export type DocumentReportResult =
  | { jobId: string; resultId: string; kind: 'validation'; snapshot: IdsReportBlock }
  | { jobId: string; resultId: string; kind: 'comparison'; comparison: SavedComparison };
export interface DocumentResultMapping { blockId: string; jobId: string; resultId?: string }
export interface DocumentRunContext {
  workflowName: string;
  runId: string;
  startedAt: string;
  models: readonly { name: string; sourceFingerprint?: string; mutationRevision?: number }[];
  summary?: string;
}
export interface DocumentMappingJob {
  jobId: string;
  kind: DocumentReportResult['kind'];
  /** Only supplied when result identities are known before execution (historical evidence). */
  resultIds?: readonly string[];
}
export interface BuildReportDocumentOptions {
  name?: string;
  context?: DocumentRunContext;
  results: readonly DocumentReportResult[];
  template?: DocumentSpec;
  mappings?: readonly DocumentResultMapping[];
}

/** Validate the saved template against enabled jobs before any model loading starts. */
export function validateReportDocumentTemplate(saved: DocumentSpec,
  mappings: readonly DocumentResultMapping[], jobs: readonly DocumentMappingJob[],
): string[] {
  // A workflow carries its template as it was saved, so an older format version is upgraded
  // here exactly as a saved document is on load (#6548); validating it as-is refused every
  // template saved before a format bump.
  const template = migrateDocumentSpec(saved) as DocumentSpec;
  const errors = validateDocumentSpec(template).map((error) => `${error.path} ${error.message}`);
  if (errors.length) return errors;
  const byJob = new Map<string, DocumentMappingJob>();
  for (const job of jobs) {
    if (byJob.has(job.jobId)) errors.push(`Duplicate document job ${job.jobId}`);
    byJob.set(job.jobId, job);
  }
  const byBlock = new Map<string, DocumentResultMapping>();
  for (const mapping of mappings) {
    if (byBlock.has(mapping.blockId)) errors.push(`Duplicate mapping for block ${mapping.blockId}`);
    byBlock.set(mapping.blockId, mapping);
    const block = template.blocks.find((candidate) => candidate.id === mapping.blockId);
    if (!block) { errors.push(`Unknown template block ${mapping.blockId}`); continue; }
    const job = byJob.get(mapping.jobId);
    if (!job) { errors.push(`Unknown or disabled document job ${mapping.jobId}`); continue; }
    if (job.kind === 'validation' && block.kind !== 'ids-report') errors.push(`Block ${block.id} requires a validation report block`);
    if (job.kind === 'comparison' && (block.kind !== 'table' || block.source.kind !== 'comparison')) {
      errors.push(`Block ${block.id} requires a comparison table block`);
    }
    if (mapping.resultId !== undefined && job.resultIds && !job.resultIds.includes(mapping.resultId)) {
      errors.push(`Unknown result ${mapping.resultId} for document job ${job.jobId}`);
    }
  }
  for (const block of template.blocks) {
    if ((block.kind === 'ids-report' || (block.kind === 'table' && block.source.kind === 'comparison')) && !byBlock.has(block.id)) {
      errors.push(`Report block ${block.id} requires a result mapping`);
    }
    // Live validation tables have no persisted report snapshot slot. They cannot be
    // mapped to a workflow result and would otherwise print the panel's unrelated run.
    if (block.kind === 'table' && block.source.kind === 'validation') {
      errors.push(`Live validation table ${block.id} must be replaced with a mapped validation report block`);
    }
    if (block.kind === 'chart' && (block.chart.source === 'ids' || (block.chart.source === 'compare' && !isSavedComparisonChart(block.chart)))) {
      errors.push(`Live ${block.chart.source} chart ${block.id} cannot use workflow evidence; use a mapped report block`);
    }
  }
  return errors;
}

function defaultCover(options: BuildReportDocumentOptions): DocumentBlock[] {
  const name = options.name ?? 'Workflow report';
  const context = options.context;
  const validationCount = options.results.filter((result) => result.kind === 'validation').length;
  const comparisonCount = options.results.length - validationCount;
  const lines = [
    `${new Set(options.results.map((result) => result.jobId)).size} completed jobs; ${validationCount} validation reports; ${comparisonCount} comparisons.`,
    ...(context ? [`Workflow: ${context.workflowName}`, `Run: ${context.runId}`, `Started: ${context.startedAt}`,
      ...(context.summary ? [context.summary] : [])] : []),
  ];
  const cover: DocumentBlock[] = [
    { kind: 'text', id: freshBlockId(), style: 'title', text: literalTemplateText(name) },
    { kind: 'text', id: freshBlockId(), style: 'body', text: literalTemplateText(lines.join('\n')) },
  ];
  if (context?.models.length) {
    cover.push({ kind: 'text', id: freshBlockId(), style: 'heading', text: 'Evaluated models' },
      { kind: 'text', id: freshBlockId(), style: 'small', text: literalTemplateText(context.models.map((model) => [model.name,
        ...(model.sourceFingerprint ? [`Content identity: ${model.sourceFingerprint}`] : []),
        ...(model.mutationRevision !== undefined ? [`Edit revision: ${model.mutationRevision}`] : []),
      ].join(' · ')).join('\n')) });
  }
  return cover;
}

function resultBlock(result: DocumentReportResult, presentation?: DocumentBlock): DocumentBlock {
  const id = freshBlockId();
  if (result.kind === 'validation') {
    if (presentation && presentation.kind !== 'ids-report') throw new Error(`Block ${presentation.id} requires a validation report block`);
    return { ...structuredClone(result.snapshot), id,
      variant: presentation?.variant ?? result.snapshot.variant ?? 'compact', benchmarks: presentation?.benchmarks ?? result.snapshot.benchmarks ?? true,
      ...((presentation?.specificationsOnly ?? result.snapshot.specificationsOnly) !== undefined ? { specificationsOnly: presentation?.specificationsOnly ?? result.snapshot.specificationsOnly } : {}),
      ...(presentation ? setBlockTitleFields(presentation) : {}),
      ...(presentation?.scale !== undefined ? { scale: presentation.scale } : {}),
      ...(presentation?.showStamp !== undefined ? { showStamp: presentation.showStamp } : {}),
    };
  }
  if (presentation && (presentation.kind !== 'table' || presentation.source.kind !== 'comparison')) {
    throw new Error(`Block ${presentation.id} requires a comparison table block`);
  }
  return { ...(presentation?.kind === 'table' ? structuredClone(presentation) : { kind: 'table' as const, maxRows: 50 }),
    id, source: { kind: 'comparison', comparison: structuredClone(result.comparison) } };
}

/** Job order is input order; an IDS job with N results expands adjacent report blocks. */
export function buildReportDocument(options: BuildReportDocumentOptions): DocumentSpec {
  const { mappings = [], results } = options;
  if (results.length === 0) throw new Error('A report document requires at least one completed result');
  const identities = new Set<string>();
  for (const result of results) {
    const key = JSON.stringify([result.jobId, result.resultId]);
    if (identities.has(key)) throw new Error(`Duplicate document result ${result.jobId}/${result.resultId}`);
    identities.add(key);
    if (result.kind === 'validation' && result.snapshot.checks.some((check) => check.error)) {
      throw new Error(`Job ${result.jobId} contains execution errors`);
    }
  }
  if (!options.template) return { version: DOCUMENT_VERSION, id: freshDocumentId(), name: options.name ?? 'Workflow report',
    page: { size: 'A4', orientation: 'portrait' }, blocks: [...defaultCover(options), ...results.map((result) => resultBlock(result))] };
  const jobs = [...new Map(results.map((result) => [result.jobId, { jobId: result.jobId, kind: result.kind }])).values()];
  const errors = validateReportDocumentTemplate(options.template, mappings, jobs);
  if (errors.length) throw new Error(`Invalid document template: ${errors.join('; ')}`);
  const template = migrateDocumentSpec(options.template) as DocumentSpec;
  const byBlock = new Map(mappings.map((mapping) => [mapping.blockId, mapping]));
  const blocks: DocumentBlock[] = [];
  for (const block of template.blocks) {
    const mapping = byBlock.get(block.id);
    if (mapping) {
      const selected = results.filter((result) => result.jobId === mapping.jobId &&
        (mapping.resultId === undefined || result.resultId === mapping.resultId));
      if (!selected.length) throw new Error(`No completed result for block ${block.id}: ${mapping.jobId}/${mapping.resultId ?? '*'}`);
      for (const result of selected) blocks.push(resultBlock(result, block));
    } else {
      // A report placeholder must be explicit; stale template evidence cannot impersonate this run.
      if (block.kind === 'ids-report' || (block.kind === 'table' && block.source.kind === 'comparison')) {
        throw new Error(`Report block ${block.id} requires a result mapping`);
      }
      blocks.push(detachAiProvenance(copyDocumentBlock(block)));
    }
  }
  // An AI report used as a template keeps its text, never its old evidence record (#6918).
  const layout = structuredClone(template);
  delete layout.aiReport;
  return { ...layout, id: freshDocumentId(), name: options.name ?? template.name, blocks };
}

/** Convenience for library-backed automation callers; result IDs are library evidence IDs. */
export function buildAutomationDocument(options: Omit<BuildReportDocumentOptions, 'results'> & {
  validationReports: readonly SavedValidationReport[]; comparisons: readonly SavedComparison[];
}): DocumentSpec {
  return buildReportDocument({ ...options, results: [
    ...options.validationReports.map((entry): DocumentReportResult => {
      if (entry.snapshot.kind !== 'ids-report') throw new Error('Manual validation evidence is not supported by workflow report mappings');
      return { jobId: entry.id, resultId: entry.id, kind: 'validation', snapshot: savedReportBlock(entry, entry.snapshot.id) as IdsReportBlock };
    }),
    ...options.comparisons.map((comparison): DocumentReportResult => ({ jobId: comparison.id, resultId: comparison.id, kind: 'comparison', comparison })),
  ] });
}
