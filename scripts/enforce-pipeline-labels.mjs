#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Remove a pipeline-steering label when its LabeledEvent was not created by a
 * configured authority. GitHub rulesets protect Git refs, not issue/PR labels,
 * and repository triage/write roles can otherwise apply every label.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { normaliseLogin, readConfig } from './check-issue-queue.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(ROOT, 'issue-queue.config.json');

export class LabelAuthorityError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'LabelAuthorityError';
    this.reason = reason;
  }
}

export function decideLabelEvent(payload, cfg) {
  if (cfg.requireLabelAuthority !== true) {
    throw new LabelAuthorityError(
      'BAD_CONFIG',
      'requireLabelAuthority must be true while protected-label enforcement is installed.',
    );
  }
  if (!payload || typeof payload !== 'object') {
    throw new LabelAuthorityError('BAD_EVENT', 'The webhook payload is not an object.');
  }
  if (payload.action !== 'labeled') {
    return { action: 'ignore', reason: 'NOT_LABELED' };
  }
  const label = payload.label?.name;
  if (typeof label !== 'string' || label.trim() === '') {
    throw new LabelAuthorityError('BAD_EVENT', 'A labeled event carries no label name.');
  }
  const protectedLabels = new Map([
    [cfg.readyLabel.toLowerCase(), cfg.readyLabel],
    [cfg.escapeLabel.toLowerCase(), cfg.escapeLabel],
  ]);
  const canonical = protectedLabels.get(label.toLowerCase());
  if (!canonical) return { action: 'ignore', reason: 'UNPROTECTED_LABEL' };

  const sender = normaliseLogin(payload.sender?.login);
  if (sender === null) {
    throw new LabelAuthorityError(
      'UNKNOWN_SENDER',
      `Protected label ${JSON.stringify(canonical)} was applied without a readable sender.`,
    );
  }
  if (cfg.labelAuthorities.has(sender)) {
    return { action: 'keep', label: canonical, sender };
  }

  const number = payload.issue?.number ?? payload.pull_request?.number ?? payload.number;
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new LabelAuthorityError(
      'BAD_EVENT',
      `Protected label ${JSON.stringify(canonical)} has no positive issue or pull-request number.`,
    );
  }
  return { action: 'remove', label: canonical, sender, number };
}

export function enforceLabelEvent(payload, { cfg, repo, spawn = spawnSync }) {
  const decision = decideLabelEvent(payload, cfg);
  if (decision.action !== 'remove') return decision;
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new LabelAuthorityError('BAD_REPO', `Invalid GITHUB_REPOSITORY ${JSON.stringify(repo)}.`);
  }

  const endpoint = `repos/${repo}/issues/${decision.number}/labels/${encodeURIComponent(decision.label)}`;
  const result = spawn('gh', ['api', '--method', 'DELETE', endpoint], {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    throw new LabelAuthorityError(
      'REMOVE_FAILED',
      `Could not remove ${JSON.stringify(decision.label)} from #${decision.number}: ` +
        `${result.error?.message ?? (String(result.stderr ?? '').trim() || `exit ${result.status}`)}`,
    );
  }
  return decision;
}

function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new LabelAuthorityError('BAD_EVENT', 'GITHUB_EVENT_PATH is unset.');
  const payload = JSON.parse(readFileSync(eventPath, 'utf8'));
  const cfg = readConfig(DEFAULT_CONFIG);
  const decision = enforceLabelEvent(payload, {
    cfg,
    repo: process.env.GITHUB_REPOSITORY,
  });
  if (decision.action === 'remove') {
    console.log(
      `REMOVED: @${decision.sender} is not in labelAuthorities; protected label ` +
        `${JSON.stringify(decision.label)} was removed from #${decision.number}.`,
    );
  } else if (decision.action === 'keep') {
    console.log(`KEPT: @${decision.sender} is authorised to apply protected label ${JSON.stringify(decision.label)}.`);
  } else {
    console.log(`IGNORED: ${decision.reason}.`);
  }
}

if (isMainEntry(import.meta.url)) {
  try {
    main();
  } catch (error) {
    if (error instanceof LabelAuthorityError) {
      console.error(`❌ ${error.reason}: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
