/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { openDatabase, migrate } from "../src/database.js";
import { ModelStorage } from "../src/storage.js";
import { deleteReport, sweep } from "../src/maintenance.js";
import { withdrawPublicModel } from "../src/public-release.js";
import { createHandler } from "../src/handler.js";
import type { Config } from "../src/config.js";
import { loadFeature } from "./feature-loader.js";
const enabled = Boolean(process.env.REPORT_TEST_DATABASE_URL && process.env.REPORT_TEST_S3_ENDPOINT);
if (process.env.REPORT_REQUIRE_INTEGRATION === "true" && !enabled) throw new Error("Mandatory restore integration environment missing");
describe.skipIf(!enabled)("#7495 independent journal and conservative restore hold", () => {
  const bucket = `restore-${randomUUID()}`;
  const schema = `restore_${randomUUID().replaceAll("-", "")}`;
  const dbUrl = new URL(process.env.REPORT_TEST_DATABASE_URL ?? "postgres://localhost/unused");
  dbUrl.searchParams.set("options", `-c search_path=${schema}`);
  const config: Config = { submissionsEnabled: true, origin: "https://viewer.example.com", port: 0,
    databaseUrl: dbUrl.toString(), bucket, region: "us-east-1", endpoint: process.env.REPORT_TEST_S3_ENDPOINT,
    forcePathStyle: true, accessKeyId: process.env.REPORT_TEST_S3_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.REPORT_TEST_S3_SECRET_ACCESS_KEY ?? "",
    storageProvider: "RustFS fixture", storageLocation: "Local", backupDisclosure: "No backups",
    admissionSecret: "a".repeat(32), adminToken: "b".repeat(32), githubAppId: "1", githubInstallationId: "1", githubPrivateKey: "unused", githubRepository: "owner/repo",
    maxDailyReports: 100, maxDailyBytes: 1024 ** 3, maxStorageBytes: 1024 ** 3,
    agreement: { text: "Unapproved", version: "draft", sha256: "a".repeat(64), issuer: "LTplus AG", jurisdiction: "Switzerland", signingEnabled: false } };
  const db = openDatabase(config.databaseUrl);
  const admin = openDatabase(process.env.REPORT_TEST_DATABASE_URL ?? "");
  const s3 = new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: true, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  const storage = new ModelStorage(config);
  let feature: typeof import("../src/restore-journal.js") | undefined;
  let recovery: typeof import("../src/restore-recovery.js") | undefined;
  const journals: Array<InstanceType<NonNullable<typeof feature>["RestoreJournal"]>> = [];
  let initialized = false;
  beforeAll(async () => {
    feature = await loadFeature("../src/restore-journal.js", () => import("../src/restore-journal.js"));
    recovery = await loadFeature("../src/restore-recovery.js", () => import("../src/restore-recovery.js"));
    if (!feature || !recovery) return;
    await admin.query(`CREATE SCHEMA ${schema}`); await migrate(db);
    await s3.send(new CreateBucketCommand({ Bucket: bucket })); initialized = true;
  });
  afterAll(async () => {
    for (const journal of journals) journal.close();
    if (initialized) {
      let token: string | undefined;
      do {
        const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
        for (const object of list.Contents ?? []) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
        token = list.NextContinuationToken;
      } while (token);
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
    storage.close(); s3.destroy(); await db.end();
    if (initialized) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  function journal() {
    expect(feature, "real journal API must exist").toBeDefined();
    const epoch = randomBytes(32).toString("hex");
    const value = new feature!.RestoreJournal(config, epoch, "k".repeat(32)); journals.push(value);
    return { value, epoch };
  }
  async function report(owner: string) {
    const id = randomUUID();
    await db.query("INSERT INTO model_reports(id,session_id,client_key,draft,fingerprint,agreement) VALUES($1,$2,$3,$4,$5,$6)",
      [id, owner, randomUUID(), { title: "private synthetic", description: "must be erased" }, randomUUID(), { signerName: "Synthetic" }]);
    return id;
  }
  it("verifies authenticated independent chain and rejects old witness, corruption and missing head", async () => {
    const { value, epoch } = journal();
    await expect(value.checkpoint()).rejects.toThrow();
    const initial = await value.initialize();
    const id = randomUUID(); const head = await value.append(id, "delete");
    expect((await value.verify(head)).map(entry => [entry.reportId, entry.action])).toEqual([[id, "delete"]]);
    await expect(value.verify(initial)).rejects.toThrow("witness");
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `operations/restore/${epoch}/entries/${head.hash}`, Body: '{}' }));
    await expect(value.verify(head)).rejects.toThrow();
  });
  it("concurrent conditional heads never acknowledge a lost intent", async () => {
    const { value } = journal(); await value.initialize();
    const results = await Promise.allSettled([value.append(randomUUID(), "delete"), value.append(randomUUID(), "withdraw")]);
    const entries = await value.verify(await value.checkpoint());
    expect(entries).toHaveLength(results.filter(result => result.status === "fulfilled").length);
    expect(entries.length).toBeGreaterThan(0);
  });
  it("authenticates owner before journaling and refuses effective deletion on unavailable independent storage", async () => {
    const { value } = journal(); const initial = await value.initialize();
    const owner = randomUUID(); const id = await report(owner);
    await deleteReport(db, storage, id, randomUUID(), value);
    expect(await value.checkpoint()).toEqual(initial);
    const missing = journal().value;
    await expect(deleteReport(db, storage, id, owner, missing)).rejects.toThrow();
    expect((await db.query("SELECT status,agreement FROM model_reports WHERE id=$1", [id])).rows[0]).toMatchObject({ status: "draft", agreement: { signerName: "Synthetic" } });
    await deleteReport(db, storage, id, owner, value);
    await deleteReport(db, storage, id, owner, value);
    expect((await value.verify(await value.checkpoint())).map(entry => entry.action)).toEqual(["delete"]);
  });
  it("persists withdrawal before changing its restored authorization", async () => {
    const { value } = journal(); await value.initialize(); const owner = randomUUID(); const id = await report(owner);
    await expect(withdrawPublicModel(db, id, randomUUID(), value)).rejects.toThrow();
    await withdrawPublicModel(db, id, owner, value);
    await withdrawPublicModel(db, id, owner, value);
    expect((await value.verify(await value.checkpoint())).map(entry => [entry.reportId, entry.action])).toEqual([[id, "withdraw"]]);
  });
  it("background expiry journals before erasing expired confidential fields", async () => {
    const { value } = journal(); const owner = randomUUID(); const id = await report(owner);
    await db.query("UPDATE model_reports SET expires_at=now()-interval '1 minute' WHERE id=$1", [id]);
    await expect(sweep(db, storage, value)).rejects.toThrow();
    expect((await db.query("SELECT agreement FROM model_reports WHERE id=$1", [id])).rows[0].agreement).toEqual({ signerName: "Synthetic" });
    await value.initialize(); await sweep(db, storage, value);
    expect((await value.verify(await value.checkpoint())).map(entry => [entry.reportId, entry.action])).toEqual([[id, "delete"]]);
    expect((await db.query("SELECT status,agreement FROM model_reports WHERE id=$1", [id])).rows[0]).toEqual({ status: "deleted", agreement: null });
  });
  it("replays deletion after simulated rollback, invalidates owner/outbox grants and stays held over real HTTP", async () => {
    const { value } = journal(); await value.initialize(); expect(recovery).toBeDefined();
    const owner = randomUUID(); const id = await report(owner);
    await deleteReport(db, storage, id, owner, value);
    const checkpoint = await value.checkpoint();
    // Actual SQL rollback simulation restores the pre-deletion confidential fields.
    await db.query("UPDATE model_reports SET status='submitted',draft=$2,agreement=$3 WHERE id=$1", [id, { description: "resurrected" }, { signerName: "Synthetic" }]);
    await db.query("INSERT INTO report_outbox(report_id) VALUES($1)", [id]);
    await db.query("INSERT INTO report_sessions(id,csrf,admission,expires_at) VALUES($1,'synthetic','synthetic',now()+interval '1 day')", [owner]);
    const upload = randomUUID();
    await db.query("INSERT INTO report_uploads(id,report_id,object_key,input,status,reserved_bytes,authorizations) VALUES($1,$2,$3,$4,'ready',17,$5)",
      [upload, id, 'private-owned-fixture/'+upload, { size: 17 }, { '1': 123 }]);
    const expiry = (await db.query("SELECT expires_at FROM model_reports WHERE id=$1", [id])).rows[0].expires_at;
    await recovery!.reconcileRestore(db, value, checkpoint);
    expect((await db.query("SELECT reserved_bytes::int AS bytes,object_key,authorizations,expires_at<=now() AS expired FROM report_uploads WHERE id=$1", [upload])).rows[0])
      .toEqual({ bytes: 17, object_key: 'private-owned-fixture/'+upload, authorizations: {}, expired: true });
    expect((await db.query("SELECT expires_at FROM model_reports WHERE id=$1", [id])).rows[0].expires_at).toEqual(expiry);
    expect((await db.query("SELECT status,draft,agreement FROM model_reports WHERE id=$1", [id])).rows[0]).toEqual({ status: "deleted", draft: {}, agreement: null });
    expect((await db.query("SELECT count(*)::int AS n FROM report_outbox")).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM report_sessions")).rows[0].n).toBe(0);
    await expect(recovery!.assertRestoreNotHeld(db)).rejects.toThrow("held");
    const server = createServer((req, res) => { void createHandler(db, storage, config)(req, res); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/reports/session`);
      expect(response.status).toBeGreaterThanOrEqual(500); expect(response.headers.get("set-cookie")).toBeNull();
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it("a truncated chain fails recovery with the independently committed hold still active", async () => {
    const { value, epoch } = journal(); await value.initialize(); expect(recovery).toBeDefined();
    const head = await value.append(randomUUID(), "delete");
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `operations/restore/${epoch}/entries/${head.hash}` }));
    await expect(recovery!.reconcileRestore(db, value, head)).rejects.toThrow();
    await expect(recovery!.assertRestoreNotHeld(db)).rejects.toThrow("held");
  });
});
