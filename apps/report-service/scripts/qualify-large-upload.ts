/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** @unwired-by-design Explicit large-transfer acceptance on an isolated test bucket;
 * CI uses the smaller real multipart integration test. Never uploads a user file.
 * Run after the root Turbo service build using root pnpm exec tsx <this file>.
 * Requires REPORT_TEST_* environment and --fixture <approved public IFC path>.
 * --small-only runs bounded fixture transport/cleanup qualification without 616 MiB.
 */
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { REPORT_LIMITS } from "@ifc-lite/report-contract";
import type { Config } from "../src/config.js";
import { openDatabase, migrate } from "../src/database.js";
import { ModelStorage } from "../src/storage.js";
import { createReport } from "../src/reports.js";
import {
  startUpload,
  uploadRow,
  authorizePart,
  completeUpload,
} from "../src/uploads.js";
import { verifyNext } from "../src/verification.js";
import { deleteReport } from "../src/maintenance.js";
const argument = process.argv.indexOf("--fixture");
if (argument < 0 || !process.argv[argument + 1])
  throw new Error("Pass an approved public IFC fixture with --fixture");
const fixture = await readFile(process.argv[argument + 1]!);
if (
  fixture.length > 8 * 1024 ** 2 ||
  !fixture.subarray(0, 256).includes(Buffer.from("ISO-10303-21"))
)
  throw new Error("Use a small public STEP IFC fixture");
const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};
const config: Config = {
  origin: "https://qualification.invalid",
  port: 0,
  databaseUrl: required("REPORT_TEST_DATABASE_URL"),
  bucket: `report-large-${randomUUID()}`,
  region: "us-east-1",
  endpoint: required("REPORT_TEST_S3_ENDPOINT"),
  forcePathStyle: true,
  accessKeyId: required("REPORT_TEST_S3_ACCESS_KEY_ID"),
  secretAccessKey: required("REPORT_TEST_S3_SECRET_ACCESS_KEY"),
  admissionSecret: randomUUID(),
  adminToken: randomUUID(),
  githubAppId: "unused",
  githubInstallationId: "unused",
  githubPrivateKey: "unused",
  githubRepository: "unused/unused",
  agreement: {
    issuer: "LTplus AG",
    jurisdiction: "Switzerland",
    version: "disabled",
    sha256: "",
    text: "",
    signingEnabled: false,
  },
  storageProvider: "Isolated qualification object store",
  storageLocation: "Local qualification machine",
  backupDisclosure: "Disposable test bucket",
  maxDailyReports: 5,
  maxDailyBytes: 2 * 1024 ** 3,
  maxStorageBytes: 100 * 1024 ** 3,
};
const client = new S3Client({
  region: config.region,
  endpoint: config.endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  },
});
let db = openDatabase(config.databaseUrl);
let storage = new ModelStorage(config);
const owner = { id: randomUUID(), csrf: randomUUID(), admission: randomUUID() };
let reportId: string | undefined;
let sampleTimer: ReturnType<typeof setInterval> | undefined;
const measurements: Record<string, unknown>[] = [];
let bucketCreated = false;
try {
  await migrate(db);
  await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  bucketCreated = true;
  const sizes = process.argv.includes("--small-only")
    ? [fixture.length]
    : [fixture.length, 616 * 1024 ** 2];
  for (const totalBytes of sizes) {
    const synthetic = totalBytes !== fixture.length;
    const report = await createReport(db, config, owner, {
      clientRequestId: randomUUID(),
      title: "Transport qualification fixture",
      description: synthetic
        ? "Synthetic 616 MiB transport fixture; not a rendering benchmark."
        : "Approved public IFC transport fixture",
      diagnostics: {
        errorCode: "transport_qualification",
        appVersion: "local",
        buildSha: "local",
      },
      visibility: "private",
    });
    reportId = report.id;
    const upload = await startUpload(db, storage, config, report.id, owner, {
      name: synthetic ? "synthetic-transport.ifc" : "public-fixture.ifc",
      size: totalBytes,
      type: "application/octet-stream",
      confidentiality: "none",
      uploadConsent: true,
    });
    const started = Date.now();
    const sourceHash = createHash("sha256");
    let peakRss = process.memoryUsage().rss;
    sampleTimer = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 100);
    for (
      let offset = 0;
      offset < totalBytes;
      offset += REPORT_LIMITS.partBytes
    ) {
      const size = Math.min(REPORT_LIMITS.partBytes, totalBytes - offset);
      // The large object is explicitly a synthetic transport fixture, not a
      // claimed authoring-tool model. Repeated bytes avoid retaining 616 MiB.
      const part = synthetic ? Buffer.alloc(size, 0x20) : fixture;
      if (synthetic && offset === 0)
        fixture.copy(part, 0, 0, Math.min(fixture.length, size));
      sourceHash.update(part);
      const checksum = createHash("sha256").update(part).digest("base64");
      const row = await uploadRow(db, report.id, upload.id, owner);
      const authorization = await authorizePart(
        db,
        storage,
        row,
        offset / REPORT_LIMITS.partBytes + 1,
        checksum,
      );
      const put = await fetch(authorization.url, {
        method: "PUT",
        headers: { "x-amz-checksum-sha256": checksum },
        body: part,
      });
      if (!put.ok)
        throw new Error(
          `Storage rejected qualification part: HTTP ${put.status}`,
        );
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      if (offset === 0) {
        await db.end();
        storage.close();
        db = openDatabase(config.databaseUrl);
        storage = new ModelStorage(config);
        const persisted = await uploadRow(db, report.id, upload.id, owner);
        if (persisted.id !== upload.id)
          throw new Error("Adapter recreation lost upload ownership");
      }
    }
    const row = await uploadRow(db, report.id, upload.id, owner);
    await completeUpload(db, storage, row, owner);
    await verifyNext(db, storage);
    if ((await uploadRow(db, report.id, upload.id, owner)).status !== "ready")
      throw new Error("Qualification did not verify");
    const sourceSha256 = sourceHash.digest("hex");
    const stored = await db.query<{ object_checksum: string }>(
      "SELECT object_checksum FROM report_uploads WHERE id=$1",
      [upload.id],
    );
    if (stored.rows[0]?.object_checksum !== sourceSha256)
      throw new Error("Stored full-object SHA256 differs from source");
    clearInterval(sampleTimer);
    sampleTimer = undefined;
    measurements.push({
      synthetic,
      bytes: totalBytes,
      parts: Math.ceil(totalBytes / REPORT_LIMITS.partBytes),
      durationMs: Date.now() - started,
      sourceSha256,
      storedSha256: stored.rows[0]!.object_checksum,
      peakRssBytes: peakRss,
      backendAdapterRecreatedAfterFirstPart: true,
    });
    await deleteReport(db, storage, report.id, owner.id);
    reportId = undefined;
  }
  console.log(JSON.stringify({ status: "passed", measurements }, null, 2));
} finally {
  clearInterval(sampleTimer);
  try {
    if (reportId) await deleteReport(db, storage, reportId, owner.id);
  } finally {
    try {
      if (bucketCreated)
        await client.send(new DeleteBucketCommand({ Bucket: config.bucket }));
    } finally {
      try {
        await db.end();
      } finally {
        storage.close();
        client.destroy();
      }
    }
  }
}
