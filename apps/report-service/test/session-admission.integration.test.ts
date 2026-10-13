/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { migrate, openDatabase } from '../src/database.js';
import { createHandler } from '../src/handler.js';
import { ModelStorage } from '../src/storage.js';

const databaseUrl = process.env.REPORT_TEST_DATABASE_URL;
if (process.env.REPORT_REQUIRE_INTEGRATION === 'true' && !databaseUrl)
  throw new Error('Mandatory real session-admission database is missing');

it.skipIf(!databaseUrl)('#7495 actual concurrent HTTP admission admits exactly one session at 99/100', async () => {
  const schema = `session_admission_${randomUUID().replaceAll('-', '')}`;
  const admin = openDatabase(databaseUrl!);
  const scopedUrl = new URL(databaseUrl!);
  scopedUrl.searchParams.set('options', `-csearch_path=${schema}`);
  scopedUrl.searchParams.set('application_name', schema);
  const db = openDatabase(scopedUrl.toString());
  const config: Config = {
    submissionsEnabled: true, origin: 'https://viewer.example.test', port: 0,
    databaseUrl: scopedUrl.toString(), trustedProxyCidrs: ['127.0.0.1/32'],
    storageProvider: 'Unused fixture', storageLocation: 'Owned local fixture', backupDisclosure: 'None',
    bucket: 'unused', region: 'us-east-1', endpoint: 'http://127.0.0.1:1',
    accessKeyId: 'unused', secretAccessKey: 'unused', admissionSecret: randomUUID(), adminToken: randomUUID(),
    githubAppId: '1', githubInstallationId: '1', githubPrivateKey: 'unused', githubRepository: 'owner/repo',
    agreement: { version: 'disabled', sha256: '', text: '', issuer: 'LTplus AG', jurisdiction: 'Switzerland', signingEnabled: false },
    maxDailyReports: 20, maxDailyBytes: 1024 ** 3, maxStorageBytes: 10 * 1024 ** 3,
  };
  const storage = new ModelStorage(config);
  const handler = createHandler(db, storage, config);
  const server = createServer((req, res) => { void handler(req, res); });
  const held = await admin.connect();
  const pending: Promise<Response>[] = [];
  let lockHeld = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(db);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
    const url = `http://127.0.0.1:${address.port}/api/reports/session`;
    const headers = { Origin: config.origin, 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': '192.0.2.1' };
    const request = (extra: Record<string, string> = {}) => fetch(url, {
      headers: { ...headers, ...extra }, signal: AbortSignal.timeout(10000),
    });
    const owner = await request();
    expect(owner.status).toBe(200);
    const cookie = owner.headers.get('set-cookie')!.split(';')[0]!;
    const ownerId = createHash('sha256').update(cookie.split('=')[1]!).digest('hex');
    await owner.arrayBuffer();
    const admission = (await db.query<{ admission: string }>('SELECT admission FROM report_sessions WHERE id=$1', [ownerId])).rows[0]!.admission;
    // 99 active sessions plus expired rows: expiry must not consume capacity.
    await db.query(`INSERT INTO report_sessions(id,csrf,admission,expires_at)
      SELECT $1 || n, 'fixture', $2, now()+interval '1 day' FROM generate_series(1,98) n`, [schema, admission]);
    await db.query(`INSERT INTO report_sessions(id,csrf,admission,expires_at)
      SELECT $1 || 'expired' || n, 'fixture', $2, now()-interval '1 day' FROM generate_series(1,3) n`, [schema, admission]);
    await held.query('BEGIN');
    await held.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`report-session:${admission}`]);
    lockHeld = true;
    pending.push(request(), request());
    // Observe both real server requests waiting in PostgreSQL, not a mocked
    // count result or a rendezvous inside the serialized critical section.
    let waiting = 0;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && waiting < 2) {
      waiting = Number((await admin.query<{ count: string }>(
        "SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND wait_event='advisory'", [schema],
      )).rows[0]!.count);
      if (waiting < 2) await pause(20);
    }
    expect(waiting, 'both actual HTTP admissions must wait for their per-identity lock').toBe(2);
    // Neither recovering an existing owner nor a different verified identity
    // may queue behind this identity's capacity check.
    const recovered = await request({ Cookie: cookie });
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get('set-cookie')).toBeNull();
    await recovered.arrayBuffer();
    const other = await request({ 'X-Forwarded-For': '192.0.2.2' });
    expect(other.status).toBe(200);
    await other.arrayBuffer();
    await held.query('COMMIT');
    lockHeld = false;
    const responses = await Promise.all(pending);
    expect(responses.map(response => response.status).sort()).toEqual([200, 429]);
    expect(responses.filter(response => response.headers.has('set-cookie'))).toHaveLength(1);
    const denied = responses.find(response => response.status === 429)!;
    expect(await denied.json()).toMatchObject({ error: 'session_limit' });
    await responses.find(response => response.status === 200)!.arrayBuffer();
    expect(Number((await db.query<{ count: string }>(
      'SELECT count(*) FROM report_sessions WHERE admission=$1 AND expires_at>now()', [admission],
    )).rows[0]!.count)).toBe(100);
    const atCapacity = await request({ Cookie: cookie });
    expect(atCapacity.status).toBe(200);
    await atCapacity.arrayBuffer();
    // Force an actual database insertion failure: no owner cookie may escape
    // the failed transaction, and its connection/lock must be reusable.
    await db.query(`CREATE FUNCTION reject_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned admission fixture'; END $$`);
    await db.query('CREATE TRIGGER reject_session BEFORE INSERT ON report_sessions FOR EACH ROW EXECUTE FUNCTION reject_session()');
    const failed = await request({ 'X-Forwarded-For': '192.0.2.3' });
    expect(failed.status).toBe(503);
    expect(failed.headers.get('set-cookie')).toBeNull();
    await failed.arrayBuffer();
    await db.query('DROP TRIGGER reject_session ON report_sessions');
    const retried = await request({ 'X-Forwarded-For': '192.0.2.3' });
    expect(retried.status).toBe(200);
    await retried.arrayBuffer();
  } finally {
    if (lockHeld) await held.query('ROLLBACK');
    held.release();
    await Promise.allSettled(pending);
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    storage.close();
    await db.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
}, 25000);
