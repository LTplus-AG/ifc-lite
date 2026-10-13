/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { ReportRow } from '../src/reports.js';
import type { Session } from '../src/sessions.js';
import { loadFeature } from './feature-loader.js';
const resolver = await loadFeature('../src/posthog-issue.js', () => import('../src/posthog-issue.js'));
const bindingFeature = await loadFeature('../src/issue-binding.js', () => import('../src/issue-binding.js'));
const commentFeature = await loadFeature('../src/github-comments.js', () => import('../src/github-comments.js'));
import { GithubIssues, publicIssueBody } from '../src/github.js';

const correlation = { eventId: randomUUID(), sessionId: randomUUID(), buildSha: 'build-a' };
const issueId = randomUUID();
const issueUrl = 'https://github.com/LTplus-AG/ifc-lite/issues/7493';
const config = { submissionsEnabled: true, admissionSecret: 'a'.repeat(40), githubAppId: '123', githubRepository: 'LTplus-AG/ifc-lite' } as Config;
const author = { appId: 123, userId: 341635942, login: 'ifc-lite-reviewed-reports[bot]' };
const bot = { id: author.userId, login: author.login, type: 'Bot' };
const owner = { id: 'session-owner' } as Session;
const binding = { correlation, posthogIssueId: issueId, issueUrl, title: 'Known crash', verifiedAt: new Date().toISOString() };
const report = { id: randomUUID(), fingerprint: 'report-only-key', created_at: new Date(), draft: {
  clientRequestId: randomUUID(), title: 'User-reviewed title', description: 'I selected a wall.', visibility: 'private',
  diagnostics: { errorCode: 'render_error', appVersion: '1', buildSha: 'build-a' },
} } as ReportRow;

describe('#7495 exact-event verification over real HTTP boundaries', () => {
  let base = '';
  let row: unknown[];
  let refs: unknown[];
  let comments: unknown[] = [];
  let commentPosts = 0;
  let issuePosts = 0;
  let loseCreateResponse = false;
  let issueDocument: Record<string, unknown> = { html_url: issueUrl, title: 'Known crash', state: 'open' };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/access_tokens')) { res.end(JSON.stringify({ token: 'test-token' })); return; }
    if (req.url === '/repos/LTplus-AG/ifc-lite/issues/7493') { res.end(JSON.stringify(issueDocument)); return; }
    if (req.url?.endsWith('/query/')) {
      const query = JSON.parse(body).query.query as string;
      expect(query).toContain(`uuid = toUUID('${correlation.eventId}')`);
      expect(query).toContain('LIMIT 2');
      res.end(JSON.stringify({ results: [row] })); return;
    }
    if (req.url?.includes('/error_tracking/issues/')) { res.end(JSON.stringify({ id: issueId, external_issues: refs })); return; }
    if (req.url?.includes('/comments')) {
      if (req.method === 'POST') {
        commentPosts++;
        comments.push({ body: JSON.parse(body).body, user: bot, performed_via_github_app: null });
        if (loseCreateResponse) { loseCreateResponse = false; res.destroy(); return; }
        res.end(JSON.stringify({ html_url: `${issueUrl}#issuecomment-123` })); return;
      }
      res.end(JSON.stringify(comments)); return;
    }
    if (req.method === 'POST') issuePosts++;
    res.statusCode = 404; res.end('{}');
  });
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test listener');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const posthog = () => ({ host: base, projectId: '42', apiKey: 'test-only' });
  const transport: typeof fetch = (url, init) => fetch(`${base}${new URL(String(url)).pathname}${new URL(String(url)).search}`, init);
  function exact() {
    row = [correlation.eventId, '$exception', correlation.sessionId, correlation.buildSha, issueId];
    refs = [{ integration: { kind: 'github' }, external_url: issueUrl }];
  }
  it('links only the exact event/session/build and the configured GitHub repository', async () => {
    exact(); expect(await resolver?.resolvePosthogIssue(posthog(), correlation, config.githubRepository)).toEqual({ issueId, issueUrl });
    for (const [index, value] of [[0, randomUUID()], [1, 'error_shown'], [2, randomUUID()], [3, 'another-build']] as const) {
      exact(); row[index] = value;
      expect(await resolver?.resolvePosthogIssue(posthog(), correlation, config.githubRepository)).toBeUndefined();
    }
    exact(); refs = [{ integration: { kind: 'github' }, external_url: 'https://github.com/attacker/repo/issues/1' }];
    expect(await resolver?.resolvePosthogIssue(posthog(), correlation, config.githubRepository)).toBeUndefined();
    exact(); refs.push({ integration: { kind: 'github' }, external_url: 'https://github.com/LTplus-AG/ifc-lite/issues/2' });
    expect(await resolver?.resolvePosthogIssue(posthog(), correlation, config.githubRepository)).toBeUndefined();
  });
  it('checks live GitHub issue identity and rejects closed, redirected or pull-request targets', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const github = new GithubIssues({ ...config, githubInstallationId: '1', githubPrivateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, transport);
    expect(await github.inspectIssue?.(issueUrl)).toEqual({ issueUrl, title: 'Known crash' });
    for (const changed of [{ state: 'closed' }, { pull_request: {} }, { html_url: 'https://github.com/attacker/repo/issues/1' }]) {
      issueDocument = { html_url: issueUrl, title: 'Known crash', state: 'open', ...changed };
      await expect(github.inspectIssue?.(issueUrl)).rejects.toThrow();
    }
    await expect(github.inspectIssue?.('https://github.com/attacker/repo/issues/1')).rejects.toThrow();
    issueDocument = { html_url: issueUrl, title: 'Known crash', state: 'open' };
  });
  it('binds reviewed destination to owner, build, expiry and signed target', () => {
    const target = bindingFeature?.signIssueBinding(config, owner, binding, 1000) ?? { issueUrl, title: binding.title, verificationToken: 'feature-unavailable' };
    expect(bindingFeature?.verifyIssueBinding(config, owner, target, 'build-a', 2000)).toEqual(binding);
    const forgedMac = { ...target, verificationToken: `${target.verificationToken.split('.')[0]}.${Buffer.alloc(32).toString('base64url')}` };
    expect(() => bindingFeature?.verifyIssueBinding(config, owner, forgedMac, 'build-a', 2000)).toThrow();
    expect(() => bindingFeature?.verifyIssueBinding(config, { ...owner, id: 'other' }, target, 'build-a', 2000)).toThrow();
    expect(() => bindingFeature?.verifyIssueBinding(config, owner, { ...target, issueUrl: 'https://github.com/LTplus-AG/ifc-lite/issues/2' }, 'build-a', 2000)).toThrow();
    expect(() => bindingFeature?.verifyIssueBinding(config, owner, target, 'different-build', 2000)).toThrow();
    expect(() => bindingFeature?.verifyIssueBinding(config, owner, target, 'build-a', 3601001)).toThrow();
  });
  it('reconciles a lost comment response with trusted app markers and never creates an issue', async () => {
    const body = publicIssueBody(report);
    comments = [{ body, performed_via_github_app: { id: 999 } }, { body: `${body}\nquoted`, performed_via_github_app: { id: 123 } }];
    loseCreateResponse = true;
    await expect(Promise.resolve(commentFeature?.findOrCreateComment(config, transport, 'test-token', author, report, issueUrl, body, async () => {}))).rejects.toThrow();
    expect(commentPosts).toBe(1);
    expect(await commentFeature?.findOrCreateComment(config, transport, 'test-token', author, report, issueUrl, body, async () => {})).toBe(issueUrl);
    expect(commentPosts).toBe(1); expect(issuePosts).toBe(0);
  });
  it('never publishes telemetry references, target tokens or private model details', () => {
    const sensitive = { ...report, issue_binding: binding, draft: { ...report.draft,
      issueTarget: bindingFeature?.signIssueBinding(config, owner, binding),
      diagnostics: { ...report.draft.diagnostics, eventId: correlation.eventId, sessionId: correlation.sessionId },
    } };
    const body = publicIssueBody(sensitive);
    expect(body).toContain('I selected a wall.');
    expect(body).not.toContain(correlation.eventId); expect(body).not.toContain(correlation.sessionId);
    expect(body).not.toContain('verificationToken');
  });
});
