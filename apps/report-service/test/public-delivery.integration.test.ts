/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { createHandler } from "../src/handler.js";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreateBucketCommand, DeleteBucketCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { openDatabase, migrate } from "../src/database.js";
import { createReport, submitReport } from "../src/reports.js";
import { ModelStorage } from "../src/storage.js";
import { authorizePart, startUpload, uploadRow } from "../src/uploads.js";
import { completeUpload, verifyNext } from "../src/verification.js";
import { deleteReport } from "../src/maintenance.js";
import type { Config } from "../src/config.js";
import type { PublicSharingConsent } from "@ifc-lite/report-contract";
import type { ScanEvidence, ScanLease } from "../src/public-quarantine.js";
import { loadFeature } from "./feature-loader.js";

const enabled = Boolean(process.env.REPORT_TEST_DATABASE_URL && process.env.REPORT_TEST_S3_ENDPOINT);
if (process.env.REPORT_REQUIRE_INTEGRATION === "true" && !enabled)
  throw new Error("Mandatory real report integration environment is missing");
// These cases prove quarantine authorization and lifecycle with real storage bytes.
// Synthetic trusted-worker attestations do NOT qualify the future malware scanner.
describe.skipIf(!enabled)("#7495 public delivery requires approved immutable bytes and owner withdrawal", () => {
  const owner = { id: randomUUID(), csrf: "fixture", admission: randomUUID() };
  const bucket = `public-delivery-${randomUUID()}`;
  const schema = "public_delivery_" + randomUUID().replace(/-/g, "");
  const admin = openDatabase(process.env.REPORT_TEST_DATABASE_URL ?? "");
  const databaseUrl = new URL(process.env.REPORT_TEST_DATABASE_URL ?? "postgres://localhost/unused");
  databaseUrl.searchParams.set("options", `-c search_path=${schema}`);
  const config: Config = {
    submissionsEnabled: true, storageProvider: "Local S3 fixture", storageLocation: "Development host", backupDisclosure: "No backups",
    origin: "https://viewer.example.com", port: 3005, databaseUrl: databaseUrl.toString(), bucket,
    region: "us-east-1", endpoint: process.env.REPORT_TEST_S3_ENDPOINT, forcePathStyle: true,
    accessKeyId: process.env.REPORT_TEST_S3_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.REPORT_TEST_S3_SECRET_ACCESS_KEY ?? "",
    admissionSecret: "a".repeat(32), adminToken: "b".repeat(32), githubAppId: "1", githubInstallationId: "1",
    githubPrivateKey: "unused", githubRepository: "owner/repo", maxDailyReports: 100, maxDailyBytes: 1024 ** 3, maxStorageBytes: 1024 ** 3,
    publicSharing: { scannerImageDigest: `sha256:${"d".repeat(64)}`, maxConcurrentDownloads: 2, maxDailyDownloadBytes: 1024 ** 3 },
    agreement: { version: "unapproved", sha256: "a".repeat(64), text: "DRAFT", issuer: "LTplus AG", jurisdiction: "Switzerland", signingEnabled: false },
  };
  const db = openDatabase(config.databaseUrl);
  const storage = new ModelStorage(config);
  const s3 = new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  let feature: typeof import("../src/public-quarantine.js") | undefined;
  let release: typeof import("../src/public-release.js") | undefined;
  let publicStorage: InstanceType<typeof import("../src/public-storage.js").PublicModelStorage>;
  const activeRequests = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const request = createHandler(db, storage, config, publicStorage)(req, res);
    activeRequests.add(request);
    void request.finally(() => activeRequests.delete(request));
  });
  let base = "";
  let initialized = false;
  const reports: string[] = [];
  const consent: PublicSharingConsent = { version: "public-model-v1", authorityConfirmed: true, redistributionReviewed: true,
    confidentialContentReviewed: true, downloadedCopiesCannotBeRecalled: true, publishDownloadLink: true };
  const image = `sha256:${"d".repeat(64)}`;
  beforeAll(async () => {
    feature = await loadFeature("../src/public-quarantine.js", () => import("../src/public-quarantine.js"));
    release = await loadFeature("../src/public-release.js", () => import("../src/public-release.js"));
    const adapter = await loadFeature("../src/public-storage.js", () => import("../src/public-storage.js"));
    if (!feature || !release || !adapter) return;
    publicStorage = new adapter.PublicModelStorage(config);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(db);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    initialized = true;
  });
  afterAll(async () => {
    if (initialized) {
      for (const id of reports) await deleteReport(db, storage, id, owner.id);
      await db.query("UPDATE report_public_copies SET lease_until=NULL,cleanup_after=now()");
      await release!.cleanupPublicCopies(db, publicStorage);
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      publicStorage.close();
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
    storage.close();
    s3.destroy();
    await db.end();
    if (initialized) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  function api() {
    expect(release, "Immutable release must exist").toBeDefined();
    expect(feature, "Public quarantine must exist and enforce the release invariant").toBeDefined();
    return feature!;
  }
  async function draft(visibility: "private" | "public" = "public") {
    const r = await createReport(db, config, owner, { clientRequestId: randomUUID(), title: "Reviewed fixture", description: "Synthetic acceptance",
      diagnostics: { errorCode: "fixture", appVersion: "test", buildSha: "test" }, visibility });
    reports.push(r.id);
    return r.id;
  }
  async function uploaded(id: string, publicConsent = true) {
    const bytes = Buffer.from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n");
    const input = { name: "sensitive-project-name.ifc", size: bytes.length, type: "application/octet-stream" as const,
      confidentiality: "none" as const, uploadConsent: true as const,
      ...(publicConsent ? { publicModelConfirmed: true, publicSharingConsent: consent } : {}) };
    const upload = await startUpload(db, storage, config, id, owner, input);
    const checksum = createHash("sha256").update(bytes).digest("base64");
    const part = await authorizePart(db, storage, await uploadRow(db, id, upload.id, owner), 1, checksum);
    const response = await fetch(part.url, { method: "PUT", headers: { "x-amz-checksum-sha256": checksum }, body: bytes });
    expect(response.status).toBe(200);
    await completeUpload(db, storage, await uploadRow(db, id, upload.id, owner), owner);
    await verifyNext(db, storage);
    expect((await uploadRow(db, id, upload.id, owner)).object_checksum).toBe(createHash("sha256").update(bytes).digest("hex"));
    return upload;
  }
  async function queue() {
    const id = await draft();
    await uploaded(id);
    await submitReport(db, id, owner, true);
    return id;
  }
  async function state(id: string) {
    return (await db.query("SELECT * FROM report_public_quarantine WHERE report_id=$1", [id])).rows[0];
  }
  function clean(lease: ScanLease): ScanEvidence {
    return { outcome: "clean", format: "ifc-step", complete: true, sha256: lease.sha256, byteSize: lease.byteSize, policyVersion: lease.policyVersion,
      imageDigest: image, engineVersion: "1.4.2", signatureVersion: "12345",
      signaturesAt: new Date(Date.now() - 3600000).toISOString(), finishedAt: new Date().toISOString() };
  }
  async function claim(id: string) {
    const lease = await api().claimPublicScan(db);
    expect(lease?.reportId).toBe(id);
    return lease!;
  }
  async function approved() {
    api();
    const id = await queue();
    const lease = await claim(id);
    await api().finishPublicScan(db, lease, clean(lease), image);
    await api().approvePublicModel(db, id, lease.sha256, image, { redistribution: true, confidentialContent: true });
    // Publication fixture: no GitHub request is made by this storage qualification.
    await db.query("UPDATE model_reports SET status='published' WHERE id=$1", [id]);
    return id;
  }
  async function copyRow(id: string) {
    return (await db.query("SELECT * FROM report_public_copies WHERE report_id=$1", [id])).rows[0];
  }
  async function url(id: string) {
    const receipt = await release!.publicModelReceipt(db, config, id);
    expect(receipt?.state).toBe("available");
    return base + new URL(receipt!.downloadUrl!).pathname;
  }
  it("serves exact approved bytes anonymously without private identifiers, and withdrawal revokes fresh requests", async () => {
    const id = await approved();
    await release!.promotePublicModel(db, publicStorage, config);
    const row = await copyRow(id);
    expect(row.token).toMatch(/^[a-f0-9]{64}$/);
    expect(row.object_key).not.toContain(row.token);
    const download = await url(id);
    expect(download).not.toContain(id);
    const response = await fetch(download);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="model.ifc"');
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.sha256);
    await Promise.all([...activeRequests]); // HTTP body completion precedes async server cleanup.
    expect((await db.query("SELECT count(*) n FROM report_public_download_leases")).rows[0].n).toBe("0");
    await expect(release!.withdrawPublicModel(db, id, "different-owner")).rejects.toThrow(/not found/i);
    await release!.withdrawPublicModel(db, id, owner.id);
    expect((await fetch(download)).status).toBe(404);
    expect((await copyRow(id)).reserved_bytes).toBe(String(bytes.length));
    await release!.cleanupPublicCopies(db, publicStorage);
    expect((await copyRow(id)).reserved_bytes).toBe("0");
    expect((await uploadRow(db, id, (await state(id)).upload_id, owner)).status).toBe("ready");
  });
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  function pauseBeforeOpen(download: string) {
    const entered = deferred(); const resume = deferred();
    const original = publicStorage.open.bind(publicStorage);
    publicStorage.open = async (...args) => { entered.resolve(); await resume.promise; return original(...args); };
    const abort = new AbortController();
    const response = fetch(download, { signal: abort.signal }).then(async result => ({
      status: result.status, bytes: Buffer.from(await result.arrayBuffer()),
    }));
    return {
      admitted: Promise.race([entered.promise, response.then(() => { throw new Error("Request ended before provider-open barrier"); })]),
      response, resume: resume.resolve, abort: () => abort.abort(),
      close: async () => {
        resume.resolve();
        await Promise.allSettled([response]);
        await Promise.all([...activeRequests]);
        publicStorage.open = original;
      },
    };
  }
  async function objectExists(key: string): Promise<boolean> {
    try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
    catch (error) {
      if (error && typeof error === "object" && "$metadata" in error &&
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
      throw error;
    }
  }
  it("#7512 admitted-before-open transfer survives withdrawal and cleanup, then releases only its copy", async () => {
    const id = await approved(); await release!.promotePublicModel(db, publicStorage, config);
    const before = await copyRow(id); const download = await url(id);
    const other = await approved(); await release!.promotePublicModel(db, publicStorage, config);
    const otherCopy = await copyRow(other);
    const paused = pauseBeforeOpen(download);
    try {
      await paused.admitted;
      const pin = (await db.query("SELECT * FROM report_public_download_leases")).rows[0];
      expect(pin).toMatchObject({ report_id: id, object_key: before.object_key });
      expect(pin.expires_at.getTime()).toBeGreaterThan(Date.now());
      await release!.withdrawPublicModel(db, id, owner.id);
      await release!.withdrawPublicModel(db, other, owner.id);
      expect((await fetch(download)).status).toBe(404);
      await release!.cleanupPublicCopies(db, publicStorage);
      expect(await objectExists(before.object_key)).toBe(true);
      expect((await copyRow(id)).reserved_bytes).toBe(before.reserved_bytes);
      expect((await copyRow(other)).reserved_bytes).toBe("0");
      expect(await objectExists(otherCopy.object_key)).toBe(false);
      paused.resume();
      const result = await paused.response;
      expect(result.status).toBe(200);
      expect(createHash("sha256").update(result.bytes).digest("hex")).toBe(before.sha256);
      await Promise.all([...activeRequests]);
      expect((await db.query("SELECT count(*) n FROM report_public_download_leases")).rows[0].n).toBe("0");
      await release!.cleanupPublicCopies(db, publicStorage);
      expect((await copyRow(id)).reserved_bytes).toBe("0");
      expect(await objectExists(before.object_key)).toBe(false);
    } finally { await paused.close(); }
  }, 20000);
  it("#7512 disconnect removes the scoped pin and an orphan pin defers cleanup only until fixture expiry", async () => {
    const id = await approved(); await release!.promotePublicModel(db, publicStorage, config);
    const before = await copyRow(id); const paused = pauseBeforeOpen(await url(id));
    try {
      await paused.admitted;
      const pin = (await db.query("SELECT * FROM report_public_download_leases")).rows[0];
      expect(pin).toMatchObject({ report_id: id, object_key: before.object_key });
      paused.abort(); paused.resume(); await paused.close();
      expect((await db.query("SELECT count(*) n FROM report_public_download_leases")).rows[0].n).toBe("0");
      // Reproduce a persisted pin left by process death; no live stream remains.
      // Only this owned fixture deadline is advanced, never a production lease.
      await db.query("INSERT INTO report_public_download_leases(id,expires_at,report_id,object_key) VALUES($1,now()+interval '16 minutes',$2,$3)",
        [pin.id, id, before.object_key]);
      await release!.withdrawPublicModel(db, id, owner.id);
      await release!.cleanupPublicCopies(db, publicStorage);
      expect(await objectExists(before.object_key)).toBe(true);
      expect((await copyRow(id)).reserved_bytes).toBe(before.reserved_bytes);
      await db.query("UPDATE report_public_download_leases SET expires_at=now()-interval '1 second' WHERE id=$1", [pin.id]);
      await release!.cleanupPublicCopies(db, publicStorage);
      expect((await copyRow(id)).reserved_bytes).toBe("0");
      expect(await objectExists(before.object_key)).toBe(false);
    } finally { await paused.close(); }
  }, 20000);
  it("#7512 additive migration preserves unscoped active leases and cleanup holds them until expiry", async () => {
    const legacySchema = `public_legacy_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${legacySchema}`);
    const legacyUrl = new URL(config.databaseUrl); legacyUrl.searchParams.set("options", `-c search_path=${legacySchema}`);
    const legacy = openDatabase(legacyUrl.toString());
    const legacyId = randomUUID(); const expiry = new Date(Date.now() + 16 * 60 * 1000);
    try {
      await legacy.query("CREATE TABLE report_public_download_leases(id uuid PRIMARY KEY,expires_at timestamptz NOT NULL)");
      await legacy.query("INSERT INTO report_public_download_leases VALUES($1,$2)", [legacyId, expiry]);
      await migrate(legacy);
      const preserved = (await legacy.query("SELECT * FROM report_public_download_leases WHERE id=$1", [legacyId])).rows[0];
      expect(preserved).toMatchObject({ id: legacyId, report_id: null, object_key: null });
      expect(preserved.expires_at.toISOString()).toBe(expiry.toISOString());
    } finally { await legacy.end(); await admin.query(`DROP SCHEMA ${legacySchema} CASCADE`); }
    const id = await approved(); await release!.promotePublicModel(db, publicStorage, config);
    const copy = await copyRow(id);
    // Preserve the old caller's unknown scope, never assign it a guessed model.
    await db.query("INSERT INTO report_public_download_leases(id,expires_at) VALUES($1,$2)", [legacyId, expiry]);
    try {
      await release!.withdrawPublicModel(db, id, owner.id);
      await release!.cleanupPublicCopies(db, publicStorage);
      expect(await objectExists(copy.object_key)).toBe(true);
      expect((await copyRow(id)).reserved_bytes).toBe(copy.reserved_bytes);
      expect((await db.query("SELECT id FROM report_public_download_leases WHERE id=$1", [legacyId])).rowCount).toBe(1);
      await db.query("UPDATE report_public_download_leases SET expires_at=now()-interval '1 second' WHERE id=$1", [legacyId]);
      await release!.cleanupPublicCopies(db, publicStorage);
      expect(await objectExists(copy.object_key)).toBe(false);
      expect((await copyRow(id)).reserved_bytes).toBe("0");
    } finally { await db.query("DELETE FROM report_public_download_leases WHERE id=$1", [legacyId]); }
  }, 20000);
  it.each([false, true])("#7512 expired copy tombstone cannot re-promote, cleanup-first=%s", async cleanupFirst => {
    const id = await approved(); await release!.promotePublicModel(db, publicStorage, config);
    const before = await copyRow(id);
    await db.query("UPDATE report_public_copies SET expires_at=now()-interval '1 second' WHERE report_id=$1", [id]);
    if (cleanupFirst) await release!.cleanupPublicCopies(db, publicStorage);
    expect((await state(id)).state).toBe("approved");
    expect(await release!.publicModelReceipt(db, config, id)).toEqual({ state: "withdrawn" });
    await release!.promotePublicModel(db, publicStorage, config);
    const after = await copyRow(id);
    expect(after.token).toBe(before.token);
    expect(after.state).toBe(cleanupFirst ? "revoked" : "available");
    expect(after.reserved_bytes).toBe(cleanupFirst ? "0" : before.reserved_bytes);
    if (!cleanupFirst) await release!.cleanupPublicCopies(db, publicStorage);
  });
  it.each(["9007199254740991", "9007199254740992", "9007199254740993"])(
    "#7512 real bigint daily budget %s cannot pass the safe-integer download ceiling", async bytes => {
      const id = await approved(); await release!.promotePublicModel(db, publicStorage, config);
      const download = await url(id); const limits = config.publicSharing!; const previous = limits.maxDailyDownloadBytes;
      try {
        limits.maxDailyDownloadBytes = Number.MAX_SAFE_INTEGER;
        await db.query("INSERT INTO report_public_download_budget(day,bytes) VALUES(CURRENT_DATE,$1) ON CONFLICT(day) DO UPDATE SET bytes=excluded.bytes", [bytes]);
        const response = await fetch(download);
        expect(response.status).toBe(429);
        expect(await response.json()).toMatchObject({ error: "public_download_allowance" });
        expect((await db.query("SELECT bytes FROM report_public_download_budget WHERE day=CURRENT_DATE")).rows[0].bytes).toBe(bytes);
      } finally {
        limits.maxDailyDownloadBytes = previous;
        await db.query("UPDATE report_public_download_budget SET bytes=0 WHERE day=CURRENT_DATE");
        await release!.withdrawPublicModel(db, id, owner.id);
        await release!.cleanupPublicCopies(db, publicStorage);
      }
    },
  );
  it("daily byte and active-transfer limits apply across HTTP requests and capability disable closes delivery", async () => {
    const id = await approved();
    await release!.promotePublicModel(db, publicStorage, config);
    const download = await url(id);
    await db.query("UPDATE report_public_download_budget SET bytes=$1 WHERE day=CURRENT_DATE", [config.publicSharing!.maxDailyDownloadBytes]);
    expect((await fetch(download)).status).toBe(429);
    await db.query("UPDATE report_public_download_budget SET bytes=0 WHERE day=CURRENT_DATE");
    await db.query("INSERT INTO report_public_download_leases(id,expires_at) VALUES($1,now()+interval '1 hour'),($2,now()+interval '1 hour')", [randomUUID(), randomUUID()]);
    expect((await fetch(download)).status).toBe(429);
    await db.query("DELETE FROM report_public_download_leases");
    const enabled = config.publicSharing;
    config.publicSharing = undefined;
    try { expect((await fetch(download)).status).toBe(404); } finally { config.publicSharing = enabled; }
    expect((await fetch(download, { headers: { Range: "bytes=0-1" } })).status).toBe(416);
    await release!.withdrawPublicModel(db, id, owner.id);
    await release!.cleanupPublicCopies(db, publicStorage);
  });
  it("withdrawal while a real immutable copy finishes prevents publication and preserves cleanup reservation", async () => {
    const id = await approved();
    const original = publicStorage.copy.bind(publicStorage);
    publicStorage.copy = async (...args) => {
      const result = await original(...args);
      await release!.withdrawPublicModel(db, id, owner.id);
      return result;
    };
    try { await release!.promotePublicModel(db, publicStorage, config); }
    finally { publicStorage.copy = original; }
    const row = await copyRow(id);
    expect(row.state).toBe("revoked");
    expect(row.reserved_bytes).not.toBe("0");
    expect((await fetch(`${base}/api/reports/public/${row.token}`)).status).toBe(404);
    await release!.cleanupPublicCopies(db, publicStorage);
    expect((await copyRow(id)).reserved_bytes).toBe(row.reserved_bytes);
    await db.query("UPDATE report_public_copies SET lease_until=now()-interval '1 second',cleanup_after=now() WHERE report_id=$1", [id]);
    await release!.cleanupPublicCopies(db, publicStorage);
    expect((await copyRow(id)).reserved_bytes).toBe("0");
  });
  it("HTTP withdrawal requires owner CSRF, still works with submissions paused, and failed cleanup retains quota", async () => {
    const id = await approved();
    await release!.promotePublicModel(db, publicStorage, config);
    const download = await url(id);
    const sessionResponse = await fetch(`${base}/api/reports/session`);
    const cookie = sessionResponse.headers.get("set-cookie")!.split(";")[0]!;
    const session = await sessionResponse.json() as { csrfToken: string };
    const sessionId = createHash("sha256").update(cookie.split("=")[1]!).digest("hex");
    const headers = { cookie, origin: config.origin, "x-csrf-token": session.csrfToken };
    const path = `${base}/api/reports/${id}/public-model`;
    expect((await fetch(path, { method: "DELETE", headers })).status).toBe(404);
    await db.query("UPDATE model_reports SET session_id=$2 WHERE id=$1", [id, sessionId]);
    try {
      expect((await fetch(path, { method: "DELETE", headers: { cookie, origin: config.origin } })).status).toBe(403);
      config.submissionsEnabled = false;
      const response = await fetch(path, { method: "DELETE", headers });
      expect(response.status).toBe(200);
      expect((await response.json() as { publicModel: { state: string } }).publicModel.state).toBe("withdrawn");
      expect((await fetch(download)).status).toBe(404);
    } finally {
      config.submissionsEnabled = true;
      await db.query("UPDATE model_reports SET session_id=$2 WHERE id=$1", [id, owner.id]);
    }
    const adapter = await import("../src/public-storage.js");
    const unavailable = new adapter.PublicModelStorage({ ...config, accessKeyId: "invalid-access", secretAccessKey: "invalid-secret" });
    try { await release!.cleanupPublicCopies(db, unavailable); } finally { unavailable.close(); }
    const deferred = await copyRow(id);
    expect(deferred.reserved_bytes).not.toBe("0");
    expect(deferred.cleanup_attempts).toBe(1);
    expect(deferred.cleanup_after.getTime()).toBeGreaterThan(Date.now());
    await release!.withdrawPublicModel(db, id, owner.id);
    expect((await copyRow(id)).cleanup_after.getTime()).toBe(deferred.cleanup_after.getTime());
    await db.query("UPDATE report_public_copies SET cleanup_after=now() WHERE report_id=$1", [id]);
    await release!.cleanupPublicCopies(db, publicStorage);
    expect((await copyRow(id)).reserved_bytes).toBe("0");
  });
  async function waitingFor(lock: string, expected: number) {
    const deadline = Date.now() + 3000;
    let count = 0;
    do {
      count = Number((await db.query("SELECT count(*) n FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE $1", [`%${lock}%`])).rows[0].n);
      if (count === expected) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    expect(count, "The real database operation must reach its controlled lock boundary").toBe(expected);
  }
  it("private upload and public copy serialize their combined capacity reservation", async () => {
    const id = await approved();
    const privateId = await draft("private");
    const size = Number((await state(id)).byte_size);
    const used = Number((await db.query(`SELECT (SELECT COALESCE(sum(reserved_bytes),0) FROM report_uploads WHERE status!='aborted')+
      (SELECT COALESCE(sum(reserved_bytes),0) FROM report_public_copies) AS bytes`)).rows[0].bytes);
    const limit = config.maxStorageBytes;
    config.maxStorageBytes = used + size; // Exactly one more object fits, not both.
    const held = await db.connect();
    await held.query("BEGIN");
    await db.query(`CREATE FUNCTION pause_public_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('fixture-public-insert')); RETURN NEW; END $$;
      CREATE TRIGGER pause_public_insert BEFORE INSERT ON report_public_copies FOR EACH ROW EXECUTE FUNCTION pause_public_insert()`);
    await held.query("SELECT pg_advisory_xact_lock(hashtext('fixture-public-insert'))");
    const promotion = release!.promotePublicModel(db, publicStorage, config);
    let results: Promise<unknown> = promotion;
    try {
      // Hold the actual insert AFTER its quota read. A separate admission lock
      // would allow the private upload to spend the same still-uncommitted room.
      await waitingFor('INSERT INTO report_public_copies', 1);
      let settled = false;
      const upload = startUpload(db, storage, config, privateId, owner, { name: 'private.ifc', size, type: 'application/octet-stream', confidentiality: 'none', uploadConsent: true });
      results = Promise.allSettled([upload, promotion]);
      void upload.then(() => { settled = true; }, () => { settled = true; });
      const deadline = Date.now() + 3000;
      while (!settled && Date.now() < deadline) {
        const waiting = Number((await db.query("SELECT count(*) n FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%report-upload-capacity%'")).rows[0].n);
        if (waiting > 0) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally {
      await held.query("COMMIT"); held.release(); await results; config.maxStorageBytes = limit;
      await db.query("DROP TRIGGER pause_public_insert ON report_public_copies; DROP FUNCTION pause_public_insert()");
    }
    const reserved = Number((await db.query(`SELECT (SELECT COALESCE(sum(reserved_bytes),0) FROM report_uploads WHERE status!='aborted')+
      (SELECT COALESCE(sum(reserved_bytes),0) FROM report_public_copies) AS bytes`)).rows[0].bytes);
    expect(reserved).toBe(used + size);
    await deleteReport(db, storage, privateId, owner.id);
    await deleteReport(db, storage, id, owner.id);
    await release!.cleanupPublicCopies(db, publicStorage);
  });
  it("disconnect while admission waits never opens the object and promptly releases the transfer lease", async () => {
    const id = await approved();
    await release!.promotePublicModel(db, publicStorage, config);
    const download = await url(id);
    const held = await db.connect();
    await held.query("BEGIN");
    await held.query("SELECT pg_advisory_xact_lock(hashtext('report-public-bandwidth'))");
    let reads = 0;
    const original = publicStorage.open.bind(publicStorage);
    publicStorage.open = async (...args) => { reads++; return original(...args); };
    await db.query("UPDATE report_public_download_budget SET bytes=0 WHERE day=CURRENT_DATE");
    const request = get(download);
    const disconnected = new Promise<void>(resolve => request.once('error', error => {
      expect((error as NodeJS.ErrnoException).code).toBe('ECONNRESET'); resolve();
    }));
    try {
      await waitingFor('report-public-bandwidth', 1);
      request.destroy(); await disconnected;
      await held.query("COMMIT");
      await Promise.all([...activeRequests]);
      expect(reads).toBe(0);
      expect((await db.query("SELECT count(*) n FROM report_public_download_leases")).rows[0].n).toBe('0');
    } finally { request.destroy(); await held.query("ROLLBACK"); held.release(); publicStorage.open = original; }
    await release!.withdrawPublicModel(db, id, owner.id);
    await release!.cleanupPublicCopies(db, publicStorage);
  });
  it("expired signature evidence cannot promote and copy capacity counts original plus immutable copy", async () => {
    const stale = await approved();
    await db.query("UPDATE report_public_quarantine SET scan=jsonb_set(scan,'{signaturesAt}',to_jsonb((now()-interval '25 hours')::text)) WHERE report_id=$1", [stale]);
    await release!.promotePublicModel(db, publicStorage, config);
    expect(await copyRow(stale)).toBeUndefined();
    expect((await state(stale)).state).toBe("blocked");
    const id = await approved();
    const limit = config.maxStorageBytes;
    config.maxStorageBytes = 1;
    try { await release!.promotePublicModel(db, publicStorage, config); } finally { config.maxStorageBytes = limit; }
    expect(await copyRow(id)).toBeUndefined();
    expect((await state(id)).state).toBe("approved");
    await db.query("UPDATE report_public_quarantine SET promotion_after=now() WHERE report_id=$1", [id]);
    await release!.promotePublicModel(db, publicStorage, config);
    expect((await copyRow(id)).state).toBe("available");
    await deleteReport(db, storage, id, owner.id);
    expect((await copyRow(id)).state).toBe("revoked");
    await release!.cleanupPublicCopies(db, publicStorage);
  });
});
