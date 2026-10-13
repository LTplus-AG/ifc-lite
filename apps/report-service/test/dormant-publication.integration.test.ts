/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/database.js';

const databaseUrl = process.env.REPORT_TEST_DATABASE_URL;
if (process.env.REPORT_REQUIRE_INTEGRATION === 'true' && !databaseUrl)
  throw new Error('Mandatory dormant-publisher PostgreSQL fixture is missing');

it.skipIf(!databaseUrl)('#7495 C startup preserves queued reports without invoking the pre-#7517 publisher', async () => {
  const schema = `dormant_publisher_${randomUUID().replaceAll('-', '')}`;
  const admin = openDatabase(databaseUrl!);
  const scopedUrl = new URL(databaseUrl!);
  scopedUrl.searchParams.set('options', `-csearch_path=${schema}`);
  const db = openDatabase(scopedUrl.toString());
  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(db);
    const token = randomBytes(32).toString('hex');
    const owner = createHash('sha256').update(token).digest('hex');
    await db.query("INSERT INTO report_sessions VALUES($1,'fixture','fixture',now()+interval '1 day'),('expired-worker-witness','fixture','fixture',now()-interval '1 day')", [owner]);
    const reportId = randomUUID();
    const draft = { clientRequestId: randomUUID(), title: 'Owned dormant publication fixture', description: 'Synthetic local fixture only.', diagnostics: { errorCode: 'fixture', appVersion: 'fixture', buildSha: 'fixture' }, visibility: 'private' };
    await db.query("INSERT INTO model_reports(id,session_id,client_key,draft,status,fingerprint) VALUES($1,$2,$3,$4,'submitted',$5)", [reportId, owner, draft.clientRequestId, JSON.stringify(draft), randomUUID()]);
    await db.query('INSERT INTO report_outbox(report_id) VALUES($1)', [reportId]);
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Port reservation failed');
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME,
      PORT: String(port), REPORT_DATABASE_URL: scopedUrl.toString(), REPORT_VIEWER_ORIGIN: 'https://viewer.example.test',
      REPORT_SUBMISSIONS_ENABLED: 'false', REPORT_ADMISSION_SECRET: randomBytes(32).toString('hex'), REPORT_ADMIN_TOKEN: randomBytes(32).toString('hex'),
      REPORT_STORAGE_PROVIDER: 'Owned fixture', REPORT_STORAGE_LOCATION: 'Loopback', REPORT_BACKUP_DISCLOSURE: 'None',
      REPORT_S3_ENDPOINT: 'http://127.0.0.1:1', REPORT_S3_BUCKET: 'unused', REPORT_S3_REGION: 'us-east-1',
      REPORT_S3_ACCESS_KEY_ID: 'unused', REPORT_S3_SECRET_ACCESS_KEY: 'unused',
      // Deliberately invalid signing material cannot authenticate an App. The
      // preload also refuses every fetch before it can reach any public host.
      REPORT_GITHUB_APP_ID: '0', REPORT_GITHUB_INSTALLATION_ID: '0', REPORT_GITHUB_PRIVATE_KEY: 'not-a-private-key', REPORT_GITHUB_REPOSITORY: 'fixture/unusable',
    };
    child = spawn(process.execPath, [
      '--import', fileURLToPath(new URL('./fixtures/deny-publication-network.mjs', import.meta.url)),
      '--import', 'tsx', fileURLToPath(new URL('../src/bin.ts', import.meta.url)),
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Drain without retaining provider/private inputs in logs.
    child.stdout?.resume(); child.stderr?.resume();
    exited = new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('exit', () => resolve()); });
    const base = `http://127.0.0.1:${port}`;
    let healthy = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && child.exitCode === null) {
      try { healthy = (await fetch(base + '/healthz', { signal: AbortSignal.timeout(500) })).ok; }
      catch (error) { if (!(error instanceof TypeError || error instanceof DOMException)) throw error; }
      if (healthy) break;
      await pause(25);
    }
    expect(healthy, 'actual service process must become healthy').toBe(true);
    expect(await (await fetch(base + '/api/reports/capabilities')).json()).toEqual({ submissionsEnabled: false });
    const receipt = () => fetch(`${base}/api/reports/${reportId}`, { headers: { Cookie: `__Host-ifclite_report=${token}` } });
    expect(await (await receipt()).json()).toMatchObject({ id: reportId, status: 'submitted' });
    // The actual startup worker cadence is 10 seconds. Do not fake timers or
    // invoke publishOne directly: this qualifies the service entrypoint.
    await pause(11000);
    expect((await db.query("SELECT id FROM report_sessions WHERE id='expired-worker-witness'")).rowCount,
      'retention worker really ran during the observation window').toBe(0);
    const queue = await db.query<{ attempts: number; last_error: string | null }>('SELECT attempts,last_error FROM report_outbox WHERE report_id=$1', [reportId]);
    expect(queue.rows).toEqual([{ attempts: 0, last_error: null }]);
    expect(await (await receipt()).json()).toMatchObject({ id: reportId, status: 'submitted' });
    expect((await fetch(base + '/healthz')).ok).toBe(true);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    if (exited) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { child?.kill('SIGKILL'); reject(new Error('Owned service did not stop')); }, 5000);
      })]); } finally { clearTimeout(timer); }
    }
    await db.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
}, 30000);
