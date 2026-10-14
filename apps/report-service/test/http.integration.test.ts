/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReportReceipt, ReportSession } from '@ifc-lite/report-contract';
import type { Config } from '../src/config.js';
import { openDatabase, migrate } from '../src/database.js';
import { createHandler } from '../src/handler.js';
import { loadFeature } from './feature-loader.js';
const bindingFeature = await loadFeature('../src/issue-binding.js', () => import('../src/issue-binding.js'));
import { ModelStorage } from '../src/storage.js';
import { createReport } from '../src/reports.js';

const enabled = Boolean(process.env.REPORT_TEST_DATABASE_URL);
if (process.env.REPORT_REQUIRE_INTEGRATION === 'true' && !enabled)
  throw new Error('Mandatory real HTTP report integration database is missing');

describe.skipIf(!enabled)('#7495 real HTTP ownership, consent and publication boundaries', () => {
  const agreementText = 'LTplus AG protects models supplied for this test report.';
  const config: Config = {
    submissionsEnabled: true,
    origin: 'https://viewer.example.com', port: 0,
    databaseUrl: process.env.REPORT_TEST_DATABASE_URL ?? '',
    storageProvider: 'Unused test storage', storageLocation: 'Local test host', backupDisclosure: 'No backups',
    bucket: 'unused-http-tests', region: 'us-east-1', endpoint: 'http://127.0.0.1:1',
    accessKeyId: 'unused', secretAccessKey: 'unused',
    admissionSecret: randomUUID(), adminToken: randomUUID(),
    githubAppId: '1', githubInstallationId: '1', githubPrivateKey: 'unused', githubRepository: 'owner/repo',
    agreement: {
      version: 'http-test-v1', text: agreementText,
      sha256: createHash('sha256').update(agreementText).digest('hex'),
      issuer: 'LTplus AG', jurisdiction: 'Switzerland', signingEnabled: false,
    },
    maxDailyReports: 20, maxDailyBytes: 4 * 1024 ** 3, maxStorageBytes: 100 * 1024 ** 3,
  };
  const db = openDatabase(config.databaseUrl);
  // No permitted route in these cases contacts storage. An accidentally admitted
  // upload fails against a closed local port rather than any real model bucket.
  const handler = createHandler(db, new ModelStorage(config), config);
  const server = createServer((req, res) => { void handler(req, res); });
  let base = '';
  const sessionIds: string[] = [];
  interface Browser { cookie: string; csrf: string; id: string }
  async function browser(headers: Record<string, string> = {}): Promise<Browser> {
    const response = await fetch(`${base}/session`, { headers });
    expect(response.status).toBe(200);
    const cookieHeader = response.headers.get('set-cookie');
    expect(cookieHeader).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const cookie = cookieHeader!.split(';')[0]!;
    const id = createHash('sha256').update(cookie.split('=')[1]!).digest('hex');
    sessionIds.push(id);
    const value = await response.json() as ReportSession;
    return { cookie, csrf: value.csrfToken, id };
  }
  function request(owner: Browser, path: string, method = 'GET', input?: unknown, overrides: Record<string, string> = {}) {
    return fetch(base + path, {
      method, headers: {
        Cookie: owner.cookie, Origin: config.origin, 'X-CSRF-Token': owner.csrf,
        'Content-Type': 'application/json', ...overrides,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  }
  function draft() {
    return {
      clientRequestId: randomUUID(), title: 'HTTP reviewed report', description: 'Only this reviewed text may be published.',
      diagnostics: { errorCode: 'fixture', appVersion: 'test', buildSha: 'test' }, visibility: 'private',
    };
  }
  async function create(owner: Browser): Promise<ReportReceipt> {
    const response = await request(owner, '/drafts', 'POST', draft());
    expect(response.status).toBe(201);
    return await response.json() as ReportReceipt;
  }
  beforeAll(async () => {
    await migrate(db);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind TCP');
    base = `http://127.0.0.1:${address.port}/api/reports`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try {
      // Restrict cleanup to browser identities created by this suite.
      await db.query('DELETE FROM report_outbox WHERE report_id IN (SELECT id FROM model_reports WHERE session_id=ANY($1::text[]))', [sessionIds]);
      await db.query('DELETE FROM report_audit WHERE report_id IN (SELECT id FROM model_reports WHERE session_id=ANY($1::text[])) OR actor=ANY($1::text[])', [sessionIds]);
      await db.query('DELETE FROM report_uploads WHERE report_id IN (SELECT id FROM model_reports WHERE session_id=ANY($1::text[]))', [sessionIds]);
      await db.query('DELETE FROM model_reports WHERE session_id=ANY($1::text[])', [sessionIds]);
      await db.query('DELETE FROM report_admission WHERE key IN (SELECT admission FROM report_sessions WHERE id=ANY($1::text[]))', [sessionIds]);
      await db.query('DELETE FROM report_sessions WHERE id=ANY($1::text[])', [sessionIds]);
    } finally { await db.end(); }
  });

  it('#7495 accepts case-insensitive JSON media types and parameter whitespace without widening accepted types', async () => {
    const owner = await browser();
    for (const mediaType of ['Application/JSON', 'application/json ; charset=utf-8']) {
      const response = await request(owner, '/drafts', 'POST', draft(), { 'Content-Type': mediaType });
      expect(response.status).toBe(201);
      const created = await response.json() as ReportReceipt;
      expect((await request(owner, `/${created.id}`)).status).toBe(200);
    }
    for (const mediaType of ['text/plain', 'application/json-patch+json', '']) {
      const response = await request(owner, '/drafts', 'POST', draft(), { 'Content-Type': mediaType });
      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({ error: 'json_required' });
    }
    const persisted = await db.query<{ count: string }>('SELECT count(*) FROM model_reports WHERE session_id=$1', [owner.id]);
    expect(Number(persisted.rows[0]!.count)).toBe(2);
  });

  it("#7495 quarantine foundation does not activate public admission or advertise delivery", async () => {
    const owner = await browser();
    const capabilities = await (await request(owner, '/session')).json() as ReportSession;
    expect(capabilities.storage.publicSharingEnabled).toBe(false);
    const input = { ...draft(), visibility: 'public' };
    const denied = await request(owner, '/drafts', 'POST', input);
    expect(denied.status).toBe(409);
    expect((await denied.json() as { error: string }).error).toBe('public_unavailable');
    expect((await db.query('SELECT id FROM model_reports WHERE client_key=$1', [input.clientRequestId])).rows).toEqual([]);
  });

  it('#7495 late report creation and idempotent retry preserve ownership past the original expiry', async () => {
    const owner = await browser();
    const input = draft();
    const originalExpiry = new Date(Date.now() + 2000);
    await db.query('UPDATE report_sessions SET expires_at=$2 WHERE id=$1', [owner.id, originalExpiry]);
    const created = await request(owner, '/drafts', 'POST', input);
    expect(created.status).toBe(201);
    const report = await created.json() as ReportReceipt;
    const lifetime = async () => (await db.query<{ owner_expiry: Date; report_expiry: Date }>(
      'SELECT s.expires_at AS owner_expiry,r.expires_at AS report_expiry FROM report_sessions s JOIN model_reports r ON r.session_id=s.id WHERE r.id=$1', [report.id],
    )).rows[0]!;
    expect((await lifetime()).owner_expiry.getTime()).toBeGreaterThanOrEqual((await lifetime()).report_expiry.getTime());
    // Simulate a restored short credential before an idempotent response retry.
    await db.query('UPDATE report_sessions SET expires_at=$2 WHERE id=$1', [owner.id, originalExpiry]);
    const retried = await request(owner, '/drafts', 'POST', input);
    expect(retried.status).toBe(201);
    expect(await retried.json()).toEqual(report);
    expect((await lifetime()).owner_expiry.getTime()).toBeGreaterThanOrEqual((await lifetime()).report_expiry.getTime());
    await new Promise(resolve => setTimeout(resolve, Math.max(0, originalExpiry.getTime() - Date.now() + 50)));
    expect((await request(owner, `/${report.id}`)).status).toBe(200);
    expect((await request(owner, `/${report.id}`, 'DELETE')).status).toBe(200);
  });

  it('#7495 a successful draft response refreshes the same secure owner cookie; rejected requests do not', async () => {
    const owner = await browser();
    const input = draft();
    await db.query("UPDATE report_sessions SET expires_at=now()+interval '1 day' WHERE id=$1", [owner.id]);
    const rejectedHeaders: Record<string, string>[] = [{ Origin: 'https://attacker.example' }, { 'X-CSRF-Token': 'wrong' }];
    for (const overrides of rejectedHeaders) {
      const denied = await request(owner, '/drafts', 'POST', input, overrides);
      expect(denied.status).toBe(403);
      expect(denied.headers.get('set-cookie')).toBeNull();
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(owner, '/drafts', 'POST', input);
      expect(response.status).toBe(201);
      const header = response.headers.get('set-cookie');
      expect(header).toContain(`${owner.cookie}; Path=/; HttpOnly; Secure; SameSite=Strict;`);
      expect(header).not.toContain('Domain=');
      expect(Number(header?.match(/Max-Age=(\d+)/)?.[1])).toBeGreaterThanOrEqual(2591998);
    }
  });

  it('#7495 a vanished authenticated session rolls back draft admission', async () => {
    const owner = await browser();
    const authenticated = (await db.query<{ admission: string; expiresAt: Date }>(
      'SELECT admission,expires_at AS "expiresAt" FROM report_sessions WHERE id=$1', [owner.id],
    )).rows[0]!;
    const before = (await db.query('SELECT reports FROM report_admission WHERE key=$1 AND day=CURRENT_DATE', [authenticated.admission])).rows;
    await db.query('DELETE FROM report_sessions WHERE id=$1', [owner.id]);
    const input = { ...draft(), visibility: 'private' as const };
    await expect(createReport(db, config, { ...owner, ...authenticated }, input)).rejects.toMatchObject({ status: 401 });
    expect((await db.query('SELECT id FROM model_reports WHERE client_key=$1', [input.clientRequestId])).rowCount).toBe(0);
    expect((await db.query('SELECT reports FROM report_admission WHERE key=$1 AND day=CURRENT_DATE', [authenticated.admission])).rows).toEqual(before);
  });

  it("#7495 launch gate blocks public admission and content while preserving owner deletion", async () => {
      const owner = await browser();
      const report = await create(owner);
      const before = (
        await db.query("SELECT count(*) AS count FROM report_sessions")
      ).rows[0].count;
      config.submissionsEnabled = false;
      config.qualificationToken = "qualification-only-secret-".repeat(2);
      try {
        expect(await (await fetch(base + "/capabilities")).json()).toEqual({
          submissionsEnabled: false,
        });
        const deniedHeaders: Record<string, string>[] = [
          {},
          { "X-Ifclite-Qualification": "wrong" },
        ];
        for (const headers of deniedHeaders) {
          const blocked = await fetch(base + "/session", { headers });
          expect(blocked.status).toBe(503);
          expect(blocked.headers.get("set-cookie")).toBeNull();
        }
        expect(
          (await db.query("SELECT count(*) AS count FROM report_sessions"))
            .rows[0].count,
        ).toBe(before);
        expect((await request(owner, "/drafts", "POST", draft())).status).toBe(
          503,
        );
        expect(
          (await request(owner, `/${report.id}/submit`, "POST", {})).status,
        ).toBe(503);
        expect((await request(owner, `/${report.id}`)).status).toBe(200);
        const recovered = await request(owner, "/session");
        expect(recovered.status).toBe(200);
        expect(await recovered.json()).toMatchObject({
          csrfToken: owner.csrf,
          submissionsEnabled: false,
        });
        expect(
          (
            await request(owner, `/${report.id}`, "DELETE", undefined, {
              Origin: "https://attacker.example",
            })
          ).status,
        ).toBe(403);
        expect((await request(owner, `/${report.id}`, "DELETE")).status).toBe(
          200,
        );
        expect(
          (
            await db.query("SELECT status FROM model_reports WHERE id=$1", [
              report.id,
            ])
          ).rows[0].status,
        ).toBe("deleted");
        expect(
          (await fetch(base.replace("/api/reports", "") + "/healthz")).status,
        ).toBe(200);
        expect((await fetch(base + "/admin/reports")).status).toBe(401);
      expect((await fetch(base + "/admin/pending", {
        headers: { Authorization: `Bearer ${config.adminToken}` },
      })).status).toBe(200);
      } finally {
        config.submissionsEnabled = true;
        config.qualificationToken = undefined;
      }
    });
    it("#7495 qualification credential permits protected tests without bypassing origin or CSRF", async () => {
      config.submissionsEnabled = false;
      config.qualificationToken = "qualification-only-secret-".repeat(2);
      const headers = { "X-Ifclite-Qualification": config.qualificationToken };
      try {
        expect(
          await (await fetch(base + "/capabilities", { headers })).json(),
        ).toEqual({ submissionsEnabled: true });
        const owner = await browser(headers);
        const rejected = await request(owner, "/drafts", "POST", draft(), {
          ...headers,
          Origin: "https://attacker.example",
        });
        expect(rejected.status).toBe(403);
        expect(
          (
            await request(owner, "/drafts", "POST", draft(), {
              ...headers,
              "X-CSRF-Token": "wrong",
            })
          ).status,
        ).toBe(403);
        const created = await request(
          owner,
          "/drafts",
          "POST",
          draft(),
          headers,
        );
        expect(created.status).toBe(201);
        expect(await created.text()).not.toContain(config.qualificationToken);
        // Explicit public enable still preserves the same-origin guard.
        config.submissionsEnabled = true;
        expect(
          (
            await request(owner, "/drafts", "POST", draft(), {
              Origin: "https://attacker.example",
            })
          ).status,
        ).toBe(403);
      } finally {
        config.submissionsEnabled = true;
        config.qualificationToken = undefined;
      }
    });

    it('rejects cross-origin session admission before issuing cookies or consuming quota', async () => {
    const anchor = await browser(); // Direct clients may omit both browser headers.
    const count = async () => (await db.query<{ count: string }>(
      'SELECT count(*) FROM report_sessions WHERE admission=(SELECT admission FROM report_sessions WHERE id=$1)',
      [anchor.id],
    )).rows[0]!.count;
    const before = await count();
    const rejected: Record<string, string>[] = [
      { Origin: 'https://attacker.example' },
      { Origin: 'https://sub.viewer.example.com', 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': 'cross-site' }, // Cross-origin img may omit Origin.
      { 'Sec-Fetch-Site': 'same-site' },
      { Origin: 'null', 'Sec-Fetch-Site': 'none' },
    ];
    for (const headers of rejected) {
      const response = await fetch(`${base}/session`, { headers });
      expect(response.status).toBe(403);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await count()).toBe(before);
    }
    // Preserve normal browser fetch, direct navigation and explicit same-origin requests.
    await browser({ 'Sec-Fetch-Site': 'same-origin' });
    await browser({ 'Sec-Fetch-Site': 'none' });
    await browser({ Origin: config.origin, 'Sec-Fetch-Site': 'same-origin' });
    expect(Number(await count())).toBe(Number(before) + 3);
  });

  it('rejects wrong origin, wrong/missing CSRF and absent owner before creating a draft', async () => {
    const owner = await browser();
    const deniedHeaders: Record<string, string>[] = [
      { Origin: 'https://attacker.example' },
      { 'X-CSRF-Token': 'invalid' },
      { 'X-CSRF-Token': '' },
    ];
    for (const headers of deniedHeaders)
      expect((await request(owner, '/drafts', 'POST', draft(), headers)).status).toBe(403);
    expect((await request(owner, '/drafts', 'POST', draft(), { Cookie: '' })).status).toBe(401);
    const rows = await db.query('SELECT id FROM model_reports WHERE session_id=$1', [owner.id]);
    expect(rows.rowCount).toBe(0);
    expect((await create(owner)).status).toBe('draft');
  });

  it('denies another owner both private report and existing agreement PDF', async () => {
    const owner = await browser(); const stranger = await browser(); const report = await create(owner);
    config.agreement.signingEnabled = true;
    try {
      const acceptance = await request(owner, `/${report.id}/consent`, 'POST', {
        agreementSha256: config.agreement.sha256, signerName: 'Example Signer', signerEmail: 'signer@example.com',
        organization: 'Example Organisation', authorityConfirmed: true, accepted: true,
      });
      expect(acceptance.status).toBe(200);
      const pdf = await request(owner, `/${report.id}/agreement.pdf`);
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get('content-type')).toBe('application/pdf');
      expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
      for (const path of [`/${report.id}`, `/${report.id}/agreement.pdf`])
        expect((await request(stranger, path)).status).toBe(404);
      expect((await request(stranger, `/${report.id}`, 'DELETE')).status).toBe(404);
      expect((await request(owner, `/${report.id}`)).status).toBe(200);
    } finally { config.agreement.signingEnabled = false; }
  });

  it('preserves the verified destination on first and repeated HTTP submit, then erases it on deletion (#7495, #7515)', async () => {
    const owner = await browser();
    const stranger = await browser();
    const correlation = { eventId: randomUUID(), sessionId: randomUUID(), buildSha: 'test' };
    const binding = { correlation, posthogIssueId: randomUUID(), issueUrl: 'https://github.com/owner/repo/issues/12', title: 'Existing issue', verifiedAt: new Date().toISOString() };
    const target = bindingFeature?.signIssueBinding(config, { ...owner, admission: 'unused' }, binding) ?? { issueUrl: binding.issueUrl, title: binding.title, verificationToken: 'feature-unavailable' };
    const input = { ...draft(), issueTarget: target };
    expect((await request(stranger, '/drafts', 'POST', input)).status).toBe(400);
    expect((await request(owner, '/drafts', 'POST', { ...input, issueTarget: { ...target, issueUrl: 'https://github.com/owner/repo/issues/13' } })).status).toBe(400);
    const created = await request(owner, '/drafts', 'POST', input);
    expect(created.status).toBe(201);
    const report = await created.json() as ReportReceipt;
    const rows = await db.query('SELECT issue_binding,draft FROM model_reports WHERE id=$1', [report.id]);
    expect(rows.rows[0].issue_binding).toEqual(binding);
    expect(rows.rows[0].draft.issueTarget).toBeUndefined();
    expect(JSON.stringify(rows.rows[0].draft)).not.toContain(correlation.eventId);
    const restored = await (await request(owner, `/${report.id}`)).json() as ReportReceipt;
    expect(restored.issueDestination?.issueUrl).toBe(binding.issueUrl);
    expect(JSON.stringify(restored)).not.toContain(correlation.sessionId);
    // #7515 review4269572424: the first submission must use the same durable
    // receipt projection as its retry, without leaking the private binding.
    const firstResponse = await request(owner, `/${report.id}/submit`, 'POST', {});
    expect(firstResponse.status).toBe(202);
    const firstReceipt = await firstResponse.json() as ReportReceipt;
    expect(firstReceipt).toEqual({ id: report.id, status: 'submitted',
      issueDestination: { issueUrl: binding.issueUrl, title: binding.title } });
    expect(JSON.stringify(firstReceipt)).not.toContain(correlation.sessionId);
    const retryResponse = await request(owner, `/${report.id}/submit`, 'POST', {});
    expect(retryResponse.status).toBe(202);
    expect(await retryResponse.json()).toEqual(firstReceipt);
    expect((await db.query('SELECT report_id FROM report_outbox WHERE report_id=$1', [report.id])).rowCount).toBe(1);
    expect((await request(owner, `/${report.id}`, 'DELETE')).status).toBe(200);
    expect((await db.query('SELECT issue_binding FROM model_reports WHERE id=$1', [report.id])).rows[0].issue_binding).toBeNull();
  });

  it('reports disabled exact-event lookup honestly without creating a draft (#7495)', async () => {
    const owner = await browser();
    const lookup = await request(owner, '/resolve-issue', 'POST', { eventId: randomUUID(), sessionId: randomUUID(), buildSha: 'test' });
    expect(lookup.status).toBe(200); expect(await lookup.json()).toEqual({ status: 'unavailable' });
    expect((await db.query('SELECT id FROM model_reports WHERE session_id=$1', [owner.id])).rowCount).toBe(0);
    expect((await request(owner, '/resolve-issue', 'POST', { eventId: "' OR 1=1", sessionId: randomUUID(), buildSha: 'test' })).status).toBe(400);
  });

  it('queues GitHub publication only after explicit submit and makes repeat submit idempotent', async () => {
    const owner = await browser(); const report = await create(owner);
    const queued = () => db.query('SELECT report_id FROM report_outbox WHERE report_id=$1', [report.id]);
    expect((await queued()).rowCount).toBe(0);
    expect((await request(owner, `/${report.id}`)).status).toBe(200);
    expect((await queued()).rowCount).toBe(0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(owner, `/${report.id}/submit`, 'POST', {});
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ id: report.id, status: 'submitted' });
    }
    expect((await queued()).rowCount).toBe(1);
    const rows = await db.query('SELECT issue_url FROM model_reports WHERE id=$1', [report.id]);
    expect(rows.rows[0]?.issue_url).toBeNull();
  });

  it('requires standard approval and keeps custom NDA pending until authenticated maintainer review', async () => {
    const owner = await browser(); const report = await create(owner);
    const upload = { name: 'private.ifc', size: 20, type: 'application/octet-stream', confidentiality: 'standard', uploadConsent: true };
    expect((await request(owner, `/${report.id}/uploads`, 'POST', upload)).status).toBe(409);
    const pending = await request(owner, `/${report.id}/custom-nda`, 'POST', { message: 'Contact model-owner@example.com privately before upload.' });
    expect(pending.status).toBe(200);
    expect((await request(owner, `/${report.id}/submit`, 'POST', {})).status).toBe(409);
    expect((await request(owner, `/${report.id}/uploads`, 'POST', { ...upload, confidentiality: 'custom' })).status).toBe(409);
    const approval = { accepted: true, signedAgreementReference: 'private-agreement-reference' };
    expect((await request(owner, `/admin/${report.id}/custom-nda`, 'POST', approval)).status).toBe(401);
    const accepted = await request(owner, `/admin/${report.id}/custom-nda`, 'POST', approval, { Authorization: `Bearer ${config.adminToken}` });
    expect(accepted.status).toBe(200);
    const resumed = await request(owner, `/${report.id}`);
    expect(await resumed.json()).toMatchObject({ id: report.id, status: 'draft', customNdaStatus: 'approved' });
    expect((await db.query('SELECT id FROM report_uploads WHERE report_id=$1', [report.id])).rowCount).toBe(0);
    expect((await db.query('SELECT report_id FROM report_outbox WHERE report_id=$1', [report.id])).rowCount).toBe(0);
  });

  it('rejects expired report access and expired sessions rather than renewing ownership silently', async () => {
    const owner = await browser(); const report = await create(owner);
    await db.query("UPDATE model_reports SET expires_at=now()-interval '1 second' WHERE id=$1", [report.id]);
    expect((await request(owner, `/${report.id}`)).status).toBe(404);
    expect((await request(owner, `/${report.id}/submit`, 'POST', {})).status).toBe(404);
    const live = await create(owner);
    await db.query("UPDATE report_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [owner.id]);
    expect((await request(owner, `/${live.id}`)).status).toBe(401);
    expect((await request(owner, `/${live.id}/submit`, 'POST', {})).status).toBe(401);
  });
});
