/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Linked records (semantic pilot) as evidence (#6833): one row per record
 * with its resolution against the loaded models, then one row per
 * validation finding. Source locations, endpoints, bearer tokens, relay
 * providers and loopback grants are never read: the latter are panel-local
 * state and the document source is deliberately omitted.
 *
 * Readiness reads the Linked records session, a separate store; `subscribe`
 * lets an open source picker follow it. An in-flight question is guarded by
 * the viewer-store freshness check only, so a session change during a request
 * is caught at the next viewer-store change or send.
 */

import type { LiveEntity, Resolution, SemanticDocument, ValidationFinding } from '@ifc-lite/semantic';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';
import { semanticEvidenceAccess, subscribeSemanticEvidence, type SemanticSessionView } from './semantic-access';

const LABEL_CHARS = 200;
const MESSAGE_CHARS = 400;

function bounded(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Without a parseable host: cut the query and fragment, and any userinfo before the first `@` of the authority. */
function strippedIri(value: string): string {
  const base = value.split(/[?#]/, 1)[0];
  return base.replace(/^([a-z][a-z0-9+.-]*:\/\/)?[^/@]*@/i, '$1');
}

/** Record IRIs are identities; userinfo, query strings and fragments (where signed tokens live) are dropped. */
export function safeIri(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { return bounded(strippedIri(value), LABEL_CHARS); }
  if (!url.host) return bounded(strippedIri(value), LABEL_CHARS);
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return bounded(url.href, LABEL_CHARS);
}

function sessionView(): SemanticSessionView | null {
  return semanticEvidenceAccess()?.session.getState() ?? null;
}

function hasEvidence(view: SemanticSessionView | null): view is SemanticSessionView {
  return !!view && (!!view.document || view.findings.length > 0 || !!view.report);
}

function resolutionRow(resource: SemanticDocument['resources'][number], resolution: Resolution, liveGlobalIds: ReadonlyMap<string, string>) {
  const ref = resolution.status === 'resolved' ? resolution.ref : null;
  return evidenceRow({
    kind: 'semanticRecord', modelId: ref?.modelId ?? null, expressId: ref?.expressId ?? null,
    globalId: ref ? liveGlobalIds.get(`${ref.modelId}:${ref.expressId}`) ?? null : null,
    status: resolution.status,
  }, {
    recordId: safeIri(resource.id), type: resource.type, label: bounded(String(resource.label), LABEL_CHARS),
    candidateCount: resolution.status === 'ambiguous' ? resolution.candidates.length : null,
    declaresModelRevision: resource.modelRevision !== undefined,
  });
}

function findingRow(finding: ValidationFinding) {
  return evidenceRow({ kind: 'semanticFinding', status: finding.severity ?? 'Violation' }, {
    engine: finding.engine, recordId: safeIri(finding.resourceId), path: bounded(finding.path, LABEL_CHARS),
    message: bounded(finding.message, MESSAGE_CHARS),
  });
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

export const semanticAdapter: EvidenceAdapter = {
  id: 'semantic', group: 'coordination', panelIds: ['semantic'],
  titleKey: 'semantic.title', descriptionKey: 'assistantSources.semantic.description',
  rowMeaningKey: 'assistantSources.semantic.rows', unavailableKey: 'assistantSources.semantic.unavailable',
  suggestionKeys: ['assistantSources.semantic.suggestUnresolved', 'assistantSources.semantic.suggestFindings'],
  subscribe: subscribeSemanticEvidence,
  readiness: () => {
    const view = sessionView();
    if (!hasEvidence(view)) return { status: { labelKey: 'assistantSources.semantic.none' }, ready: false };
    return { status: { labelKey: 'assistantSources.semantic.ready',
      params: { count: view.document?.resources.length ?? 0, findings: view.findings.length } }, ready: true };
  },
  // Session setters replace these refs; resolution also depends on the identity settings and revision links.
  identity: () => {
    const view = sessionView();
    return view ? [view.document, view.findings, view.report, view.results, view.revisions, view.strategy,
      view.links, view.uriConfig, view.identityFields] : null;
  },
  capture: (_s, limit) => {
    const access = semanticEvidenceAccess();
    const view = sessionView();
    if (!access || !hasEvidence(view)) return unavailableCapture();
    const resources = view.document?.resources ?? [];
    const entities: LiveEntity[] = resources.length ? access.liveEntities() : [];
    const liveGlobalIds = new Map(entities.map(entity => [`${entity.modelId}:${entity.expressId}`, entity.GlobalId]));
    const resolutions = resources.map(resource => access.resolve(resource, entities, view.revisions));
    const rows: unknown[] = [];
    for (let i = 0; i < resources.length && rows.length < limit; i++) rows.push(resolutionRow(resources[i], resolutions[i], liveGlobalIds));
    for (const finding of view.findings) {
      if (rows.length >= limit) break;
      rows.push(findingRow(finding));
    }
    const report = view.report;
    return {
      summary: {
        kind: 'linked-records',
        mode: view.document ? 'records' : 'graph-only',
        profile: view.document?.profile ? safeIri(view.document.profile) : null,
        completeness: view.document?.completeness ?? null,
        recordCount: resources.length, recordsByType: countBy(resources, resource => resource.type),
        resolution: countBy(resolutions, resolution => resolution.status),
        identityStrategy: view.strategy, associatedRevisions: view.revisions.size,
        findingCount: view.findings.length, findingsBySeverity: countBy(view.findings, finding => finding.severity ?? 'Violation'),
        validation: report ? { scope: report.scope, completeness: report.completeness, conforms: report.conforms,
          truncated: report.truncated, counts: report.counts, engines: report.engines, limits: report.limits,
          profile: report.profile } : null,
        queryResults: view.results ? { columnCount: view.results.columns.length, rowCount: view.results.rows.length } : null,
        graphLoaded: view.graph.length > 0,
        limitations: 'Resolution is against all loaded models with the session\'s identity strategy; the panel\'s model scope filter is not applied. '
          + 'A partial document is not the whole external dataset. No validation report means validation was not run, not that records conform. '
          + 'Record properties, query result values, the graph text and the source location are not included; endpoints and credentials are never captured.',
      },
      rows, totalRows: resources.length + view.findings.length, availability: 'available',
    };
  },
};
