/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { loadConfig, type Config } from "../src/config.js";
import { migrate, openDatabase } from "../src/database.js";
import { RestoreJournal } from "../src/restore-journal.js";
import { assertRestoreNotHeld } from "../src/restore-recovery.js";
import { loadFeature } from "./feature-loader.js";
const enabled = Boolean(process.env.REPORT_TEST_DATABASE_URL && process.env.REPORT_TEST_S3_ENDPOINT);
if (process.env.REPORT_REQUIRE_INTEGRATION === "true" && !enabled) throw new Error("Mandatory journal runtime fixture missing");
describe.skipIf(!enabled)("#7495 journal runtime admission, custody and real worker wiring", () => {
  const bucket = `runtime-${randomUUID()}`;
  const admin = openDatabase(process.env.REPORT_TEST_DATABASE_URL ?? "");
  const s3 = new S3Client({ region: "us-east-1", endpoint: process.env.REPORT_TEST_S3_ENDPOINT, forcePathStyle: true,
    credentials: { accessKeyId: process.env.REPORT_TEST_S3_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.REPORT_TEST_S3_SECRET_ACCESS_KEY ?? "" } });
  let runtime: typeof import("../src/journal-runtime.js") | undefined;
  let journalConfig: typeof import("../src/journal-config.js") | undefined;
  let directory: string;
  let schema: string;
  let config: Config;
  let env: NodeJS.ProcessEnv;
  let db: ReturnType<typeof openDatabase>;
  let witness: RestoreJournal;
  type OwnedChild = { process: ChildProcess; done: Promise<{ code: number | null; output: string }> };
  const children: OwnedChild[] = [];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "report-journal-runtime-"));
    runtime = await loadFeature("../src/journal-runtime.js", () => import("../src/journal-runtime.js"));
    journalConfig = await loadFeature("../src/journal-config.js", () => import("../src/journal-config.js"));
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });
  beforeEach(async () => {
    schema = `runtime_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.REPORT_TEST_DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const epoch = randomBytes(32).toString("hex");
    const key = randomBytes(32).toString("hex");
    env = { REPORT_VIEWER_ORIGIN: "https://viewer.example.com", REPORT_DATABASE_URL: url.toString(),
      REPORT_ADMISSION_SECRET: "a".repeat(32), REPORT_ADMIN_TOKEN: "b".repeat(32),
      REPORT_GITHUB_PRIVATE_KEY: "unused", REPORT_GITHUB_APP_ID: "1", REPORT_GITHUB_INSTALLATION_ID: "1", REPORT_GITHUB_REPOSITORY: "owner/repo",
      REPORT_STORAGE_PROVIDER: "fixture", REPORT_STORAGE_LOCATION: "local", REPORT_BACKUP_DISCLOSURE: "none",
      REPORT_S3_BUCKET: bucket, REPORT_S3_REGION: "us-east-1", REPORT_S3_ENDPOINT: process.env.REPORT_TEST_S3_ENDPOINT,
      REPORT_S3_FORCE_PATH_STYLE: "true", REPORT_S3_ACCESS_KEY_ID: process.env.REPORT_TEST_S3_ACCESS_KEY_ID,
      REPORT_S3_SECRET_ACCESS_KEY: process.env.REPORT_TEST_S3_SECRET_ACCESS_KEY,
      REPORT_JOURNAL_EPOCH: epoch, REPORT_JOURNAL_HMAC_KEY: key, REPORT_JOURNAL_CUSTODY_FILE: join(directory, epoch + ".json") };
    config = loadConfig(env); db = openDatabase(config.databaseUrl); await migrate(db);
    const actual = (await db.query("SELECT current_database() AS database,current_schema() AS schema")).rows[0];
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    await writeFile(env.REPORT_JOURNAL_CUSTODY_FILE!, JSON.stringify({ version: 1, epoch, keyFingerprint: digest(key), ...actual,
      targetDigest: digest(JSON.stringify([config.bucket, config.region, config.endpoint, true])),
      custodian: "fixture operator", independentLocation: "isolated fixture filesystem; not production custody evidence",
      initialCheckpoint: { epoch, sequence: 0, hash: "0".repeat(64) } }), { mode: 0o600 });
    witness = new RestoreJournal(config, epoch, key);
  });
  afterEach(async () => {
    const stops = children.splice(0).map(child => { child.process.kill("SIGTERM"); return child.done; });
    const results = await Promise.allSettled(stops);
    try { witness?.close(); await db?.end(); }
    finally { if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    if (results.some(result => result.status === "rejected")) throw new Error("owned fixture child cleanup failed");
  });
  afterAll(async () => {
    try {
      const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
      for (const object of objects.Contents ?? []) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    } finally { s3.destroy(); await admin.end(); await rm(directory, { recursive: true, force: true }); }
  });
  function feature() { expect(runtime, "runtime journal API must exist").toBeDefined(); return runtime!; }
  function launch(overrides: NodeJS.ProcessEnv = {}, initialize = false): OwnedChild {
    // @source-text-assertion-ok inherited process.env variable-name scrub; no predicate reads file/source contents
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("REPORT_")));
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
      fileURLToPath(new URL(initialize ? "../scripts/initialize-journal.ts" : "../src/bin.ts", import.meta.url)),
      ...(initialize ? ["--confirm-independent-custody-and-quiescence"] : [])],
      { env: { ...clean, ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk).slice(-4096); });
    child.stderr.on("data", (chunk: Buffer) => { output = (output + chunk).slice(-4096); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 55000);
    const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); resolve({ code, output }); });
    });
    const result = { process: child, done }; children.push(result); return result;
  }
  async function report(owner: string = randomUUID()) {
    const id = randomUUID();
    await db.query("INSERT INTO model_reports(id,session_id,client_key,draft,fingerprint) VALUES($1,$2,$3,$4,$5)",
      [id, owner, randomUUID(), { title: "Synthetic fixture", description: "fixture" }, randomUUID()]);
    return id;
  }
  it("strict partial config and protected custody never permit implicit initialization", async () => {
    expect(journalConfig, "journal config API must exist").toBeDefined();
    expect(() => journalConfig!.loadJournalConfig({ REPORT_JOURNAL_EPOCH: env.REPORT_JOURNAL_EPOCH })).toThrow();
    expect(() => loadConfig({ ...env, REPORT_JOURNAL_HMAC_KEY_FILE: "also-configured" })).toThrow();
    await expect(feature().openRuntimeJournal(db, config)).rejects.toThrow("binding");
    await expect(witness.checkpoint()).rejects.toThrow();
    await chmod(env.REPORT_JOURNAL_CUSTODY_FILE!, 0o644);
    await expect(feature().initializeRuntimeJournal(db, config)).rejects.toThrow("protection");
    await expect(witness.checkpoint()).rejects.toThrow();
  });
  it("disabled missing journal accepts only empty history; initialization refuses historical audit", async () => {
    expect(await feature().openRuntimeJournal(db, { ...config, journal: undefined })).toBeUndefined();
    await expect(feature().openRuntimeJournal(db, { ...config, journal: undefined, qualificationToken: "q".repeat(32) })).rejects.toThrow("required");
    await db.query("INSERT INTO report_audit(action,actor) VALUES('synthetic-prior-history','fixture')");
    await expect(feature().openRuntimeJournal(db, { ...config, journal: undefined })).rejects.toThrow("history");
    await expect(feature().initializeRuntimeJournal(db, config)).rejects.toThrow("history");
    await expect(witness.checkpoint()).rejects.toThrow();
    const child = launch({ REPORT_JOURNAL_EPOCH: undefined, REPORT_JOURNAL_HMAC_KEY: undefined, REPORT_JOURNAL_CUSTODY_FILE: undefined });
    expect(await child.done).toEqual({ code: 1, output: "[report-service] startup failed\n" });
  });
  it("#7495 actual empty no-journal bin holds workers and refuses later legacy history on restart", async () => {
    feature();
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("fixture port missing");
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const disabled = { PORT: String(port), REPORT_JOURNAL_EPOCH: undefined, REPORT_JOURNAL_HMAC_KEY: undefined,
      REPORT_JOURNAL_CUSTODY_FILE: undefined, REPORT_SUBMISSIONS_ENABLED: "false", REPORT_QUALIFICATION_TOKEN: undefined };
    const child = launch(disabled);
    const base = `http://127.0.0.1:${port}`;
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { healthy = (await fetch(base + "/healthz", { signal: AbortSignal.timeout(300) })).ok; }
      catch (error) { if (!(error instanceof TypeError || error instanceof DOMException)) throw error; }
      if (healthy) break; await delay(25);
    }
    expect(healthy, "empty disabled startup remains available without implicitly initializing a journal").toBe(true);
    expect(await (await fetch(base + "/api/reports/capabilities", { signal: AbortSignal.timeout(1000) })).json()).toEqual({ submissionsEnabled: false });
    // Seed owned witness history only AFTER readiness. No production history is deleted or exempted.
    await db.query("INSERT INTO report_sessions VALUES('held-worker-witness','fixture','fixture',now()-interval '1 day')");
    const queued = await report("held-worker-witness");
    await db.query("UPDATE model_reports SET status='submitted' WHERE id=$1", [queued]);
    await db.query("INSERT INTO report_outbox(report_id) VALUES($1)", [queued]);
    await delay(11000); // Observe beyond the actual 10-second production worker interval.
    expect((await db.query("SELECT id FROM report_sessions WHERE id='held-worker-witness'")).rowCount).toBe(1);
    expect((await db.query("SELECT attempts,last_error FROM report_outbox WHERE report_id=$1", [queued])).rows).toEqual([{ attempts: 0, last_error: null }]);
    expect((await db.query("SELECT count(*)::int AS n FROM report_journal_binding")).rows[0].n).toBe(0);
    await expect(witness.checkpoint()).rejects.toThrow();
    child.process.kill("SIGTERM"); expect(await child.done).toEqual({ code: 0, output: "" });
    expect(await launch(disabled).done).toEqual({ code: 1, output: "[report-service] startup failed\n" });
    await expect(feature().initializeRuntimeJournal(db, config)).rejects.toThrow("history");
    expect((await db.query("SELECT id FROM model_reports WHERE id=$1", [queued])).rowCount).toBe(1);
  }, 30000);
  it("explicit CLI initializes once, binds lineage and authenticates remote head before real startup", async () => {
    feature(); // A missing runtime API is an assertion failure, not a missing CLI loader crash.
    expect(await launch({}, true).done).toEqual({ code: 0, output: "report_journal_initialized\n" });
    expect(await witness.checkpoint()).toMatchObject({ sequence: 0 });
    expect((await db.query("SELECT count(*)::int AS n FROM report_journal_binding")).rows[0].n).toBe(1);
    expect((await launch({}, true).done).code).toBe(1);
    const journal = await feature().openRuntimeJournal(db, { ...config, submissionsEnabled: true }); journal?.close();
    await expect(feature().openRuntimeJournal(db, { ...config, journal: undefined })).rejects.toThrow("required");
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `operations/restore/${env.REPORT_JOURNAL_EPOCH}/head` }));
    expect(await launch({ REPORT_SUBMISSIONS_ENABLED: "true" }).done).toEqual({ code: 1, output: "[report-service] startup failed\n" });
  });
  it("rejects wrong initialization target, key, epoch, storage and copied physical targets before actual startup", async () => {
    const original = await readFile(env.REPORT_JOURNAL_CUSTODY_FILE!, "utf8");
    const custody = JSON.parse(original) as Record<string, unknown>;
    await writeFile(env.REPORT_JOURNAL_CUSTODY_FILE!, JSON.stringify({ ...custody, schema: "wrong_schema" }));
    await expect(feature().initializeRuntimeJournal(db, config)).rejects.toThrow("target");
    await expect(witness.checkpoint()).rejects.toThrow();
    await writeFile(env.REPORT_JOURNAL_CUSTODY_FILE!, original);
    await feature().initializeRuntimeJournal(db, config);
    await expect(feature().openRuntimeJournal(db, { ...config, bucket: "wrong-target" })).rejects.toThrow("target");
    await expect(feature().openRuntimeJournal(db, { ...config, journal: { ...config.journal!, epoch: "0".repeat(64) } })).rejects.toThrow("custody");
    await expect(feature().openRuntimeJournal(db, { ...config, journal: { ...config.journal!, key: "0".repeat(64) } })).rejects.toThrow("custody");
    const actual = (await db.query<{ database: string; schema: string }>("SELECT current_database() AS database,current_schema() AS schema")).rows[0];
    for (const field of ["database_name", "schema_name"] as const) {
      await db.query(`UPDATE report_journal_binding SET ${field}=$1`, ["wrong_fixture_target"]);
      await expect(feature().openRuntimeJournal(db, config)).rejects.toThrow("binding");
      expect(await launch().done).toEqual({ code: 1, output: "[report-service] startup failed\n" });
      await db.query(`UPDATE report_journal_binding SET ${field}=$1`, [field === "database_name" ? actual.database : actual.schema]);
    }
    // A genuine PostgreSQL schema copy carries the same valid epoch/binding/history.
    // Authenticating the remote head must not silently authorize the new physical target.
    const replacement = `runtime_copy_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${replacement}`);
    const target = new URL(config.databaseUrl); target.searchParams.set("options", `-c search_path=${replacement}`);
    const copied = openDatabase(target.toString());
    try {
      const retained = await report();
      await migrate(copied);
      await copied.query(`INSERT INTO report_journal_binding SELECT * FROM ${schema}.report_journal_binding`);
      await copied.query(`INSERT INTO model_reports SELECT * FROM ${schema}.model_reports`);
      expect((await copied.query("SELECT id FROM model_reports WHERE id=$1", [retained])).rowCount).toBe(1);
      await expect(feature().openRuntimeJournal(copied, { ...config, databaseUrl: target.toString() })).rejects.toThrow("target");
      expect(await launch({ REPORT_DATABASE_URL: target.toString() }).done).toEqual({ code: 1, output: "[report-service] startup failed\n" });
      expect((await db.query("SELECT id FROM model_reports WHERE id=$1", [retained])).rowCount).toBe(1);
      expect((await copied.query("SELECT id FROM model_reports WHERE id=$1", [retained])).rowCount).toBe(1);
      expect(await witness.checkpoint()).toMatchObject({ sequence: 0 });
    } finally { await copied.end(); await admin.query(`DROP SCHEMA ${replacement} CASCADE`); }
    const opened = await feature().openRuntimeJournal(db, config); expect(opened).toBeDefined(); opened?.close();
    await db.query("CREATE TABLE report_restore_hold(singleton boolean PRIMARY KEY,held boolean NOT NULL); INSERT INTO report_restore_hold VALUES(true,true)");
    await expect(assertRestoreNotHeld(db)).rejects.toThrow("held");
    expect(await launch().done).toEqual({ code: 1, output: "[report-service] startup failed\n" });
  }, 30000);
  it("actual HTTP deletion, retention and corrupt-byte verifier persist independent intents before draining", async () => {
    await feature().initializeRuntimeJournal(db, config);
    const ownerToken = randomBytes(32).toString("hex");
    const owner = createHash("sha256").update(ownerToken).digest("hex");
    await db.query("INSERT INTO report_sessions(id,csrf,admission,expires_at) VALUES($1,'csrf','fixture',now()+interval '1 day')", [owner]);
    const deleted = await report(owner); const expired = await report(); const corrupt = await report();
    await db.query("UPDATE model_reports SET expires_at=now()-interval '1 second' WHERE id=$1", [expired]);
    const portServer = createServer(); await new Promise<void>(resolve => portServer.listen(0, "127.0.0.1", resolve));
    const address = portServer.address(); if (!address || typeof address === "string") throw new Error("fixture port missing");
    const port = address.port; await new Promise<void>(resolve => portServer.close(() => resolve()));
    const child = launch({ PORT: String(port), REPORT_SUBMISSIONS_ENABLED: "true" });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; }
      catch (error) { if (!(error instanceof TypeError)) throw error; }
      if (ready) break; await delay(50);
    }
    expect(ready).toBe(true);
    const journalKey = `operations/restore/${env.REPORT_JOURNAL_EPOCH}/head`;
    const head = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: journalKey }));
    const headBody = await head.Body!.transformToString();
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: journalKey }));
    const unavailable = await fetch(`http://127.0.0.1:${port}/api/reports/${deleted}`, { method: "DELETE",
      headers: { Origin: config.origin, Cookie: `__Host-ifclite_report=${ownerToken}`, "X-CSRF-Token": "csrf" } });
    expect(unavailable.status).toBeGreaterThanOrEqual(500);
    expect((await db.query("SELECT status FROM model_reports WHERE id=$1", [deleted])).rows[0].status).toBe("draft");
    // Restore only the exact fixture genesis after injected loss, before any
    // acknowledged operation. Production initialization never overwrites it.
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: journalKey, Body: headBody, IfNoneMatch: "*", ServerSideEncryption: "AES256" }));
    const response = await fetch(`http://127.0.0.1:${port}/api/reports/${deleted}`, { method: "DELETE",
      headers: { Origin: config.origin, Cookie: `__Host-ifclite_report=${ownerToken}`, "X-CSRF-Token": "csrf" } });
    expect(response.status).toBe(200);
    for (let i = 0; i < 300; i++) {
      const expiredRow = await db.query("SELECT status FROM model_reports WHERE id=$1", [expired]);
      if (expiredRow.rows[0].status === "deleted") break;
      await delay(50);
    }
    expect((await db.query("SELECT status FROM model_reports WHERE id=$1", [expired])).rows[0].status).toBe("deleted");
    const key = `fixture/${randomUUID()}`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "wrong", ServerSideEncryption: "AES256" }));
    await db.query(`INSERT INTO report_uploads(id,report_id,object_key,input,status,reserved_bytes,parts)
      VALUES($1,$2,$3,$4,'verifying',5,$5)`, [randomUUID(), corrupt, key, { size: 5 }, { "1": createHash("sha256").update("right").digest("base64") }]);

    for (let i = 0; i < 300; i++) {
      const rows = await db.query("SELECT status FROM report_uploads WHERE report_id=$1", [corrupt]);
      const exp = await db.query("SELECT status FROM model_reports WHERE id=$1", [expired]);
      if (rows.rows[0].status === "failed" && exp.rows[0].status === "deleted") break;
      await delay(50);
    }
    child.process.kill("SIGTERM"); expect((await child.done).code).toBe(0);
    const intents = await witness.verify(await witness.checkpoint());
    expect(intents.map(entry => [entry.reportId, entry.action])).toEqual(expect.arrayContaining([
      [deleted, "delete"], [expired, "delete"], [corrupt, "remove-model"],
    ]));
    expect((await db.query("SELECT status FROM report_uploads WHERE report_id=$1", [corrupt])).rows[0].status).toBe("failed");
  }, 60000);
});
