/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as reservePort } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/database.js';
import { initializeStartupJournal } from './fixtures/startup-journal.js';

const databaseUrl = process.env.REPORT_TEST_DATABASE_URL;
const storageEndpoint = process.env.REPORT_TEST_S3_ENDPOINT;
const enabled = Boolean(databaseUrl && storageEndpoint);
if (process.env.REPORT_REQUIRE_INTEGRATION === 'true' && !enabled)
  throw new Error('Mandatory startup-publisher PostgreSQL/S3 fixture is missing');

async function observe(predicate: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 15000;
  let observed = false;
  while (Date.now() < deadline) {
    if (await predicate()) { observed = true; break; }
    await pause(50);
  }
  expect(observed, message).toBe(true);
}

it.skipIf(!enabled).each(['issue', 'comment'] as const)(
  '#7517 actual startup reconciles a lost %s POST after rollback and restart without another POST',
  async kind => {
    const schema = `startup_publisher_${randomUUID().replaceAll('-', '')}`;
    const admin = openDatabase(databaseUrl!);
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set('options', `-csearch_path=${schema}`);
    const db = openDatabase(scopedUrl.toString());
    const token = randomBytes(32).toString('hex');
    const owner = createHash('sha256').update(token).digest('hex');
    const reportId = randomUUID();
    const issueUrl = 'https://github.com/fixture/reporting/issues/7517';
    const bot = { id: 341635942, login: 'ifc-lite-reviewed-reports[bot]', type: 'Bot' };
    const fingerprint = randomUUID();
    let posts = 0;
    let visible = false;
    let saved: Record<string, unknown> | undefined;
    let child: ChildProcess | undefined;
    let exited: Promise<void> | undefined;
    let journalFixture: Awaited<ReturnType<typeof initializeStartupJournal>> | undefined;
    const github = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/app') { res.end(JSON.stringify({ id: 1, slug: 'ifc-lite-reviewed-reports' })); return; }
      if (req.url === '/users/ifc-lite-reviewed-reports%5Bbot%5D') { res.end(JSON.stringify(bot)); return; }
      if (req.url?.endsWith('/access_tokens')) { res.end(JSON.stringify({ token: 'owned-fixture' })); return; }
      if (req.url === '/repos/fixture/reporting/issues/7517') {
        res.end(JSON.stringify({ html_url: issueUrl, state: 'open', title: 'Existing owned fixture' })); return;
      }
      const expectedPath = kind === 'issue' ? '/repos/fixture/reporting/issues' : '/repos/fixture/reporting/issues/7517/comments';
      if (!req.url?.startsWith(expectedPath)) { res.statusCode = 404; res.end('{}'); return; }
      if (req.method === 'POST') {
        posts++;
        saved = { ...JSON.parse(body), html_url: kind === 'issue' ? issueUrl : issueUrl + '#issuecomment-1',
          created_at: new Date().toISOString(), user: bot, performed_via_github_app: null };
        res.destroy(); return;
      }
      res.end(JSON.stringify(visible && saved ? [saved] : []));
    });

    async function stop(): Promise<void> {
      const ownedChild = child;
      const ownedExit = exited;
      if (!ownedExit) return;
      if (ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null) ownedChild.kill('SIGTERM');
      let forced = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let exitDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([ownedExit, new Promise<void>(resolve => {
          timer = setTimeout(() => { forced = true; ownedChild?.kill('SIGKILL'); resolve(); }, 5000);
        })]);
        if (forced) await Promise.race([ownedExit, new Promise<never>((_, reject) => {
          exitDeadline = setTimeout(() => reject(new Error('Owned service did not exit after SIGKILL')), 5000);
        })]);
      } finally { clearTimeout(timer); clearTimeout(exitDeadline); }
      // Keep ownership until the exit event is observed, including forced stop.
      child = undefined; exited = undefined;
      if (forced) throw new Error('Owned service required forced shutdown');
    }

    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(db);
      await new Promise<void>((resolve, reject) => { github.once('error', reject); github.listen(0, '127.0.0.1', resolve); });
      const endpoint = github.address();
      if (!endpoint || typeof endpoint === 'string') throw new Error('Missing owned GitHub listener');
      const reservation = reservePort();
      await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
      const address = reservation.address();
      if (!address || typeof address === 'string') throw new Error('Port reservation failed');
      const port = address.port;
      await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
      const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, HOME: process.env.HOME,
        PORT: String(port), REPORT_DATABASE_URL: scopedUrl.toString(), REPORT_VIEWER_ORIGIN: 'https://viewer.example.test',
        REPORT_SUBMISSIONS_ENABLED: 'false', REPORT_ADMISSION_SECRET: randomBytes(32).toString('hex'), REPORT_ADMIN_TOKEN: randomBytes(32).toString('hex'),
        REPORT_STORAGE_PROVIDER: 'Owned fixture', REPORT_STORAGE_LOCATION: 'Loopback', REPORT_BACKUP_DISCLOSURE: 'None',
        REPORT_S3_ENDPOINT: 'http://127.0.0.1:1', REPORT_S3_BUCKET: 'unused', REPORT_S3_REGION: 'us-east-1',
        REPORT_S3_ACCESS_KEY_ID: 'unused', REPORT_S3_SECRET_ACCESS_KEY: 'unused',
        REPORT_GITHUB_APP_ID: '1', REPORT_GITHUB_INSTALLATION_ID: '1',
        REPORT_GITHUB_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), REPORT_GITHUB_REPOSITORY: 'fixture/reporting',
        REPORT_PUBLICATION_TEST_ENDPOINT: `http://127.0.0.1:${endpoint.port}`,
      };
      // R requires a real authenticated genesis before any reporting history.
      // This isolated fixture never supplies production custody or clears legacy data.
      journalFixture = await initializeStartupJournal(db, env);
      Object.assign(env, journalFixture.env);
      await db.query("INSERT INTO report_sessions VALUES($1,'fixture','fixture',now()+interval '1 day'),('expired-worker-witness','fixture','fixture',now()-interval '1 day')", [owner]);
      const draft = { clientRequestId: randomUUID(), title: 'Owned startup publication fixture', description: 'Synthetic local fixture only.',
        diagnostics: { errorCode: 'fixture', appVersion: 'fixture', buildSha: 'fixture' }, visibility: 'private' };
      await db.query("INSERT INTO model_reports(id,session_id,client_key,draft,status,fingerprint,issue_binding) VALUES($1,$2,$3,$4,'submitted',$5,$6)",
        [reportId, owner, draft.clientRequestId, JSON.stringify(draft), fingerprint, kind === 'comment' ? JSON.stringify({ issueUrl, title: 'Existing owned fixture' }) : null]);
      await db.query('INSERT INTO report_outbox(report_id) VALUES($1)', [reportId]);
      await db.query("CREATE FUNCTION fail_retry_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qualification transaction rollback'; END $$");
      await db.query('CREATE TRIGGER fail_retry_update BEFORE UPDATE ON report_outbox FOR EACH ROW EXECUTE FUNCTION fail_retry_update()');
      const base = `http://127.0.0.1:${port}`;
      const ownerReceipt = async () => (await fetch(`${base}/api/reports/${reportId}`, {
        headers: { Cookie: `__Host-ifclite_report=${token}` }, signal: AbortSignal.timeout(1000),
      })).json();
      const start = async (): Promise<void> => {
        let launchError: Error | undefined;
        child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./fixtures/local-publication-network.mjs', import.meta.url)),
          '--import', 'tsx', fileURLToPath(new URL('../src/bin.ts', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.resume(); child.stderr?.resume();
        const ownedChild = child;
        exited = new Promise<void>(resolve => {
          ownedChild.once('error', error => {
            launchError = error;
            // A spawn failure has no process to await. An error after spawn
            // does not substitute for the actual child exit event.
            if (ownedChild.pid === undefined) resolve();
          });
          ownedChild.once('exit', () => resolve());
        });
        await observe(async () => {
          if (launchError) throw launchError;
          try { return (await fetch(base + '/healthz', { signal: AbortSignal.timeout(500) })).ok; }
          catch (error) { if (error instanceof TypeError || error instanceof DOMException) return false; throw error; }
        }, 'actual service process must become healthy');
        expect(await (await fetch(base + '/api/reports/capabilities')).json()).toEqual({ submissionsEnabled: false });
      };
      await start();
      await observe(async () => posts === 1 && (await db.query('SELECT report_id FROM report_publication_intents WHERE report_id=$1', [reportId])).rowCount === 1,
        'actual startup publisher must POST once after independently committing intent');
      await observe(async () => (await db.query("SELECT pg_try_advisory_xact_lock(hashtext('report-github-publisher')) AS unlocked")).rows[0].unlocked,
        'failed retry update must roll back and release the publisher lock');
      expect((await db.query('SELECT attempts,last_error FROM report_outbox WHERE report_id=$1', [reportId])).rows).toEqual([{ attempts: 0, last_error: null }]);
      await observe(async () => (await db.query("SELECT id FROM report_sessions WHERE id='expired-worker-witness'")).rowCount === 0,
        'retention worker really ran alongside publication');
      await stop();
      await db.query('DROP TRIGGER fail_retry_update ON report_outbox');
      await start();
      await observe(async () => (await db.query('SELECT last_error FROM report_outbox WHERE report_id=$1', [reportId])).rows[0]?.last_error === 'github_publication_review_required',
        'restarted actual entrypoint must hold while the accepted POST is not yet listed');
      expect(posts).toBe(1);
      expect(await ownerReceipt()).toMatchObject({ id: reportId, status: 'submitted', publicationHold: 'review_required' });
      visible = true;
      await db.query('UPDATE report_outbox SET available_at=now() WHERE report_id=$1', [reportId]);
      await observe(async () => (await db.query('SELECT status FROM model_reports WHERE id=$1', [reportId])).rows[0]?.status === 'published',
        'actual startup publisher must reconcile the trusted marker without another POST');
      expect(posts).toBe(1);
      const published = await ownerReceipt();
      expect(published).toMatchObject({ id: reportId, status: 'published', issueUrl });
      expect(published).not.toHaveProperty('publicationHold');
      expect((await db.query('SELECT report_id FROM report_outbox WHERE report_id=$1', [reportId])).rowCount).toBe(0);
    } finally {
      try { await stop(); }
      finally {
        try {
          github.closeAllConnections();
          await new Promise<void>(resolve => github.close(() => resolve()));
        } finally {
          try { await journalFixture?.close(); }
          finally {
            try { await db.end(); }
            finally {
              try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
              finally { await admin.end(); }
            }
          }
        }
      }
    }
  }, 65000,
);
