/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isRecord, isUuid, type ReportCorrelation } from '@ifc-lite/report-contract';
import type { Config } from './config.js';

/** Only an exact exception event in our configured project can supply a target. */
export async function resolvePosthogIssue(config: NonNullable<Config['posthog']>, correlation: ReportCorrelation, repository: string, fetcher: typeof fetch = fetch): Promise<{ issueId: string; issueUrl: string } | undefined> {
  const request = async (path: string, input?: unknown): Promise<unknown> => {
    const response = await fetcher(`${config.host}/api/projects/${config.projectId}/${path}`, {
      method: input === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('posthog_lookup_unavailable');
    return response.json();
  };
  // PostHog adds issue_id to events dynamically in database.py's
  // _add_error_tracking_fields: it resolves the current fingerprint mapping,
  // unlike properties.$exception_issue_id (the historical ingestion ID).
  // UUID syntax is validated at the boundary; no user-controlled SQL strings.
  if (!isUuid(correlation.eventId)) return undefined;
  const result = await request('query/', { query: { kind: 'HogQLQuery',
    query: `SELECT uuid, event, properties.$session_id, properties.app_build_sha, issue_id FROM events WHERE uuid = toUUID('${correlation.eventId}') AND timestamp > now() - INTERVAL 7 DAY LIMIT 2`,
  } });
  if (!isRecord(result) || !Array.isArray(result.results) || result.results.length !== 1) return undefined;
  const row: unknown = result.results[0];
  if (!Array.isArray(row) || row[0] !== correlation.eventId || row[1] !== '$exception' || row[2] !== correlation.sessionId || row[3] !== correlation.buildSha || !isUuid(row[4])) return undefined;
  const issue = await request(`error_tracking/issues/${row[4]}/`);
  if (!isRecord(issue) || issue.id !== row[4] || !Array.isArray(issue.external_issues)) return undefined;
  const targets = new Set<string>();
  for (const reference of issue.external_issues) {
    if (!isRecord(reference) || !isRecord(reference.integration) || reference.integration.kind !== 'github' || typeof reference.external_url !== 'string') continue;
    const prefix = `https://github.com/${repository}/issues/`;
    if (reference.external_url.startsWith(prefix) && /^[1-9]\d*$/.test(reference.external_url.slice(prefix.length))) targets.add(reference.external_url);
  }
  if (targets.size !== 1) return undefined;
  return { issueId: row[4], issueUrl: [...targets][0]! };
}
