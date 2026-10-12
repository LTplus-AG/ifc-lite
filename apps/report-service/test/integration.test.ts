/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  S3Client,
  CreateBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { openDatabase, migrate } from "../src/database.js";
import type { Config } from "../src/config.js";
import { verifyNext } from "../src/verification.js";
import { ModelStorage } from "../src/storage.js";
import { createReport, ownedReport, submitReport } from "../src/reports.js";
import {
  startUpload,
  authorizePart,
  completeUpload,
  uploadRow,
} from "../src/uploads.js";
import { removeUpload, deleteReport } from "../src/maintenance.js";
const enabled = Boolean(
  process.env.REPORT_TEST_DATABASE_URL && process.env.REPORT_TEST_S3_ENDPOINT,
);
if (process.env.REPORT_REQUIRE_INTEGRATION === "true" && !enabled)
  throw new Error("Mandatory real report integration environment is missing");
describe.skipIf(!enabled)(
  "#7495 real PostgreSQL and S3 multipart integration (set REPORT_TEST_* to run)",
  () => {
    const bucket = `report-test-${randomUUID()}`;
    const config: Config = {
      storageProvider: "Local test S3",
      storageLocation: "Local development machine",
      backupDisclosure: "No backups",
      origin: "https://viewer.example.com",
      port: 3005,
      databaseUrl: process.env.REPORT_TEST_DATABASE_URL ?? "",
      bucket,
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
    const db = openDatabase(config.databaseUrl);
    const storage = new ModelStorage(config);
    const owner = {
      id: `integration-${randomUUID()}`,
      csrf: "csrf",
      admission: randomUUID(),
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
    beforeAll(async () => {
      await migrate(db);
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    });
    afterAll(async () => {
      await db.end();
      client.destroy();
    });
    it("persists multipart ownership, resumes exact parts, verifies and deletes real bytes", async () => {
      const input = {
        clientRequestId: randomUUID(),
        title: "Real upload acceptance",
        description: "Reviewed diagnostics",
        diagnostics: {
          errorCode: "fixture",
          appVersion: "test",
          buildSha: "test",
        },
        visibility: "private" as const,
      };
      const report = await createReport(db, config, owner, input);
      expect((await createReport(db, config, owner, input)).id).toBe(report.id);
      const bytes = Buffer.alloc(16 * 1024 ** 2 + 61, 0x20);
      Buffer.from(
        "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;",
      ).copy(bytes);
      const uploadInput = {
        name: "fixture.ifc",
        size: bytes.length,
        type: "application/octet-stream" as const,
        confidentiality: "none" as const,
        uploadConsent: true as const,
      };
      const upload = await startUpload(
        db,
        storage,
        config,
        report.id,
        owner,
        uploadInput,
      );
      expect(
        (await startUpload(db, storage, config, report.id, owner, uploadInput))
          .id,
      ).toBe(upload.id);
      await expect(
        uploadRow(db, report.id, upload.id, { ...owner, id: "someone-else" }),
      ).rejects.toThrow();
      let row = await uploadRow(db, report.id, upload.id, owner);
      const firstChecksum = createHash("sha256")
        .update(bytes.subarray(0, 16 * 1024 ** 2))
        .digest("base64");
      for (let offset = 0; offset < bytes.length; offset += 16 * 1024 ** 2) {
        const chunk = bytes.subarray(
          offset,
          Math.min(bytes.length, offset + 16 * 1024 ** 2),
        );
        const sha256 = createHash("sha256").update(chunk).digest("base64");
        const part = await authorizePart(
          db,
          storage,
          row,
          offset / (16 * 1024 ** 2) + 1,
          sha256,
        );
        const put = await fetch(part.url, {
          method: "PUT",
          headers: { "x-amz-checksum-sha256": sha256 },
          body: chunk,
        });
        expect(
          put.ok,
          `Storage PUT HTTP ${put.status}: ${put.ok ? "" : (await put.text()).slice(0, 2000)}`,
        ).toBe(true);
      }
      const persisted = await storage.parts(row.object_key, row.multipart_id!);
      expect(persisted).toHaveLength(2);
      expect(persisted[0]?.size).toBe(16 * 1024 ** 2);
      expect(
        (await uploadRow(db, report.id, upload.id, owner)).parts["1"],
      ).toBe(firstChecksum);
      await expect(
        authorizePart(
          db,
          storage,
          row,
          1,
          createHash("sha256").update("changed").digest("base64"),
        ),
      ).rejects.toThrow();
      expect((await completeUpload(db, storage, row, owner)).status).toBe(
        "verifying",
      );
      await verifyNext(db, storage);
      row = await uploadRow(db, report.id, upload.id, owner);
      expect((await completeUpload(db, storage, row, owner)).status).toBe(
        "ready",
      );
      expect((await submitReport(db, report.id, owner, false)).status).toBe(
        "submitted",
      );
      expect((await ownedReport(db, report.id, owner)).status).toBe(
        "submitted",
      );
      await removeUpload(db, storage, row, owner.id);
      await deleteReport(db, storage, report.id, owner.id);
      await expect(
        client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: row.object_key }),
        ),
      ).rejects.toThrow();
    }, 30000);
    it("refuses standard NDA upload before exact template approval and enforces durable quota", async () => {
      const input = {
        clientRequestId: randomUUID(),
        title: "NDA gate",
        description: "",
        diagnostics: {
          errorCode: "fixture",
          appVersion: "test",
          buildSha: "test",
        },
        visibility: "private" as const,
      };
      const report = await createReport(db, config, owner, input);
      await expect(
        startUpload(db, storage, config, report.id, owner, {
          name: "fixture.ifc",
          size: 100,
          type: "application/octet-stream",
          confidentiality: "standard",
          uploadConsent: true,
        }),
      ).rejects.toThrow(/agreement/i);
      await expect(
        createReport(
          db,
          { ...config, maxDailyReports: 0 },
          { ...owner, id: randomUUID() },
          { ...input, clientRequestId: randomUUID() },
        ),
      ).rejects.toThrow(/allowance/i);
    });

    it("rejects actual object corruption and expired part capabilities, then cleans up cancelled multipart state", async () => {
      const report = await createReport(db, config, owner, {
        clientRequestId: randomUUID(),
        title: "Corruption acceptance",
        description: "",
        diagnostics: {
          errorCode: "corruption",
          appVersion: "test",
          buildSha: "test",
        },
        visibility: "private",
      });
      const bytes = Buffer.from("original model bytes");
      const sha256 = createHash("sha256").update(bytes).digest("base64");
      const upload = await startUpload(db, storage, config, report.id, owner, {
        name: "fixture.ifc",
        size: bytes.length,
        type: "application/octet-stream",
        confidentiality: "none",
        uploadConsent: true,
      });
      const row = await uploadRow(db, report.id, upload.id, owner);
      const expired = await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: row.object_key,
          UploadId: row.multipart_id!,
          PartNumber: 1,
          ChecksumSHA256: sha256,
          ContentLength: bytes.length,
        }),
        {
          expiresIn: 1,
          unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(
        (
          await fetch(expired, {
            method: "PUT",
            headers: { "x-amz-checksum-sha256": sha256 },
            body: bytes,
          })
        ).ok,
      ).toBe(false);
      const fresh = await authorizePart(db, storage, row, 1, sha256);
      expect(
        (
          await fetch(fresh.url, {
            method: "PUT",
            headers: { "x-amz-checksum-sha256": sha256 },
            body: bytes,
          })
        ).ok,
      ).toBe(true);
      await completeUpload(db, storage, row, owner);
      // Simulate corrupted provider bytes through the actual object store, after
      // upload metadata passed. The canonical read must reject, not trust ETags.
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: row.object_key,
          Body: Buffer.alloc(bytes.length, 0x78),
          ServerSideEncryption: "AES256",
        }),
      );
      await verifyNext(db, storage);
      expect((await uploadRow(db, report.id, upload.id, owner)).status).toBe(
        "failed",
      );
      await expect(submitReport(db, report.id, owner, false)).rejects.toThrow();
      await deleteReport(db, storage, report.id, owner.id);
      await expect(
        storage.parts(row.object_key, row.multipart_id!),
      ).rejects.toThrow();
    }, 30000);
    it("does not revive an upload when deletion overlaps object-store initialization", async () => {
      const report = await createReport(db, config, owner, {
        clientRequestId: randomUUID(),
        title: "Initialization race",
        description: "",
        diagnostics: {
          errorCode: "init",
          appVersion: "test",
          buildSha: "test",
        },
        visibility: "private",
      });
      const actualCreate = storage.create.bind(storage);
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spy = vi
        .spyOn(storage, "create")
        .mockImplementation(async (key) => {
          entered();
          await gate;
          return actualCreate(key);
        });
      const upload = startUpload(db, storage, config, report.id, owner, {
        name: "fixture.ifc",
        size: 100,
        type: "application/octet-stream",
        confidentiality: "none",
        uploadConsent: true,
      });
      await started;
      const deletion = deleteReport(db, storage, report.id, owner.id);
      release();
      await Promise.all([upload, deletion]);
      spy.mockRestore();
      const saved = await db.query(
        "SELECT status,reserved_bytes FROM report_uploads WHERE report_id=$1",
        [report.id],
      );
      expect(saved.rows[0]?.status).toBe("aborted");
      expect(Number(saved.rows[0]?.reserved_bytes)).toBe(0);
      await expect(
        startUpload(db, storage, config, report.id, owner, {
          name: "fixture.ifc",
          size: 100,
          type: "application/octet-stream",
          confidentiality: "none",
          uploadConsent: true,
        }),
      ).rejects.toThrow();
    }, 30000);
  },
);
