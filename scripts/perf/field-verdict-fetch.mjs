#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Run the field-verdict HogQL (#6961) against PostHog and save the result for
 * `field-verdict.mjs`. Read-only: one POST to the query endpoint.
 *
 * Needs `POSTHOG_PERSONAL_API_KEY`: a personal API key scoped to project
 * 199147 with `query:read` only. `POSTHOG_HOST` defaults to the EU cloud, where
 * the project lives; `POSTHOG_PROJECT_ID` defaults to 199147.
 *
 *   POSTHOG_PERSONAL_API_KEY=... node scripts/perf/field-verdict-fetch.mjs \
 *     --build <sha> [--baseline-days 14] --out result.json
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verdictSql } from './field-verdict.mjs';

export const DEFAULT_HOST = 'https://eu.posthog.com';
export const DEFAULT_PROJECT = '199147';

/** POST the HogQL; resolves the `{ columns, results }` response. */
export async function fetchVerdictRows({ sql, apiKey, host = DEFAULT_HOST, project = DEFAULT_PROJECT, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error('field-verdict-fetch: POSTHOG_PERSONAL_API_KEY is not set');
  const response = await fetchImpl(`${host.replace(/\/$/, '')}/api/projects/${encodeURIComponent(project)}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql }, name: 'field-verdict (#6961)' }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`field-verdict-fetch: PostHog answered ${response.status}: ${text.slice(0, 500)}`);
  const body = JSON.parse(text);
  if (!Array.isArray(body.results) || !Array.isArray(body.columns)) throw new Error('field-verdict-fetch: response has no columns/results');
  if (body.hasMore) throw new Error('field-verdict-fetch: result truncated (hasMore); narrow the baseline window');
  return { columns: body.columns, results: body.results };
}

async function main(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const build = get('--build');
  const out = get('--out');
  if (!out) throw new Error('field-verdict-fetch: --out <file> is required');
  const sql = verdictSql({ build, baselineDays: Number(get('--baseline-days') ?? 14) });
  const rows = await fetchVerdictRows({
    sql,
    apiKey: process.env.POSTHOG_PERSONAL_API_KEY,
    host: process.env.POSTHOG_HOST || DEFAULT_HOST,
    project: process.env.POSTHOG_PROJECT_ID || DEFAULT_PROJECT,
  });
  writeFileSync(out, JSON.stringify(rows));
  console.log(`field-verdict-fetch: ${rows.results.length} cell rows for build ${build.slice(0, 12)} -> ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
