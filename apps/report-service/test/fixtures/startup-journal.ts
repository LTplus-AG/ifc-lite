/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, CreateBucketCommand, ListObjectsV2Command, DeleteObjectCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import { expect } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/database.js";
import { loadFeature } from "../feature-loader.js";

/** #7495/#7517: initialize only an owned empty schema before publisher seeding. */
export async function initializeStartupJournal(db: Db, baseEnv: NodeJS.ProcessEnv) {
  const feature = await loadFeature("../../src/journal-runtime.js", () => import("../../src/journal-runtime.js"));
  expect(feature, "journal runtime must exist before invoking the initialization CLI").toBeDefined();
  const bucket = `startup-journal-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "startup-journal-"));
  const s3 = new S3Client({ region: "us-east-1", endpoint: process.env.REPORT_TEST_S3_ENDPOINT, forcePathStyle: true,
    credentials: { accessKeyId: process.env.REPORT_TEST_S3_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.REPORT_TEST_S3_SECRET_ACCESS_KEY ?? "" } });
  let created = false;
  async function close(): Promise<void> {
    try {
      if (created) {
        let continuation: string | undefined;
        do {
          const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuation }));
          for (const object of page.Contents ?? []) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
          continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (continuation);
        await s3.send(new DeleteBucketCommand({ Bucket: bucket })); created = false;
      }
    } finally { s3.destroy(); await rm(directory, { recursive: true, force: true }); }
  }
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket })); created = true;
    const epoch = randomBytes(32).toString("hex"); const key = randomBytes(32).toString("hex");
    const env = { ...baseEnv, REPORT_S3_BUCKET: bucket, REPORT_S3_REGION: "us-east-1",
      REPORT_S3_ENDPOINT: process.env.REPORT_TEST_S3_ENDPOINT, REPORT_S3_FORCE_PATH_STYLE: "true",
      REPORT_S3_ACCESS_KEY_ID: process.env.REPORT_TEST_S3_ACCESS_KEY_ID, REPORT_S3_SECRET_ACCESS_KEY: process.env.REPORT_TEST_S3_SECRET_ACCESS_KEY,
      REPORT_JOURNAL_EPOCH: epoch, REPORT_JOURNAL_HMAC_KEY: key, REPORT_JOURNAL_CUSTODY_FILE: join(directory, "custody.json") };
    const config = loadConfig(env);
    const actual = (await db.query<{ database: string; schema: string }>("SELECT current_database() AS database,current_schema() AS schema")).rows[0];
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    await writeFile(env.REPORT_JOURNAL_CUSTODY_FILE, JSON.stringify({ version: 1, epoch, ...actual, keyFingerprint: digest(key),
      targetDigest: feature!.journalTargetDigest(config), custodian: "owned fixture operator",
      independentLocation: "isolated test filesystem only; not production custody evidence",
      initialCheckpoint: { epoch, sequence: 0, hash: "0".repeat(64) } }), { mode: 0o600 });
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
      fileURLToPath(new URL("../../scripts/initialize-journal.ts", import.meta.url)), "--confirm-independent-custody-and-quiescence"],
      { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk).slice(-4096); });
    child.stderr.on("data", (chunk: Buffer) => { output = (output + chunk).slice(-4096); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      child.once("error", reject); child.once("close", code => resolve({ code, output }));
    }).finally(() => clearTimeout(timer));
    expect(result).toEqual({ code: 0, output: "report_journal_initialized\n" });
    expect((await db.query("SELECT count(*)::int AS n FROM report_journal_binding")).rows[0].n).toBe(1);
    const journal = await feature!.openRuntimeJournal(db, config);
    try { expect(await journal!.checkpoint()).toMatchObject({ epoch, sequence: 0, hash: "0".repeat(64) }); }
    finally { journal?.close(); }
    return { env, close };
  } catch (error) { await close(); throw error; }
}
