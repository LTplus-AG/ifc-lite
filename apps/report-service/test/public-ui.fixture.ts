/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { S3Client, CreateBucketCommand, DeleteBucketCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { createHandler } from '../src/handler.js';
import { openDatabase, migrate } from '../src/database.js';
import type { Config } from '../src/config.js';
import type { ReportRow, UploadRow } from '../src/reports.js';
import { ModelStorage } from '../src/storage.js';
import { PublicModelStorage } from '../src/public-storage.js';
import { verifyNext } from '../src/verification.js';
import { claimPublicScan, finishPublicScan, approvePublicModel } from '../src/public-quarantine.js';
import { promotePublicModel, cleanupPublicCopies } from '../src/public-release.js';
import { deleteReport } from '../src/maintenance.js';

export const reporterFixtureSha = 'cc6fbbf632c2779891e485c3297d437b1d8555448934b8c8b5a3cce5326553a2';
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Actual HTTP transport with an explicit Node cookie/Origin bridge. This does
 * not qualify browser Secure/SameSite cookies, HTTPS, CORS or provider ingress. */
function httpBytes(url: URL, options: RequestInit): Promise<{ response: Response; setCookies: string[] }> {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(options.headers));
    const body = options.body;
    let bytes: Buffer | undefined;
    if (typeof body === 'string') bytes = Buffer.from(body);
    else if (body instanceof ArrayBuffer) bytes = Buffer.from(body);
    else if (body !== undefined && body !== null) { reject(new Error('Unsupported fixture request body')); return; }
    if (bytes) headers['content-length'] = String(bytes.length);
    const req = request(url, { method: options.method ?? 'GET', headers, signal: options.signal ?? undefined }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 512 * 1024) req.destroy(new Error('Fixture response limit'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const resultHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const entry of value) resultHeaders.append(name, entry);
          else if (value !== undefined) resultHeaders.set(name, value);
        }
        const status = res.statusCode ?? 500;
        // Browser Response correctly filters Set-Cookie. A Node-only cookie jar
        // must capture the actual wire metadata before constructing that Response.
        const setCookies = res.headers['set-cookie'] ?? [];
        const response = new Response(status === 204 ? null : new Uint8Array(Buffer.concat(chunks)).buffer, { status, headers: resultHeaders });
        resolve({ response, setCookies });
      });
    });
    req.setTimeout(20_000, () => req.destroy(new Error('Fixture HTTP deadline')));
    req.on('error', reject);
    req.end(bytes);
  });
}

/** Reuses H's actual production handler, schema, verifier and storage adapters.
 * Only review/scanner attestation/GitHub publication are controlled fixtures. */
export async function realPublicReportFixture() {
  assert.ok(process.env.REPORT_TEST_DATABASE_URL && process.env.REPORT_TEST_S3_ENDPOINT,
    'Mandatory mounted real-provider fixture environment');
  const bucket = `public-ui-${randomUUID()}`;
  const schema = `public_ui_${randomUUID().replace(/-/g, '')}`;
  const admin = openDatabase(process.env.REPORT_TEST_DATABASE_URL);
  const databaseUrl = new URL(process.env.REPORT_TEST_DATABASE_URL);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const image = `sha256:${'d'.repeat(64)}`;
  const config: Config = {
    submissionsEnabled: true, storageProvider: 'Local S3 fixture', storageLocation: 'Hosted qualification', backupDisclosure: 'No backups',
    origin: 'http://localhost', port: 3005, databaseUrl: databaseUrl.toString(), bucket,
    region: 'us-east-1', endpoint: process.env.REPORT_TEST_S3_ENDPOINT, forcePathStyle: true,
    accessKeyId: process.env.REPORT_TEST_S3_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.REPORT_TEST_S3_SECRET_ACCESS_KEY ?? '',
    admissionSecret: 'a'.repeat(32), adminToken: 'b'.repeat(32), githubAppId: '1', githubInstallationId: '1',
    githubPrivateKey: 'unused', githubRepository: 'owner/repo', maxDailyReports: 100, maxDailyBytes: 1024 ** 3, maxStorageBytes: 1024 ** 3,
    publicSharing: { scannerImageDigest: image, maxConcurrentDownloads: 2, maxDailyDownloadBytes: 1024 ** 3 },
    agreement: { version: 'unapproved', sha256: 'a'.repeat(64), text: 'DRAFT', issuer: 'LTplus AG', jurisdiction: 'Switzerland', signingEnabled: false },
  };
  const db = openDatabase(config.databaseUrl);
  const storage = new ModelStorage(config);
  const publicStorage = new PublicModelStorage(config);
  const s3 = new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  const active = new Set<Promise<void>>();
  const failures: unknown[] = [];
  const handler = createHandler(db, storage, config, publicStorage);
  const server = createServer((req, res) => {
    const pending = handler(req, res);
    active.add(pending);
    void pending.then(() => active.delete(pending), error => { failures.push(error); active.delete(pending); });
  });
  let schemaCreated = false;
  let bucketCreated = false;
  let migrated = false;
  const calls: { path: string; method: string; status: number; cookieSent: boolean; sessionCookieReceived: boolean }[] = [];
  let cookie = '';
  async function drain() { await Promise.all([...active]); assert.deepEqual(failures, []); }
  async function close() {
    const errors: unknown[] = [];
    async function attempt(action: () => Promise<unknown>) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    await attempt(drain);
    if (migrated) await attempt(async () => {
      const reports = await db.query<ReportRow>('SELECT * FROM model_reports');
      for (const report of reports.rows) await deleteReport(db, storage, report.id, report.session_id);
      await db.query('UPDATE report_public_copies SET lease_until=NULL,cleanup_after=now()');
      await cleanupPublicCopies(db, publicStorage);
    });
    // This randomly named bucket belongs only to this finite fixture. Preserve
    // cleanup even when an earlier assertion or handler/maintenance call fails.
    if (bucketCreated) await attempt(async () => {
      const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 100 }));
      assert.equal(objects.IsTruncated, false, 'Fixture must remain bounded below 100 objects');
      const keys = (objects.Contents ?? []).map(object => { assert.ok(object.Key); return { Key: object.Key }; });
      if (keys.length) {
        const deleted = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
        assert.equal(deleted.Errors?.length ?? 0, 0, 'All owned fixture objects erased');
      }
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    });
    if (server.listening) await attempt(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    publicStorage.close(); storage.close(); s3.destroy();
    await attempt(() => db.end());
    if (schemaCreated) await attempt(() => admin.query(`DROP SCHEMA ${schema} CASCADE`));
    await attempt(() => admin.end());
    if (errors.length) throw new AggregateError(errors, 'Owned public UI fixture cleanup failed');
  }
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true;
    await migrate(db); migrated = true;
    await s3.send(new CreateBucketCommand({ Bucket: bucket })); bucketCreated = true;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fixture startup and cleanup failed'); }
    throw error;
  }
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoint = new URL(config.endpoint!);
  const transport: typeof fetch = async (input, options = {}) => {
    assert.ok(typeof input === 'string' || input instanceof URL, 'Fixture transport accepts URLs');
    const target = new URL(String(input), config.origin);
    const api = target.origin === config.origin && target.pathname.startsWith('/api/reports/');
    assert.ok(api || target.origin === endpoint.origin, 'Only owned handler or owned S3 fixture');
    const headers = new Headers(options.headers);
    if (api) {
      headers.set('Origin', config.origin);
      if (cookie && options.credentials !== 'omit') headers.set('Cookie', cookie);
    } else assert.equal(options.credentials, 'omit', 'No report cookie may reach S3');
    const { response, setCookies } = await httpBytes(api ? new URL(target.pathname + target.search, base) : target, { ...options, headers });
    const setCookie = api ? setCookies.find(value => value.startsWith('__Host-ifclite_report=')) : undefined;
    if (api && setCookie && options.credentials !== 'omit') cookie = setCookie.split(';')[0]!;
    calls.push({ path: api ? target.pathname : 'owned-s3-part', method: options.method ?? 'GET', status: response.status,
      cookieSent: api && headers.has('Cookie'), sessionCookieReceived: Boolean(setCookie) });
    if (api && target.pathname.endsWith('/complete') && response.ok) {
      await drain();
      await verifyNext(db, storage); // Real worker tick, actual hash reread; response is untouched.
    }
    return response;
  };
  async function assertActiveSession() {
    assert.ok(/^__Host-ifclite_report=[a-f0-9]{64}$/.test(cookie), 'Actual wire session cookie captured');
    const token = cookie.slice(cookie.indexOf('=') + 1);
    const rows = await db.query<{ valid: boolean }>('SELECT expires_at>now() AS valid FROM report_sessions WHERE id=$1',
      [sha256(Buffer.from(token))]);
    assert.equal(rows.rowCount, 1, 'Wire cookie hashes to exactly one durable session');
    assert.equal(rows.rows[0]?.valid, true, 'Durable session is unexpired');
  }
  async function report() {
    const rows = await db.query<ReportRow>('SELECT * FROM model_reports');
    assert.equal(rows.rowCount, 1); return rows.rows[0]!;
  }
  async function upload() {
    const rows = await db.query<UploadRow>('SELECT * FROM report_uploads');
    assert.equal(rows.rowCount, 1); return rows.rows[0]!;
  }
  async function assertNoTransferredObjects() {
    const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    assert.equal(objects.Contents?.length ?? 0, 0, 'No model bytes before Send');
  }
  async function objectHash(key: string) {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    assert.ok(object.Body); return sha256(await object.Body.transformToByteArray());
  }
  async function controlledReviewAndPublication() {
    const row = await report();
    assert.equal(row.status, 'submitted');
    const lease = await claimPublicScan(db); assert.equal(lease?.reportId, row.id); assert.ok(lease);
    // Explicit synthetic trusted-worker attestation: no malware scanner qualification.
    await finishPublicScan(db, lease, { outcome: 'clean', format: 'ifc-step', complete: true,
      sha256: lease.sha256, byteSize: lease.byteSize, policyVersion: lease.policyVersion, imageDigest: image,
      engineVersion: '1.4.2', signatureVersion: '12345', signaturesAt: new Date(Date.now() - 3600000).toISOString(),
      finishedAt: new Date().toISOString() }, image);
    await approvePublicModel(db, row.id, lease.sha256, image, { redistribution: true, confidentialContent: true });
    // Explicit publication fixture: no GitHub App call or public write.
    await db.query("UPDATE model_reports SET status='published',issue_url='https://github.com/LTplus-AG/ifc-lite/issues/7495' WHERE id=$1", [row.id]);
    await promotePublicModel(db, publicStorage, config);
  }
  async function copy() {
    const rows = await db.query<{ object_key: string; state: string; reserved_bytes: string }>('SELECT * FROM report_public_copies');
    assert.equal(rows.rowCount, 1); return rows.rows[0]!;
  }
  async function cleanupCopy() {
    await drain();
    await cleanupPublicCopies(db, publicStorage);
    const row = await copy();
    assert.equal(row.reserved_bytes, '0');
    await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: bucket, Key: row.object_key })),
      (error: unknown) => error instanceof Error && ['NotFound', 'NoSuchKey'].includes(error.name));
  }
  return { transport, calls, db, assertActiveSession, report, upload, copy, objectHash, assertNoTransferredObjects, controlledReviewAndPublication, cleanupCopy, drain, close };
}
