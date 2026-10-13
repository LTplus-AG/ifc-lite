/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import type { Config } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import type {
  ModelUpload,
  ReportSession,
  ReportReceipt,
  PartAuthorization,
} from "@ifc-lite/report-contract";
const enabled = Boolean(
  process.env.REPORT_TEST_DATABASE_URL && process.env.REPORT_TEST_S3_ENDPOINT,
);
if (process.env.REPORT_REQUIRE_INTEGRATION === "true" && !enabled)
  throw new Error(
    "Mandatory restart integration storage/database environment is missing",
  );
describe.skipIf(!enabled)("#7495 actual server process restart", () => {
  const schema = "report_restart_" + randomUUID().replace(/-/g, "");
  const admin = openDatabase(process.env.REPORT_TEST_DATABASE_URL ?? "");
  const url = new URL(
    process.env.REPORT_TEST_DATABASE_URL ?? "postgres://localhost/unused",
  );
  url.searchParams.set("options", `-c search_path=${schema}`);
  const config: Config = {
    submissionsEnabled: true,
    origin: "https://viewer.example.com",
    port: 0,
    databaseUrl: url.toString(),
    bucket: `restart-${randomUUID()}`,
    region: "us-east-1",
    endpoint: process.env.REPORT_TEST_S3_ENDPOINT,
    forcePathStyle: true,
    accessKeyId: process.env.REPORT_TEST_S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.REPORT_TEST_S3_SECRET_ACCESS_KEY ?? "",
    admissionSecret: randomUUID(),
    adminToken: randomUUID(),
    githubAppId: "unused",
    githubInstallationId: "unused",
    githubPrivateKey: "unused",
    githubRepository: "unused/unused",
    storageProvider: "Isolated local test store",
    storageLocation: "Local host",
    backupDisclosure: "No backups",
    agreement: {
      version: "unapproved",
      text: "",
      sha256: "",
      issuer: "LTplus AG",
      jurisdiction: "Switzerland",
      signingEnabled: false,
    },
    maxDailyReports: 10,
    maxDailyBytes: 1024 ** 3,
    maxStorageBytes: 1024 ** 3,
  };
  const db = openDatabase(config.databaseUrl);
  const storage = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const processes = new Set<ChildProcess>();
  let ownedBucketCreated = false;
  let ownedSchemaCreated = false;
  let base = "";
  async function launch(): Promise<ChildProcess> {
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(
          new URL("../scripts/restart-fixture.ts", import.meta.url),
        ),
      ],
      {
        env: { ...process.env, REPORT_RESTART_CONFIG: JSON.stringify(config) },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    processes.add(child);
    // Keep the owned child pipe drained without disclosing provider errors.
    child.stderr?.resume();
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("Restart fixture startup deadline")),
        10000,
      );
      child.once("exit", (code) => {
        clearTimeout(deadline);
        reject(new Error(`Fixture exited before ready (${code})`));
      });
      child.once("message", (message) => {
        clearTimeout(deadline);
        if (
          message &&
          typeof message === "object" &&
          "port" in message &&
          typeof message.port === "number"
        ) {
          base = `http://127.0.0.1:${message.port}/api/reports`;
          resolve();
        } else reject(new Error("Invalid fixture startup response"));
      });
      child.once("error", reject);
    });
    return child;
  }
  async function stop(
    child: ChildProcess,
    signal: "SIGKILL" | "SIGTERM",
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      processes.delete(child);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Fixture did not stop")),
        10000,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill(signal);
    });
    processes.delete(child);
  }
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    ownedSchemaCreated = true;
    await storage.send(new CreateBucketCommand({ Bucket: config.bucket }));
    ownedBucketCreated = true;
  });
  afterAll(async () => {
    // A failed assertion must not strand our multipart upload, model or bucket.
    // Only resources successfully created by this suite may be removed.
    const failures: string[] = [];
    const clean = async (label: string, operation: () => Promise<unknown>) => {
      try { await operation(); }
      catch { failures.push(label); }
    };
    for (const child of processes)
      await clean("owned child", () => stop(child, "SIGKILL"));
    if (ownedBucketCreated) {
      await clean("owned multipart uploads", async () => {
        for (let page = 0; page < 10; page++) {
          const result = await storage.send(new ListMultipartUploadsCommand({
            Bucket: config.bucket, MaxUploads: 1000,
          }));
          const uploads = result.Uploads ?? [];
          if (!uploads.length) return;
          for (const upload of uploads) {
            if (!upload.Key || !upload.UploadId)
              throw new Error("Incomplete owned upload identity");
            await storage.send(new AbortMultipartUploadCommand({
              Bucket: config.bucket, Key: upload.Key, UploadId: upload.UploadId,
            }));
          }
        }
        throw new Error("Owned multipart cleanup exceeded its bound");
      });
      await clean("owned objects", async () => {
        for (let page = 0; page < 10; page++) {
          const result = await storage.send(new ListObjectsV2Command({
            Bucket: config.bucket, MaxKeys: 1000,
          }));
          const objects = result.Contents ?? [];
          if (!objects.length) return;
          const deleted = await storage.send(new DeleteObjectsCommand({
            Bucket: config.bucket,
            Delete: { Objects: objects.map(object => {
              if (!object.Key) throw new Error("Missing owned object identity");
              return { Key: object.Key };
            }) },
          }));
          if (deleted.Errors?.length) throw new Error("Owned object deletion failed");
        }
        throw new Error("Owned object cleanup exceeded its bound");
      });
      await clean("owned bucket", () => storage.send(new DeleteBucketCommand({ Bucket: config.bucket })));
    }
    storage.destroy();
    await clean("owned database pool", () => db.end());
    if (ownedSchemaCreated)
      await clean("owned schema", () => admin.query(`DROP SCHEMA ${schema} CASCADE`));
    await clean("owned admin pool", () => admin.end());
    // Vitest retains the test failure separately; report cleanup failure too,
    // without replacing it or printing storage/provider-controlled details.
    if (failures.length) throw new Error(`Restart fixture cleanup failed: ${failures.join(", ")}`);
  });
  it("keeps the same cookie, report, multipart upload and checksums after a killed process", async () => {
    const first = await launch();
    const sessionResponse = await fetch(`${base}/session`);
    expect(sessionResponse.ok).toBe(true);
    const cookie = sessionResponse.headers.get("set-cookie")!.split(";")[0]!;
    const session = (await sessionResponse.json()) as ReportSession;
    const request = async (path: string, method = "GET", input?: unknown) =>
      fetch(base + path, {
        method,
        headers: {
          Cookie: cookie,
          Origin: config.origin,
          "X-CSRF-Token": session.csrfToken,
          "Content-Type": "application/json",
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
    const draftResponse = await request("/drafts", "POST", {
      clientRequestId: randomUUID(),
      title: "Restart fixture",
      description: "Reviewed public test evidence",
      diagnostics: {
        errorCode: "restart",
        appVersion: "test",
        buildSha: "test",
      },
      visibility: "private",
    });
    expect(draftResponse.ok).toBe(true);
    const report = (await draftResponse.json()) as ReportReceipt;
    const bytes = Buffer.alloc(16 * 1024 ** 2 + 83, 0x20);
    Buffer.from(
      "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;",
    ).copy(bytes);
    const uploadResponse = await request(`/${report.id}/uploads`, "POST", {
      name: "restart.ifc",
      size: bytes.length,
      type: "application/octet-stream",
      confidentiality: "none",
      uploadConsent: true,
    });
    expect(uploadResponse.ok).toBe(true);
    const upload = (await uploadResponse.json()) as ModelUpload;
    const prefix = `/${report.id}/uploads/${upload.id}`;
    async function putPart(number: number, chunk: Buffer): Promise<void> {
      const sha256 = createHash("sha256").update(chunk).digest("base64");
      const authorization = await request(`${prefix}/parts`, "POST", {
        partNumber: number,
        sha256,
      });
      expect(authorization.ok).toBe(true);
      const part = (await authorization.json()) as PartAuthorization;
      expect(
        (
          await fetch(part.url, {
            method: "PUT",
            headers: { "x-amz-checksum-sha256": sha256 },
            body: new Uint8Array(chunk),
          })
        ).ok,
      ).toBe(true);
    }
    await putPart(1, bytes.subarray(0, upload.partBytes));
    await stop(first, "SIGKILL");
    const second = await launch();
    expect(second.pid).not.toBe(first.pid);
    const resumedSession = await fetch(`${base}/session`, {
      headers: { Cookie: cookie },
    });
    expect(((await resumedSession.json()) as ReportSession).csrfToken).toBe(
      session.csrfToken,
    );
    expect(resumedSession.headers.get("set-cookie")).toBeNull();
    const resumed = await request(prefix);
    expect(resumed.ok).toBe(true);
    const state = (await resumed.json()) as ModelUpload;
    expect(state.id).toBe(upload.id);
    expect(state.uploadedParts).toHaveLength(1);
    expect(state.uploadedParts[0]?.sha256).toBe(
      createHash("sha256")
        .update(bytes.subarray(0, upload.partBytes))
        .digest("base64"),
    );
    await putPart(2, bytes.subarray(upload.partBytes));
    expect((await request(`${prefix}/complete`, "POST", {})).ok).toBe(true);
    let ready: ModelUpload | undefined;
    for (let i = 0; i < 100; i++) {
      ready = (await (await request(prefix)).json()) as ModelUpload;
      if (ready.status === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(ready?.status).toBe("ready");
    const rows = await db.query<{ object_checksum: string }>(
      "SELECT object_checksum FROM report_uploads WHERE id=$1",
      [upload.id],
    );
    expect(rows.rows[0]?.object_checksum).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect((await request(`/${report.id}`, "DELETE")).ok).toBe(true);
    await stop(second, "SIGTERM");
  }, 30000);
});
