/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { isRecord, isReportCorrelation, type ReportCorrelation, type VerifiedIssueTarget, type IssueResolution } from '@ifc-lite/report-contract';
import type { Config } from './config.js';
import { audit, transaction, type Db } from './database.js';
import type { Session } from './sessions.js';
import { requireCondition } from './errors.js';
import { resolvePosthogIssue } from './posthog-issue.js';
import { GithubIssues } from './github.js';

export interface IssueBinding {
  correlation: ReportCorrelation;
  posthogIssueId: string;
  issueUrl: string;
  title: string;
  verifiedAt: string;
}
function signature(config: Config, value: string): Buffer {
  return createHmac('sha256', config.admissionSecret).update(`report-issue-binding-v1:${value}`).digest();
}
export function signIssueBinding(config: Config, owner: Session, binding: IssueBinding, now = Date.now()): VerifiedIssueTarget {
  const payload = Buffer.from(JSON.stringify({ ...binding, owner: owner.id, expiresAt: now + 3600000 })).toString('base64url');
  return { issueUrl: binding.issueUrl, title: binding.title, verificationToken: `${payload}.${signature(config, payload).toString('base64url')}` };
}
export function verifyIssueBinding(config: Config, owner: Session, target: VerifiedIssueTarget, buildSha: string, now = Date.now()): IssueBinding {
  const [payload, mac, extra] = target.verificationToken.split('.');
  requireCondition(payload && mac && !extra && target.verificationToken.length <= 4096, 400, 'issue_target_invalid', 'Check the issue destination again.');
  const expected = signature(config, payload);
  const supplied = Buffer.from(mac, 'base64url');
  requireCondition(supplied.length === expected.length && timingSafeEqual(supplied, expected), 400, 'issue_target_invalid', 'Check the issue destination again.');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()); }
  catch { throw new Error('issue_binding_invalid_json'); }
  requireCondition(isRecord(parsed) && parsed.owner === owner.id && typeof parsed.expiresAt === 'number' && parsed.expiresAt > now &&
    isReportCorrelation(parsed.correlation) && parsed.correlation.buildSha === buildSha && parsed.issueUrl === target.issueUrl && parsed.title === target.title &&
    typeof parsed.posthogIssueId === 'string' && typeof parsed.verifiedAt === 'string', 400, 'issue_target_expired', 'The issue destination expired or changed. Check it again.');
  return { correlation: parsed.correlation, posthogIssueId: parsed.posthogIssueId, issueUrl: target.issueUrl, title: target.title, verifiedAt: parsed.verifiedAt };
}
export async function resolveIssueTarget(db: Db, config: Config, owner: Session, correlation: ReportCorrelation, github = new GithubIssues(config)): Promise<IssueResolution> {
  if (!config.posthog) return { status: 'unavailable' };
  // Bound lookup cost independently of draft admission; no report is created here.
  await transaction(db, async tx => {
    const result = await tx.query(`INSERT INTO report_admission(key,issue_lookups) VALUES($1,1)
      ON CONFLICT(key,day) DO UPDATE SET issue_lookups=report_admission.issue_lookups+1
      WHERE report_admission.issue_lookups<20 RETURNING issue_lookups`, [owner.admission]);
    requireCondition(result.rowCount === 1, 429, 'issue_lookup_quota', 'Issue lookup limit reached. Try again tomorrow.');
  });
  try {
    const resolved = await resolvePosthogIssue(config.posthog, correlation, config.githubRepository);
    if (!resolved) return { status: 'unmatched' };
    const target = await github.inspectIssue(resolved.issueUrl);
    const binding = { ...target, correlation, posthogIssueId: resolved.issueId, verifiedAt: new Date().toISOString() };
    await audit(db, null, 'issue_target_verified', owner.id);
    return { status: 'matched', target: signIssueBinding(config, owner, binding) };
  } catch {
    // A timeout or failed verification must not become a guessed match or a
    // fallback issue creation. The user can retry or explicitly choose a new issue.
    return { status: 'unavailable' };
  }
}
