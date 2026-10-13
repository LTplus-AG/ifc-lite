/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import pg from "pg";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { loadFeature } from './feature-loader.js';
const intentFeature = await loadFeature('../src/publication-intent.js', () => import('../src/publication-intent.js'));
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { openDatabase, migrate } from "../src/database.js";
import type { Config } from "../src/config.js";
import { ModelStorage } from "../src/storage.js";
import { GithubIssues } from "../src/github.js";
import { createReport, submitReport, ownedReport, receipt } from "../src/reports.js";
import { deleteReport } from "../src/maintenance.js";
import { publishOne } from "../src/publication.js";
const enabled = Boolean(process.env.REPORT_TEST_DATABASE_URL);
if (process.env.REPORT_REQUIRE_INTEGRATION === "true" && !enabled)
  throw new Error("Mandatory publication integration database is missing");
describe.skipIf(!enabled)("#7495 publication deletion serialization", () => {
  const config: Config = {
  submissionsEnabled: true,
    storageProvider: "Local test S3",
    storageLocation: "Local development machine",
    backupDisclosure: "No backups",
    origin: "https://viewer.example.com",
    port: 3005,
    databaseUrl: process.env.REPORT_TEST_DATABASE_URL ?? "",
    bucket: "unused",
    region: "us-east-1",
    endpoint: process.env.REPORT_TEST_S3_ENDPOINT,
    forcePathStyle: true,
    accessKeyId: process.env.REPORT_TEST_S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.REPORT_TEST_S3_SECRET_ACCESS_KEY ?? "",
    admissionSecret: "a".repeat(32),
    adminToken: "b".repeat(32),
    githubAppId: "1",
    githubInstallationId: "1",
    githubPrivateKey: "unused",
    githubRepository: "owner/repo",
    agreement: {
      version: "draft",
      sha256: "a".repeat(64),
      text: "DRAFT",
      issuer: "LTplus AG",
      jurisdiction: "Switzerland",
      signingEnabled: false,
    },
    maxDailyReports: 20,
    maxDailyBytes: 4 * 1024 ** 3,
    maxStorageBytes: 100 * 1024 ** 3,
  };

  const schema = "report_publication_" + randomUUID().replace(/-/g, "");
  const admin = openDatabase(process.env.REPORT_TEST_DATABASE_URL ?? "");
  const url = new URL(
    process.env.REPORT_TEST_DATABASE_URL ?? "postgres://localhost/unused",
  );
  url.searchParams.set("options", `-c search_path=${schema}`);
  const db = openDatabase(url.toString());
  const storage = new ModelStorage(config);
  const owner = {
    id: randomUUID(),
    csrf: randomUUID(),
    admission: randomUUID(),
  };
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(db);
  });
  afterAll(async () => {
    storage.close();
    await db.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  it("serializes deletion with in-flight GitHub publication without reviving a report", async () => {
    const report = await createReport(db, config, owner, {
      clientRequestId: randomUUID(),
      title: "Deletion race",
      description: "Reviewed report",
      diagnostics: {
        errorCode: "race",
        appVersion: "test",
        buildSha: "test",
      },
      visibility: "private",
    });
    await submitReport(db, report.id, owner, false);
    const github = new GithubIssues(config);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(github, "findOrCreate").mockImplementation(async () => {
      entered();
      await gate;
      return "https://github.com/owner/repo/issues/1";
    });
    const publication = publishOne(db, github);
    await started;
    const deletion = deleteReport(db, storage, report.id, owner.id);
    release();
    await Promise.all([publication, deletion]);
    expect(
      (
        await db.query("SELECT status FROM model_reports WHERE id=$1", [
          report.id,
        ])
      ).rows[0]?.status,
    ).toBe("deleted");
    expect(
      (
        await db.query(
          "SELECT report_id FROM report_outbox WHERE report_id=$1",
          [report.id],
        )
      ).rowCount,
    ).toBe(0);
  });
  it("does not publish an expired report while cleanup is delayed", async () => {
    const report = await createReport(db, config, owner, {
      clientRequestId: randomUUID(), title: "Expired report", description: "Reviewed before expiry",
      diagnostics: { errorCode: "expiry", appVersion: "test", buildSha: "test" }, visibility: "private",
    });
    await submitReport(db, report.id, owner, false);
    await db.query("UPDATE model_reports SET expires_at=now()-interval '1 second' WHERE id=$1", [report.id]);
    const github = new GithubIssues(config);
    const create = vi.spyOn(github, "findOrCreate").mockRejectedValue(new Error("Expired reports must not reach GitHub"));
    await publishOne(db, github);
    expect(create).not.toHaveBeenCalled();
    expect((await db.query("SELECT status FROM model_reports WHERE id=$1", [report.id])).rows[0]?.status).toBe("submitted");
  });
  it("#7495 committed intent survives worker rollback/restart and missing issue listing", async () => {
    const issueUrl = "https://github.com/owner/repo/issues/7495";
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const liveConfig = { ...config, databaseUrl: url.toString(), githubPrivateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    const report = await createReport(db, config, owner, {
      clientRequestId: randomUUID(), title: "Delayed GitHub listing", description: "Synthetic retry",
      diagnostics: { errorCode: "retry", appVersion: "test", buildSha: "test" }, visibility: "private",
    });
    await submitReport(db, report.id, owner, false);
    let posts = 0, visible = false;
    let saved: Record<string, unknown> | undefined;
    const server = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/app") { res.end(JSON.stringify({ id: 1, slug: "ifc-lite-reviewed-reports" })); return; }
      if (req.url?.startsWith("/users/")) { res.end(JSON.stringify({ id: 341635942, login: "ifc-lite-reviewed-reports[bot]", type: "Bot" })); return; }
      if (req.url?.endsWith("access_tokens")) { res.end(JSON.stringify({ token: "test" })); return; }
      if (req.url === "/repos/owner/repo/issues/7495") { res.end(JSON.stringify({ html_url: issueUrl, state: "open", title: "Existing target" })); return; }
      if (req.method === "POST") {
        posts++;
        saved = { ...JSON.parse(body), html_url: issueUrl,
          created_at: new Date().toISOString(), performed_via_github_app: null,
          user: { id: 341635942, login: "ifc-lite-reviewed-reports[bot]", type: "Bot" } };
        res.destroy(); return;
      }
      res.end(JSON.stringify(visible && saved ? [saved] : []));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing listener");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const worker = () => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/publication-worker.mjs", import.meta.url))], {
        env: { ...process.env, REPORT_PUBLICATION_TEST_CONFIG: JSON.stringify(liveConfig), REPORT_PUBLICATION_TEST_ENDPOINT: endpoint }, stdio: "pipe",
      });
      const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.stdout?.resume(); child.stderr?.resume();
      child.once("error", error => { clearTimeout(deadline); reject(error); });
      child.once("exit", code => { clearTimeout(deadline); resolve(code); });
    });
    try {
      // Real DB failure rolls back the publisher's transaction after accepted POST.
      await db.query(`CREATE OR REPLACE FUNCTION fail_retry_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qualification transaction rollback'; END $$`);
      await db.query(`CREATE TRIGGER fail_retry_update BEFORE UPDATE ON report_outbox FOR EACH ROW EXECUTE FUNCTION fail_retry_update()`);
      expect(await worker()).toBe(1);
      expect(posts).toBe(1);
      expect((await db.query("SELECT count(*)::int n FROM report_publication_intents WHERE report_id=$1", [report.id])).rows[0].n).toBe(1);
      await db.query("DROP TRIGGER fail_retry_update ON report_outbox");
      // A fresh process sees an empty listing and must hold rather than POST again.
      expect(await worker()).toBe(0);
      expect(posts).toBe(1);
      expect(receipt(await ownedReport(db, report.id, owner))).toMatchObject({ status: "submitted", publicationHold: "review_required" });
      expect((await db.query("SELECT last_error FROM report_outbox WHERE report_id=$1", [report.id])).rows[0].last_error).toBe("github_publication_review_required");
      visible = true;
      await db.query("UPDATE report_outbox SET available_at=now() WHERE report_id=$1", [report.id]);
      expect(await worker()).toBe(0);
      expect(posts).toBe(1);
      expect(receipt(await ownedReport(db, report.id, owner))).toMatchObject({ status: "published", issueUrl });
      expect(receipt(await ownedReport(db, report.id, owner)).publicationHold).toBeUndefined();
    } finally {
      await db.query("DROP TRIGGER IF EXISTS fail_retry_update ON report_outbox");
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 20000);

  it("#7495 fails closed when the independent intent connection cannot be acquired", async () => {
    expect(intentFeature, "durable intent helper must be available").toBeDefined();
    const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
    const held = await pool.connect();
    const id = randomUUID();
    try {
      await expect(intentFeature!.commitPublicationIntent(pool, id, 30)).rejects.toThrow("github_publication_intent_timeout");
      expect((await db.query("SELECT count(*)::int n FROM report_publication_intents WHERE report_id=$1", [id])).rows[0].n).toBe(0);
    } finally { held.release(); await pool.end(); }
  });

});
