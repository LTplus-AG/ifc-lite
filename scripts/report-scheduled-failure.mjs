#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const required = (env, name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export function reportScheduledFailure(env, gh) {
  const workflow = required(env, 'WORKFLOW_NAME');
  const jobs = required(env, 'JOBS');
  const result = required(env, 'RESULT');
  const runUrl = required(env, 'RUN_URL');
  const repo = required(env, 'GITHUB_REPOSITORY');
  const title = `ci: scheduled ${workflow} lane is not reporting`;
  const body = `The scheduled ${workflow} lane did not succeed (jobs: ${jobs}; results: ${result}). Run: ${runUrl}`;
  if (env.DRY_RUN === 'true') return { action: 'dry-run', title, body };
  const listed = gh(['issue', 'list', '--repo', repo, '--state', 'open', '--search', `${title} in:title`, '--limit', '100', '--json', 'number,title']);
  const issues = JSON.parse(listed);
  if (!Array.isArray(issues)) throw new Error('gh issue list returned a non-array JSON value');
  const existing = issues.find((issue) => issue && issue.title === title && Number.isInteger(issue.number));
  if (existing) {
    gh(['issue', 'comment', String(existing.number), '--repo', repo, '--body', body]);
    return { action: 'comment', number: existing.number, title, body };
  }
  gh(['issue', 'create', '--repo', repo, '--title', title, '--body', body]);
  return { action: 'create', title, body };
}

function realGh(args) {
  const run = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0 || run.signal) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed (${run.signal ?? run.status}): ${(run.stderr ?? '').trim()}`);
  return run.stdout ?? '';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = reportScheduledFailure(process.env, realGh);
  console.log(`${result.action}: ${result.title}`);
}
