/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreateBucketCommand, DeleteBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { openDatabase, migrate } from "../src/database.js";
import { createReport, submitReport } from "../src/reports.js";
import { ModelStorage } from "../src/storage.js";
import { authorizePart, startUpload, uploadRow } from "../src/uploads.js";
import { completeUpload, verifyNext } from "../src/verification.js";
import { deleteReport, removeUpload, sweep } from "../src/maintenance.js";
import type { Config } from "../src/config.js";
import type { PublicSharingConsent } from "@ifc-lite/report-contract";
import type { ScanEvidence, ScanLease } from "../src/public-quarantine.js";
import { loadFeature } from "./feature-loader.js";

const enabled = Boolean(process.env.REPORT_TEST_DATABASE_URL && process.env.REPORT_TEST_S3_ENDPOINT);
if (process.env.REPORT_REQUIRE_INTEGRATION === "true" && !enabled)
  throw new Error("Mandatory real report integration environment is missing");
// These cases prove quarantine authorization and lifecycle with real storage bytes.
// Synthetic trusted-worker attestations do NOT qualify the future malware scanner.
describe.skipIf(!enabled)("#7495 public quarantine preserves private bytes until scan AND independent review", () => {
  const owner = { id: randomUUID(), csrf: "fixture", admission: randomUUID() };
  const bucket = `public-quarantine-${randomUUID()}`;
  const schema = "public_quarantine_" + randomUUID().replace(/-/g, "");
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
    agreement: { version: "unapproved", sha256: "a".repeat(64), text: "DRAFT", issuer: "LTplus AG", jurisdiction: "Switzerland", signingEnabled: false },
  };
  const db = openDatabase(config.databaseUrl);
  const storage = new ModelStorage(config);
  const s3 = new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  let feature: typeof import("../src/public-quarantine.js") | undefined;
  let initialized = false;
  const reports: string[] = [];
  const consent: PublicSharingConsent = { version: "public-model-v1", authorityConfirmed: true, redistributionReviewed: true,
    confidentialContentReviewed: true, downloadedCopiesCannotBeRecalled: true, publishDownloadLink: true };
  const image = `sha256:${"d".repeat(64)}`;
  beforeAll(async () => {
    feature = await loadFeature("../src/public-quarantine.js", () => import("../src/public-quarantine.js"));
    if (!feature) return;
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(db);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    initialized = true;
  });
  afterAll(async () => {
    if (initialized) {
      for (const id of reports) await deleteReport(db, storage, id, owner.id);
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
    storage.close();
    s3.destroy();
    await db.end();
    if (initialized) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  function api() {
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
  it("private default queues no public work; a boolean cannot replace reviewed redistribution consent", async () => {
    api();
    const privateId = await draft("private");
    await uploaded(privateId, false);
    await submitReport(db, privateId, owner, false);
    expect(await state(privateId)).toBeUndefined();
    const id = await draft();
    await expect(startUpload(db, storage, config, id, owner, { name: "model.ifc", size: 64, type: "application/octet-stream",
      confidentiality: "none", uploadConsent: true, publicModelConfirmed: true })).rejects.toThrow(/redistribution/);
    await deleteReport(db, storage, id, owner.id);
  });
  it("NDA history prevents public sharing even when the new upload selects no NDA", async () => {
    api();
    for (const column of ["agreement", "custom_nda"] as const) {
      const id = await draft();
      // Server-side historical acceptance fixture, never client-supplied report mutation.
      await db.query(`UPDATE model_reports SET ${column}=$2 WHERE id=$1`, [id, JSON.stringify({ status: "approved" })]);
      await expect(uploaded(id)).rejects.toThrow(/confidentiality agreement/);
      await deleteReport(db, storage, id, owner.id);
    }
  });
  it("binds review to the actual verified bytes and requires both human review attestations", async () => {
    const f = api();
    const id = await queue();
    const lease = await claim(id);
    await expect(f.approvePublicModel(db, id, lease.sha256, image, { redistribution: true, confidentialContent: true })).rejects.toThrow(/fresh complete scan/);
    expect(await f.finishPublicScan(db, lease, clean(lease), image)).toBe(true);
    expect((await state(id)).state).toBe("review");
    await expect(f.approvePublicModel(db, id, "f".repeat(64), image, { redistribution: true, confidentialContent: true })).rejects.toThrow();
    await expect(f.approvePublicModel(db, id, lease.sha256, image, { redistribution: true, confidentialContent: false })).rejects.toThrow();
    await f.approvePublicModel(db, id, lease.sha256, image, { redistribution: true, confidentialContent: true });
    await f.approvePublicModel(db, id, lease.sha256, image, { redistribution: true, confidentialContent: true });
    expect((await db.query("SELECT count(*) AS n FROM report_audit WHERE report_id=$1 AND action='public_model_approved'", [id])).rows[0].n).toBe("1");
    const row = await state(id);
    expect(row.state).toBe("approved");
    expect(row.approval.sha256).toBe(lease.sha256);
    await deleteReport(db, storage, id, owner.id);
  });
  it("unknown, infected, stale signatures, incomplete scans and wrong image/hash never clear quarantine", async () => {
    const f = api();
    for (const override of [
      { outcome: "infected" as const }, { outcome: "inconclusive" as const }, { complete: false }, { format: "unsupported" as const },
      { signaturesAt: new Date(Date.now() - 25 * 3600000).toISOString() },
      { imageDigest: `sha256:${"e".repeat(64)}` }, { sha256: "f".repeat(64) }, { byteSize: 1 },
    ]) {
      const id = await queue();
      const lease = await claim(id);
      expect(await f.finishPublicScan(db, lease, { ...clean(lease), ...override }, image)).toBe(false);
      expect((await state(id)).state).toBe("blocked");
      await expect(f.approvePublicModel(db, id, lease.sha256, image, { redistribution: true, confidentialContent: true })).rejects.toThrow();
      await deleteReport(db, storage, id, owner.id);
    }
  });
  it("a crashed scanner's old lease cannot overwrite its replacement and retries are bounded", async () => {
    const f = api();
    const id = await queue();
    const first = await claim(id);
    await db.query("UPDATE report_public_quarantine SET lease_until=now()-interval '1 second' WHERE report_id=$1", [id]);
    const second = await claim(id);
    expect(second.leaseId).not.toBe(first.leaseId);
    expect(await f.finishPublicScan(db, first, clean(first), image)).toBe(false);
    await db.query("UPDATE report_public_quarantine SET lease_until=now()-interval '1 second' WHERE report_id=$1", [id]);
    await claim(id);
    await db.query("UPDATE report_public_quarantine SET lease_until=now()-interval '1 second' WHERE report_id=$1", [id]);
    expect(await f.claimPublicScan(db)).toBeNull();
    expect((await state(id)).state).toBe("blocked");
    await deleteReport(db, storage, id, owner.id);
  });
  it("concurrent workers lease once and concurrent deletion wins over a completed scan", async () => {
    const f = api();
    const id = await queue();
    const leases = (await Promise.all([f.claimPublicScan(db), f.claimPublicScan(db)])).filter((value): value is ScanLease => value !== null);
    expect(leases).toHaveLength(1);
    expect((await state(id)).attempts).toBe(1);
    const lease = leases[0]!;
    await Promise.all([f.finishPublicScan(db, lease, clean(lease), image), deleteReport(db, storage, id, owner.id)]);
    const row = await state(id);
    expect(row.state).toBe("revoked");
    expect([row.sha256, row.scan, row.consent, row.approval]).toEqual([null, null, null, null]);
    expect(await f.claimPublicScan(db)).toBeNull();
  });
  it("deletion and expiry revoke in-flight scans and erase private model fingerprints", async () => {
    const f = api();
    for (const expire of [false, true]) {
      const id = await queue();
      const lease = await claim(id);
      if (expire) {
        await db.query("UPDATE model_reports SET expires_at=now()-interval '1 second' WHERE id=$1", [id]);
        await sweep(db, storage);
      } else await deleteReport(db, storage, id, owner.id);
      expect(await f.finishPublicScan(db, lease, clean(lease), image)).toBe(false);
      const row = await state(id);
      expect(row.state).toBe("revoked");
      expect([row.sha256, row.consent, row.scan, row.approval, row.lease_id]).toEqual([null, null, null, null, null]);
    }
  });
  it("withdrawal commits even when the real object store rejects cleanup credentials", async () => {
    const f = api();
    const id = await queue();
    const lease = await claim(id);
    await f.finishPublicScan(db, lease, clean(lease), image);
    await f.approvePublicModel(db, id, lease.sha256, image, { redistribution: true, confidentialContent: true });
    const unavailable = new ModelStorage({ ...config, accessKeyId: "invalid-fixture-access", secretAccessKey: "invalid-fixture-secret" });
    try {
      await expect(removeUpload(db, unavailable, await uploadRow(db, id, lease.uploadId, owner), owner.id)).rejects.toThrow();
      expect((await state(id)).state).toBe("revoked");
      // Failed cleanup retains its durable upload record/reservation for retry.
      expect((await uploadRow(db, id, lease.uploadId, owner)).status).toBe("ready");
      expect(await f.finishPublicScan(db, lease, clean(lease), image)).toBe(false);
    } finally { unavailable.close(); }
    await deleteReport(db, storage, id, owner.id);
  });
  it("removing an approved attachment prevents later reuse of its approval", async () => {
    const f = api();
    const id = await queue();
    const lease = await claim(id);
    await f.finishPublicScan(db, lease, clean(lease), image);
    await f.approvePublicModel(db, id, lease.sha256, image, { redistribution: true, confidentialContent: true });
    await removeUpload(db, storage, await uploadRow(db, id, lease.uploadId, owner), owner.id);
    expect((await state(id)).state).toBe("revoked");
    await expect(f.approvePublicModel(db, id, lease.sha256, image, { redistribution: true, confidentialContent: true })).rejects.toThrow();
  });
});
