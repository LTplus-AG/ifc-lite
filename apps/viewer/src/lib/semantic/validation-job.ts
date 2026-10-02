/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseGraph, createValidationReport, type GraphImportOptions, type ValidationReport, toRdf, validateGraph, validateJson, validateLinks, parseImport, resourcesFromResults, parseResults, DEFAULT_PROFILE,
  type BindingMapping, type SparqlResults, type ProfileDefinition, type SemanticDocument, type ValidationFinding } from '@ifc-lite/semantic';

export interface ValidationJob {
  profile?: ProfileDefinition;
  document?: unknown;
  results?: SparqlResults; mapping?: BindingMapping; source?: string;
  graph?: string; graphFormat?: GraphImportOptions['format'];
}
export interface ValidationOutput { document?: SemanticDocument; graph: string; findings: ValidationFinding[]; report?: ValidationReport; diagnostic?: string }
/** The same task runs in the browser worker and the integration harness. */
export async function executeValidation(job: ValidationJob): Promise<ValidationOutput> {
  const profile = job.profile ?? DEFAULT_PROFILE;
  const projected = job.results ? resourcesFromResults(parseResults({ head: { vars: job.results.columns }, results: { bindings: job.results.rows } }), job.source ?? 'urn:ifc-lite:select', job.mapping, profile) : undefined;
  const document = projected ?? (job.document === undefined ? undefined : parseImport(job.document, profile));
  const graph = job.graph !== undefined ? (await parseGraph(job.graphFormat === 'application/ld+json' ? JSON.parse(job.graph) as unknown : job.graph, { format: job.graphFormat ?? 'text/turtle' })).graph : (document ? await toRdf(document, profile) : '');
  const findings = document ? [...validateJson(document, profile), ...validateLinks(document, profile)] : [];
  try { findings.push(...await validateGraph(graph, { profile })); }
  catch (error) { return { document, graph, findings, diagnostic: error instanceof Error ? error.message : String(error) }; }
  const report = createValidationReport({ profile, scope: document ? 'profile' : 'graph', completeness: document?.completeness ?? 'partial', source: document?.source, findings, engines: document ? ['JSON Schema', 'links', 'SHACL'] : ['SHACL'] });
  return { document, graph, findings: report.findings, report };
}
