#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawnSync } from 'node:child_process';
import { isMainEntry } from './lib/is-main-entry.mjs';

const required = (env, name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

/** Conclusions a lane can end in without succeeding. A job that reaches
 * `timeout-minutes` ends `timed_out`, and its running step `cancelled`. */
const UNSUCCESSFUL = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure']);

/**
 * Names what failed, so a report can be triaged without opening the run: #8774
 * and #8894 were closed as not planned, titled "not reporting", while the lane
 * was reporting a real instruction regression on main (#9016). The report is
 * the point of this script, so a failed lookup is noted in the body, never fatal.
 */
function failedSteps(env, repo, gh) {
  const runId = env.GITHUB_RUN_ID?.trim();
  if (!runId) return '- Failed steps unavailable: GITHUB_RUN_ID is not set.';
  try {
    const listed = gh(['api', `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`]);
    const jobs = JSON.parse(listed)?.jobs;
    if (!Array.isArray(jobs)) throw new Error('the jobs listing has no jobs array');
    const lines = jobs.filter((job) => UNSUCCESSFUL.has(job?.conclusion)).flatMap((job) => {
      const steps = (Array.isArray(job.steps) ? job.steps : []).filter((step) => UNSUCCESSFUL.has(step?.conclusion));
      const how = job.conclusion === 'failure' ? '' : ` (${job.conclusion.replace(/_/g, ' ')})`;
      return steps.length > 0 ? steps.map((step) => `- ${job.name} › ${step.name}${how}`) : [`- ${job.name}${how}`];
    });
    return lines.length > 0 ? lines.join('\n') : '- No failed job in the run; see the results above.';
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`report-scheduled-failure: could not list failed steps: ${reason}`);
    return `- Failed steps unavailable: ${reason}`;
  }
}

export function reportScheduledFailure(env, gh) {
  const workflow = required(env, 'WORKFLOW_NAME');
  const jobs = required(env, 'JOBS');
  const result = required(env, 'RESULT');
  const runUrl = required(env, 'RUN_URL');
  const repo = required(env, 'GITHUB_REPOSITORY');
  const title = `ci: scheduled ${workflow} lane failed`;
  const steps = env.DRY_RUN === 'true' ? '- Not looked up in a dry run.' : failedSteps(env, repo, gh);
  const detail = env.DETAIL?.trim();
  const body = [
    `The scheduled ${workflow} lane failed (jobs: ${jobs}; results: ${result}).`,
    `Failed steps:\n${steps}`,
    ...(detail ? [`Detail:\n${detail}`] : []),
    `Run: ${runUrl}`,
  ].join('\n\n');
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

if (isMainEntry(import.meta.url)) {
  const result = reportScheduledFailure(process.env, realGh);
  console.log(`${result.action}: ${result.title}`);
}
