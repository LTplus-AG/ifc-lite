/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
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
import { loadFeature } from "./feature-loader.js";
import { createReport, ownedReport, submitReport } from "../src/reports.js";
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
    let storage: InstanceType<typeof import("../src/storage.js").ModelStorage>;
    let ModelStorage: typeof import("../src/storage.js").ModelStorage;
    let verifyNext: typeof import("../src/verification.js").verifyNext;
    let startUpload: typeof import("../src/uploads.js").startUpload;
    let authorizePart: typeof import("../src/uploads.js").authorizePart;
    let completeUpload: typeof import("../src/uploads.js").completeUpload;
    let uploadRow: typeof import("../src/uploads.js").uploadRow;
    let removeUpload: typeof import("../src/maintenance.js").removeUpload;
    let deleteReport: typeof import("../src/maintenance.js").deleteReport;
    let sweep: typeof import("../src/maintenance.js").sweep;
    let available = false;
    function storageCase(
      name: string,
      run: () => Promise<void>,
      timeout?: number,
    ) {
      it(
        name,
        async () => {
          expect(
            available,
            "The verified private-upload feature must be available",
          ).toBe(true);
          await run();
        },
        timeout,
      );
    }
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
      const [verification, models, uploads, maintenance] = await Promise.all([
        loadFeature(
          "../src/verification.js",
          () => import("../src/verification.js"),
        ),
        loadFeature("../src/storage.js", () => import("../src/storage.js")),
        loadFeature("../src/uploads.js", () => import("../src/uploads.js")),
        loadFeature(
          "../src/maintenance.js",
          () => import("../src/maintenance.js"),
        ),
      ]);
      if (!verification || !models || !uploads || !maintenance) return;
      ({ ModelStorage } = models);
      ({ verifyNext } = verification);
      ({ startUpload, authorizePart, completeUpload, uploadRow } = uploads);
      ({ removeUpload, deleteReport, sweep } = maintenance);
      storage = new ModelStorage(config);
      await migrate(db);
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      available = true;
    });
    afterAll(async () => {
      await db.end();
      client.destroy();
    });
    storageCase("persists multipart ownership, resumes exact parts, verifies and deletes real bytes", async () => {
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
      // #7498: wrong-owner deletion must stop before all storage operations.
      const snapshot = async () => ({
        reports: (
          await db.query("SELECT * FROM model_reports WHERE id=$1", [report.id])
        ).rows,
        uploads: (
          await db.query("SELECT * FROM report_uploads WHERE report_id=$1", [
            report.id,
          ])
        ).rows,
        audit: (
          await db.query(
            "SELECT * FROM report_audit WHERE report_id=$1 ORDER BY id",
            [report.id],
          )
        ).rows,
      });
      const before = await snapshot();
      const deleteSpy = vi.spyOn(storage, "delete");
      const abortSpy = vi.spyOn(storage, "abort");
      try {
        await deleteReport(db, storage, report.id, "wrong-owner");
        expect(deleteSpy).not.toHaveBeenCalled();
        expect(abortSpy).not.toHaveBeenCalled();
        expect(await snapshot()).toEqual(before);
        expect((await storage.head(row.object_key)).size).toBe(bytes.length);
        expect(
          await storage.verify(row.object_key, bytes.length, row.parts),
        ).toBe(createHash("sha256").update(bytes).digest("hex"));
      } finally {
        deleteSpy.mockRestore();
        abortSpy.mockRestore();
      }
      await removeUpload(db, storage, row, owner.id);
      const sanitized = (
        await db.query("SELECT * FROM report_uploads WHERE id=$1", [row.id])
      ).rows[0];
      expect(sanitized).toMatchObject({
        status: "aborted",
        multipart_id: null,
        object_checksum: null,
        completed_at: null,
        parts: {},
        authorizations: {},
        object_key: `deleted/${row.id}`,
        input: { name: "deleted", size: 0, confidentiality: "none" },
      });
      expect(Number(sanitized.reserved_bytes)).toBe(0);
      expect(
        (
          await db.query(
            "SELECT detail FROM report_audit WHERE report_id=$1 AND action='upload_verified'",
            [report.id],
          )
        ).rows,
      ).toEqual([{ detail: {} }]);
      await deleteReport(db, storage, report.id, owner.id);
      await expect(
        client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: row.object_key }),
        ),
      ).rejects.toThrow();
    }, 30000);
    storageCase("refuses standard NDA upload before exact template approval and enforces durable quota", async () => {
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

    storageCase("rejects actual object corruption and expired part capabilities, then deletes the completed object", async () => {
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
      await expect(storage.head(row.object_key)).rejects.toThrow();
    }, 30000);
    storageCase("#7498 cancels a live multipart upload and retains retry identifiers until deletion succeeds", async () => {
      const report = await createReport(db, config, owner, {
        clientRequestId: randomUUID(),
        title: "Cancellation",
        description: "",
        diagnostics: {
          errorCode: "cancel",
          appVersion: "test",
          buildSha: "test",
        },
        visibility: "private",
      });
      const bytes = Buffer.from("private partial model");
      const upload = await startUpload(db, storage, config, report.id, owner, {
        name: "private-original.ifc",
        size: bytes.length,
        type: "application/octet-stream",
        confidentiality: "none",
        uploadConsent: true,
      });
      const row = await uploadRow(db, report.id, upload.id, owner);
      const sha256 = createHash("sha256").update(bytes).digest("base64");
      const capability = await authorizePart(db, storage, row, 1, sha256);
      expect(
        (
          await fetch(capability.url, {
            method: "PUT",
            headers: { "x-amz-checksum-sha256": sha256 },
            body: bytes,
          })
        ).ok,
      ).toBe(true);
      expect(
        await storage.parts(row.object_key, row.multipart_id!),
      ).toHaveLength(1);
      // A real provider deletion failure is simulated at the transport seam;
      // actual multipart abort has already happened and must be safely retried.
      const deletion = vi
        .spyOn(storage, "delete")
        .mockRejectedValueOnce(new Error("provider unavailable"));
      try {
        await expect(
          deleteReport(db, storage, report.id, owner.id),
        ).rejects.toThrow(/provider unavailable/);
      } finally {
        deletion.mockRestore();
      }
      const pending = (
        await db.query("SELECT * FROM report_uploads WHERE id=$1", [row.id])
      ).rows[0];
      expect(pending.object_key).toBe(row.object_key);
      expect(pending.multipart_id).toBe(row.multipart_id);
      expect(pending.parts).toEqual({ "1": sha256 });
      expect(pending.status).not.toBe("aborted");
      await sweep(db, storage);
      await expect(
        storage.parts(row.object_key, row.multipart_id!),
      ).rejects.toThrow();
      await expect(storage.head(row.object_key)).rejects.toThrow();
      const cleaned = (
        await db.query("SELECT * FROM report_uploads WHERE id=$1", [row.id])
      ).rows[0];
      expect(cleaned).toMatchObject({
        status: "aborted",
        multipart_id: null,
        parts: {},
        authorizations: {},
      });
      expect(cleaned.input.name).toBe("deleted");
      expect(cleaned.object_key).not.toBe(row.object_key);
    }, 30000);
    storageCase("#7498 retries transient GetObject failures with durable capped backoff and verifies the original bytes", async () => {
      const report = await createReport(db, config, owner, {
        clientRequestId: randomUUID(),
        title: "Retry read",
        description: "",
        diagnostics: {
          errorCode: "retry",
          appVersion: "test",
          buildSha: "test",
        },
        visibility: "private",
      });
      const bytes = Buffer.from("durable original IFC fixture bytes");
      const sha256 = createHash("sha256").update(bytes).digest("base64");
      const upload = await startUpload(db, storage, config, report.id, owner, {
        name: "retry.ifc",
        size: bytes.length,
        type: "application/octet-stream",
        confidentiality: "none",
        uploadConsent: true,
      });
      const row = await uploadRow(db, report.id, upload.id, owner);
      const capability = await authorizePart(db, storage, row, 1, sha256);
      expect(
        (
          await fetch(capability.url, {
            method: "PUT",
            headers: { "x-amz-checksum-sha256": sha256 },
            body: bytes,
          })
        ).ok,
      ).toBe(true);
      await completeUpload(db, storage, row, owner);
      expect((await storage.head(row.object_key)).size).toBe(bytes.length);
      const originalExpiry = (await uploadRow(db, report.id, upload.id, owner))
        .expires_at;
      const requests: {
        method: string | undefined;
        path: string | undefined;
      }[] = [];
      // Real SDK HTTP requests receive provider-shaped 503s; no storage method
      // is mocked and the completed object remains in the actual S3 fixture.
      const unavailable = createServer((request, response) => {
        requests.push({ method: request.method, path: request.url });
        response.writeHead(503, { "Content-Type": "application/xml" });
        response.end(
          "<Error><Code>SlowDown</Code><Message>Try later</Message></Error>",
        );
      });
      await new Promise<void>((resolve) =>
        unavailable.listen(0, "127.0.0.1", resolve),
      );
      const address = unavailable.address();
      if (!address || typeof address === "string")
        throw new Error("Fixture did not bind");
      const transient = new ModelStorage({
        ...config,
        endpoint: `http://127.0.0.1:${address.port}`,
      });
      const replacementDb = openDatabase(config.databaseUrl);
      const replacementStorage = new ModelStorage(config);
      try {
        await verifyNext(db, transient);
        expect(requests.length).toBeGreaterThan(0);
        expect(
          requests.every(
            (request) =>
              request.method === "GET" &&
              request.path?.includes(row.object_key),
          ),
        ).toBe(true);
        const pending = (
          await db.query("SELECT * FROM report_uploads WHERE id=$1", [row.id])
        ).rows[0];
        expect(pending.status).toBe("verifying");
        expect(pending.verification_attempts).toBe(1);
        expect(pending.verification_after.getTime()).toBeGreaterThan(
          Date.now(),
        );
        expect(pending.expires_at).toEqual(originalExpiry);
        await expect(
          submitReport(db, report.id, owner, false),
        ).rejects.toThrow();
        const requestCount = requests.length;
        await verifyNext(replacementDb, transient);
        expect(requests).toHaveLength(requestCount);
        // Exercise the cap after a persisted history of failures without
        // sleeping through hours of backoff in the qualification job.
        await db.query(
          "UPDATE report_uploads SET verification_attempts=20,verification_after=now()-interval '1 second' WHERE id=$1",
          [row.id],
        );
        await verifyNext(replacementDb, transient);
        const cap = (
          await db.query(
            "SELECT extract(epoch FROM verification_after-now())::float AS delay FROM report_uploads WHERE id=$1",
            [row.id],
          )
        ).rows[0].delay;
        expect(cap).toBeGreaterThan(890);
        expect(cap).toBeLessThanOrEqual(900);
        await db.query(
          "UPDATE report_uploads SET verification_after=now()-interval '1 second' WHERE id=$1",
          [row.id],
        );
        await verifyNext(replacementDb, replacementStorage);
        const ready = await uploadRow(db, report.id, upload.id, owner);
        expect(ready.status).toBe("ready");
        const verified = await db.query<{ object_checksum: string | null }>(
          "SELECT object_checksum FROM report_uploads WHERE id=$1",
          [row.id],
        );
        expect(verified.rows[0]?.object_checksum).toBe(
          createHash("sha256").update(bytes).digest("hex"),
        );
        await deleteReport(db, storage, report.id, owner.id);
      } finally {
        transient.close();
        replacementStorage.close();
        await replacementDb.end();
        await new Promise<void>((resolve, reject) =>
          unavailable.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }, 30000);
    storageCase("does not revive an upload when deletion overlaps object-store initialization", async () => {
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
