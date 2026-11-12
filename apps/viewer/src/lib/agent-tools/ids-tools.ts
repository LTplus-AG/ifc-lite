/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS parsing and validation shared by the agent tool hosts. Where the XML
 * comes from (an attached upload, inline arguments) and what happens to the
 * report (a staged download, or nothing) stays with each host.
 */

import { parseIDS, validateIDS, type IDSDocument } from '@ifc-lite/ids';
import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { createDataAccessor as createIdsDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { assertToolActive } from './cancellation.js';
import { effectiveEntityCount } from './effective.js';
import type { ReadyModel, ToolCallContext, ToolOutput } from './types.js';

export function parseIdsXml(xml: string): IDSDocument {
  try {
    return parseIDS(xml);
  } catch (err) {
    throw new ToolExecutionError({ code: ToolErrorCode.PARSE_FAILED, message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Validate against this model's store and pending overlay, through the shared
 * `@ifc-lite/ids/bridge` accessor exactly as the viewer's IDS panel, the CLI
 * and the stdio MCP build it. A hand-built copy drifted: it invented property
 * dataTypes from the JS value kind (#5304) and reimplemented material
 * flattening.
 */
export async function validateIdsAgainst(
  model: ReadyModel,
  xml: string,
  ctx: ToolCallContext,
): Promise<{ doc: IDSDocument; report: Awaited<ReturnType<typeof validateIDS>>; output: ToolOutput }> {
  const doc = parseIdsXml(xml);
  const accessor = createIdsDataAccessor(model.store, model.id, model.mutationView());
  const report = await validateIDS(doc, accessor, {
    modelId: model.id,
    schemaVersion: model.store.schemaVersion,
    entityCount: effectiveEntityCount(model),
  }, { onProgress: () => assertToolActive(ctx) });
  const head = `IDS '${doc.info?.title ?? 'untitled'}' · ${report.summary.passedSpecifications}/${report.summary.totalSpecifications} specs passed (${report.summary.overallPassRate.toFixed(0)}%).`;
  const lines = report.specificationResults.map((s) => {
    const ok = s.status === 'pass';
    const skipped = s.status === 'not_applicable';
    const tag = skipped ? '·' : ok ? '✓' : '✗';
    return `${tag} ${s.specification.name ?? '(unnamed)'} — ${s.passedCount} pass / ${s.failedCount} fail · ${s.passRate.toFixed(0)}%`;
  });
  return {
    doc,
    report,
    output: { text: [head, ...lines].join('\n'), structured: report as unknown as Record<string, unknown> },
  };
}

export function explainIds(xml: string): ToolOutput {
  const doc = parseIdsXml(xml);
  const head = `IDS '${doc.info?.title ?? 'untitled'}' · ${doc.specifications.length} specification(s).`;
  const lines = doc.specifications.map((s, i) => `${i + 1}. ${s.name ?? '(unnamed)'} — applies to ${s.applicability.facets.length} facet(s); requires ${s.requirements.length} clause(s).`);
  return { text: [head, ...lines].join('\n'), structured: doc as unknown as Record<string, unknown> };
}
