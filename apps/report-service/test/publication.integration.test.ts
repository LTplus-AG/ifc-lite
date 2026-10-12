/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { openDatabase, migrate } from "../src/database.js";
import type { Config } from "../src/config.js";
import { ModelStorage } from "../src/storage.js";
import { GithubIssues } from "../src/github.js";
import { createReport, submitReport } from "../src/reports.js";
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

});
