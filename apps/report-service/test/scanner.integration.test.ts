/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, readdir, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { qualifyMaxModel } from "./scanner-max-model.js";
import { scannerChild, runningContainer, cleanScannerScratch, docker } from "./scanner-child.js";
import { loadFeature } from "./feature-loader.js";
import { scannerChild, cleanScannerScratch } from "./scanner-child.js";
import { openDatabase, migrate } from "../src/database.js";
import { createReport, submitReport } from "../src/reports.js";
import { ModelStorage } from "../src/storage.js";
import { startUpload, authorizePart, uploadRow } from "../src/uploads.js";
import { completeUpload, verifyNext } from "../src/verification.js";
import { deleteReport } from "../src/maintenance.js";
import { withdrawPublicModel } from "../src/public-release.js";
import {
  PUBLIC_SCAN_POLICY,
  type ScanLease,
} from "../src/public-quarantine.js";
import type { Config } from "../src/config.js";

const enabled = Boolean(
  process.env.REPORT_TEST_DATABASE_URL && process.env.REPORT_TEST_S3_ENDPOINT,
);
const signatures = process.env.REPORT_SCANNER_SIGNATURE_DIRECTORY;
if (process.env.REPORT_REQUIRE_INTEGRATION === "true" && !enabled)
  throw new Error("Mandatory scanner storage fixtures missing");
if (process.env.REPORT_REQUIRE_SCANNER === "true" && (!enabled || !signatures))
  throw new Error("Mandatory real scanner fixtures missing");
const step = Buffer.from(
  "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!enabled)(
  "#7495 isolated scanner source and real-engine acceptance",
  () => {
    const owner = {
      id: randomUUID(),
      csrf: "fixture",
      admission: randomUUID(),
    };
    const bucket = `scanner-${randomUUID()}`;
    const schema = "scanner_" + randomUUID().replace(/-/g, "");
    const admin = openDatabase(process.env.REPORT_TEST_DATABASE_URL ?? "");
    const url = new URL(
      process.env.REPORT_TEST_DATABASE_URL ?? "postgres://localhost/unused",
    );
    url.searchParams.set("options", `-c search_path=${schema}`);
    const config: Config = {
      submissionsEnabled: true,
      storageProvider: "Local S3 fixture",
      storageLocation: "Development host",
      backupDisclosure: "No backups",
      origin: "https://viewer.example.com",
      port: 3005,
      databaseUrl: url.toString(),
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
      maxDailyReports: 100,
      maxDailyBytes: 2 * 1024 ** 3,
      maxStorageBytes: 2 * 1024 ** 3,
      agreement: {
        version: "unapproved",
        sha256: "a".repeat(64),
        text: "DRAFT",
        issuer: "LTplus AG",
        jurisdiction: "Switzerland",
        signingEnabled: false,
      },
    };
    const db = openDatabase(config.databaseUrl);
    const storage = new ModelStorage(config);
    const s3 = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    let sourceModule: typeof import("../src/scanner-source.js") | undefined;
    let workerModule: typeof import("../src/scanner-worker.js") | undefined;
    let source:
      | InstanceType<NonNullable<typeof sourceModule>["ScannerSource"]>
      | undefined;
    let temporary = "";
    const reports: string[] = [];
    const keys: string[] = [];
    let initialized = false;
    beforeAll(async () => {
      sourceModule = await loadFeature(
        "../src/scanner-source.js",
        () => import("../src/scanner-source.js"),
      );
      workerModule = await loadFeature(
        "../src/scanner-worker.js",
        () => import("../src/scanner-worker.js"),
      );
      temporary = await mkdtemp(join(tmpdir(), "scanner-test-"));
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(db);
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      initialized = true;
      if (sourceModule) source = new sourceModule.ScannerSource(config);
    });
    afterEach(async () => {
      for (const id of reports.splice(0))
        await deleteReport(db, storage, id, owner.id);
    });
    afterAll(async () => {
      try {
        if (initialized) {
          for (const key of keys)
            await s3.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: key }),
            );
          await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        }
      } finally {
        source?.close();
        storage.close();
        s3.destroy();
        await db.end();
        await admin.end();
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
    });
    async function object(bytes: Buffer): Promise<ScanLease> {
      const key = `private/${randomUUID()}`;
      keys.push(key);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ServerSideEncryption: "AES256",
        }),
      );
      return {
        reportId: randomUUID(),
        uploadId: randomUUID(),
        leaseId: randomUUID(),
        objectKey: key,
        sha256: sha(bytes),
        byteSize: bytes.length,
        policyVersion: PUBLIC_SCAN_POLICY,
      };
    }
    function destination() {
      return join(temporary, randomUUID());
    }
    function api() {
      expect(
        source,
        "Exact-byte scanner download must be implemented",
      ).toBeDefined();
      return source!;
    }
    it("#7495 scanner downloads exact real S3 bytes and rejects same-size changes, truncation and unsupported formats", async () => {
      const lease = await object(step);
      const path = destination();
      await api().download(lease, path, AbortSignal.timeout(10000));
      expect(await readFile(path)).toEqual(step);
      const changed = Buffer.from(step);
      changed[changed.indexOf("DATA")] = 88;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: lease.objectKey,
          Body: changed,
          ServerSideEncryption: "AES256",
        }),
      );
      await expect(
        api().download(lease, destination(), AbortSignal.timeout(10000)),
      ).rejects.toThrow("scanner_source_changed");
      for (const bytes of [
        Buffer.from("PK\x03\x04disguised.ifc"),
        step.subarray(0, step.length - 15),
        Buffer.concat([step, Buffer.from([0])]),
      ]) {
        const invalid = await object(bytes);
        await expect(
          api().download(invalid, destination(), AbortSignal.timeout(10000)),
        ).rejects.toThrow(/scanner_(format_unsupported|source_invalid)/);
      }
      await expect(
        api().download(
          { ...lease, byteSize: 1024 ** 3 + 1 },
          destination(),
          AbortSignal.timeout(10000),
        ),
      ).rejects.toThrow("scanner_source_invalid");
    });
    it("#7495 abort prevents materializing a model for the untrusted scanner", async () => {
      const lease = await object(step);
      const path = destination();
      await expect(
        api().download(lease, path, AbortSignal.abort()),
      ).rejects.toThrow();
      expect(existsSync(path)).toBe(false);
    });
    async function queue(bytes: Buffer) {
      const report = await createReport(db, config, owner, {
        clientRequestId: randomUUID(),
        title: "Reviewed scanner fixture",
        description: "Explicit synthetic/public acceptance",
        diagnostics: {
          errorCode: "fixture",
          appVersion: "test",
          buildSha: "test",
        },
        visibility: "public",
      });
      reports.push(report.id);
      const upload = await startUpload(db, storage, config, report.id, owner, {
        name: "private-source-name.ifc",
        size: bytes.length,
        type: "application/octet-stream",
        confidentiality: "none",
        uploadConsent: true,
        publicModelConfirmed: true,
        publicSharingConsent: {
          version: "public-model-v1",
          authorityConfirmed: true,
          redistributionReviewed: true,
          confidentialContentReviewed: true,
          downloadedCopiesCannotBeRecalled: true,
          publishDownloadLink: true,
        },
      });
      const checksum = createHash("sha256").update(bytes).digest("base64");
      const signed = await authorizePart(
        db,
        storage,
        await uploadRow(db, report.id, upload.id, owner),
        1,
        checksum,
      );
      expect(
        (
          await fetch(signed.url, {
            method: "PUT",
            body: Uint8Array.from(bytes),
            headers: { "x-amz-checksum-sha256": checksum },
          })
        ).status,
      ).toBe(200);
      await completeUpload(
        db,
        storage,
        await uploadRow(db, report.id, upload.id, owner),
        owner,
      );
      await verifyNext(db, storage);
      await submitReport(db, report.id, owner, true);
      return report.id;
    }
    it("#7495 restore hold prevents scanner claim and model materialization", async () => {
      expect(workerModule).toBeDefined();
      const id = await queue(step);
      const scratch = join(temporary, "scratch-restore-held");
      await db.query(`CREATE TABLE report_restore_hold (
        singleton boolean PRIMARY KEY, held boolean NOT NULL
      ); INSERT INTO report_restore_hold VALUES(true,true)`);
      try {
        await expect(workerModule!.scanPublicOnce(
          db, api(), join(temporary, "no-signatures"), scratch,
          new AbortController().signal,
        )).rejects.toThrow("report_restore_held");
        const job = (await db.query(
          "SELECT scan,attempts,lease_id FROM report_public_quarantine WHERE report_id=$1", [id],
        )).rows[0];
        expect(job).toMatchObject({ scan: null, attempts: 0, lease_id: null });
        expect(existsSync(scratch)).toBe(false);
      } finally {
        await db.query("DROP TABLE report_restore_hold");
      }
    });
    it("#7495 missing real signatures holds the durable job without fabricated clearance and cleans scratch", async () => {
      expect(workerModule, "Trusted scanner worker must exist").toBeDefined();
      const id = await queue(step);
      const scratch = join(temporary, "scratch-missing");
      expect(
        await workerModule!.scanPublicOnce(
          db,
          api(),
          join(temporary, "no-signatures"),
          scratch,
          new AbortController().signal,
        ),
      ).toBe("held");
      const job = (
        await db.query(
          "SELECT state,scan,attempts FROM report_public_quarantine WHERE report_id=$1",
          [id],
        )
      ).rows[0];
      expect(job).toMatchObject({ state: "scanning", scan: null, attempts: 1 });
      expect(await readdir(scratch)).toEqual([]);
    });
    it("#7521 actual scanner CLI reports idle with exit zero", async () => {
      const scratch = join(temporary, "cli-idle");
      const child = scannerChild(config, join(temporary, "no-signatures"), scratch, 15000);
      try {
        expect(await child.done).toEqual({ code: 0, signal: null, output: "scanner_idle\n" });
        expect(await readdir(scratch)).toEqual([]);
      } finally {
        if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
        await Promise.allSettled([child.done]);
        await cleanScannerScratch(scratch);
      }
    }, 20000);
    it("#7521 actual scanner CLI reports a held signature failure with nonzero exit", async () => {
      const id = await queue(step);
      const scratch = join(temporary, "cli-held");
      const child = scannerChild(config, join(temporary, "no-signatures"), scratch, 15000);
      try {
        const result = await child.done;
        expect(result).toMatchObject({ code: 1, signal: null });
        expect(result.output.split("\n")).toContain("scanner_held");
        expect(result.output).toContain("[report-service] scanner_job_failed");
        expect((await db.query("SELECT state,scan,attempts FROM report_public_quarantine WHERE report_id=$1", [id])).rows[0])
          .toEqual({ state: "scanning", scan: null, attempts: 1 });
        expect(await readdir(scratch)).toEqual([]);
      } finally {
        if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
        await Promise.allSettled([child.done]);
        await cleanScannerScratch(scratch);
      }
    }, 20000);
    describe.skipIf(!signatures)(
      "actual pinned ClamAV engine (never synthetic attestation)",
      () => {
        const model = resolve("../../tests/models/ara3d/AC20-FZK-Haus.ifc");
        it.skipIf(!existsSync(model))(
          "#7495 real authoring-tool FZK reaches review, never automatic approval (pnpm fixtures)",
          async () => {
            expect(workerModule).toBeDefined();
            const bytes = await readFile(model);
            const id = await queue(bytes);
            expect(
              await workerModule!.scanPublicOnce(
                db,
                api(),
                signatures!,
                join(temporary, "scratch-clean"),
                new AbortController().signal,
              ),
            ).toBe("review");
            const job = (
              await db.query(
                "SELECT state,scan FROM report_public_quarantine WHERE report_id=$1",
                [id],
              )
            ).rows[0];
            expect(job.state).toBe("review");
            expect(job.scan).toMatchObject({
              outcome: "clean",
              complete: true,
              sha256: sha(bytes),
              byteSize: bytes.length,
            });
          },
          120000,
        );
        it.skipIf(!existsSync(model))(
          "#7521 actual scanner CLI reports real authoring-tool review with exit zero (pnpm fixtures)",
          async () => {
            const bytes = await readFile(model); const id = await queue(bytes);
            const scratch = join(temporary, "cli-review");
            const child = scannerChild(config, signatures!, scratch);
            try {
              expect(await child.done).toEqual({ code: 0, signal: null, output: "scanner_review\n" });
              expect((await db.query("SELECT state,scan,approval,attempts FROM report_public_quarantine WHERE report_id=$1", [id])).rows[0])
                .toMatchObject({ state: "review", approval: null, attempts: 1,
                  scan: { sha256: sha(bytes), byteSize: bytes.length, outcome: "clean", complete: true } });
              expect(await readdir(scratch)).toEqual([]);
            } finally {
              if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
              await Promise.allSettled([child.done]);
              await cleanScannerScratch(scratch);
            }
          }, 125000,
        );
        it.skipIf(!existsSync(model))(
          "#7521 unverified sandbox removal retains its marker until real worker recovery (pnpm fixtures)",
          async () => {
            expect(workerModule).toBeDefined();
            const id = await queue(await readFile(model));
            const scratch = join(temporary, "scratch-cleanup-failure");
            const tools = join(temporary, "cleanup-failure-tools");
            const originalPath = process.env.PATH;
            const executable = (await promisify(execFile)("which", ["docker"], { timeout: 10000 })).stdout.trim();
            expect(executable.startsWith("/")).toBe(true);
            const quotedExecutable = "'" + executable.replaceAll("'", "'\\''") + "'";
            await mkdir(tools, { mode: 0o700 });
            // Only removal fails. The real pinned engine still scans the real
            // authoring-tool model; no scan verdict or storage response is mocked.
            await writeFile(join(tools, "docker"),
              "#!/bin/sh\nif [ \"$1\" = rm ]; then echo injected_cleanup_failure >&2; exit 1; fi\nexec " + quotedExecutable + " \"$@\"\n",
              { mode: 0o700 });
            try {
              process.env.PATH = tools + ":" + (originalPath ?? "/usr/bin:/bin");
              try {
                expect(await workerModule!.scanPublicOnce(db, api(), signatures!, scratch, AbortSignal.timeout(120000)))
                  .toBe("held");
              } finally {
                if (originalPath === undefined) delete process.env.PATH;
                else process.env.PATH = originalPath;
              }
              const jobs = await readdir(scratch);
              expect(jobs).toHaveLength(1);
              expect(jobs[0]).toMatch(/^job-[a-zA-Z0-9]+$/);
              const marker = await readFile(join(scratch, jobs[0], "container"), "utf8");
              expect(marker.length).toBeGreaterThan(0);
              const held = (await db.query(
                "SELECT state,scan,approval,attempts FROM report_public_quarantine WHERE report_id=$1", [id],
              )).rows[0];
              expect(held).toEqual({ state: "scanning", scan: null, approval: null, attempts: 1 });
              // The ordinary worker verifies/removes the recorded owned sandbox
              // before considering its still-live lease; no second scan is run.
              expect(await workerModule!.scanPublicOnce(db, api(), signatures!, scratch, AbortSignal.timeout(15000)))
                .toBe("idle");
              expect(await readdir(scratch)).toEqual([]);
              expect((await db.query(
                "SELECT state,scan,approval,attempts FROM report_public_quarantine WHERE report_id=$1", [id],
              )).rows[0]).toEqual(held);
            } finally {
              if (originalPath === undefined) delete process.env.PATH;
              else process.env.PATH = originalPath;
              // Failed assertions still retire only this fixture's recorded
              // sandboxes through the production verifier, never a global prune.
              if (existsSync(scratch)) {
                for (const entry of await readdir(scratch)) {
                  if (!/^job-[a-zA-Z0-9]+$/.test(entry)) continue;
                  const directory = join(scratch, entry);
                  const name = await readFile(join(directory, "container"), "utf8");
                  const { removeScannerContainer } = await import("../src/scanner-process.js");
                  await removeScannerContainer(name);
                  await rm(directory, { recursive: true, force: true });
                }
              }
            }
          }, 150000,
        );
        it.skipIf(!existsSync(model) || process.env.REPORT_SCANNER_MAX_MODEL !== "true")(
          "#7495 selected exact 1 GiB model reaches real scanner review without changing caps (pnpm fixtures)",
          async () => {
            await qualifyMaxModel({ db, storage, config, owner, signatures: signatures!,
              model, temporary, trackReport: (id) => reports.push(id) });
          }, 20 * 60 * 1000,
        );
        it.skipIf(!existsSync(model))(
          "#7495 actual scanner container death never attests clean and removes scratch (pnpm fixtures)",
          async () => {
            const id = await queue(await readFile(model));
            const scratch = join(temporary, `scratch-container-death-${randomUUID()}`);
            const orchestrator = scannerChild(config, signatures!, scratch);
            try {
              const container = await runningContainer(scratch);
              expect(orchestrator.child.exitCode).toBeNull();
              expect(orchestrator.child.signalCode).toBeNull();
              await docker(["kill", "--signal=KILL", container]);
              expect(await orchestrator.done).toMatchObject({
                code: 1, signal: null, output: "scanner_held\n",
              });
              expect((await db.query(
                "SELECT state,scan,approval,attempts FROM report_public_quarantine WHERE report_id=$1", [id],
              )).rows[0]).toMatchObject({ state: "blocked", scan: null, approval: null, attempts: 1 });
              await expect(docker(["inspect", container])).rejects.toThrow(/No such object/);
              expect(await readdir(scratch)).toEqual([]);
            } finally {
              if (orchestrator.child.exitCode === null && orchestrator.child.signalCode === null) orchestrator.child.kill("SIGKILL");
              await Promise.allSettled([orchestrator.done]);
              await cleanScannerScratch(scratch);
            }
          }, 120000,
        );
        for (const withdraw of [false, true]) {
          it.skipIf(!existsSync(model))(
            `#7495 actual orchestrator SIGKILL cleans orphan and ${withdraw ? "preserves withdrawal" : "retries only an expired durable lease"} (pnpm fixtures)`,
            async () => {
              const bytes = await readFile(model);
              const id = await queue(bytes);
              const scratch = join(temporary, `scratch-crash-${randomUUID()}`);
              const first = scannerChild(config, signatures!, scratch);
              const children = [first];
              const restart = () => {
                const child = scannerChild(config, signatures!, scratch);
                children.push(child);
                return child.done;
              };
              let container: string | undefined;
              try {
                container = await runningContainer(scratch);
                const before = (await db.query(
                  "SELECT state,scan,attempts,lease_id FROM report_public_quarantine WHERE report_id=$1", [id],
                )).rows[0];
                expect(before).toMatchObject({ state: "scanning", scan: null, attempts: 1 });
                expect(before.lease_id).toBeTruthy();
                first.child.kill("SIGKILL");
                expect((await first.done).signal).toBe("SIGKILL");
                // Docker owns the running sandbox; killing its orchestrator must
                // actually leave it alive, otherwise this is not a crash witness.
                expect((await docker(["inspect", "--format", "{{.State.Running}}", container])).stdout.trim()).toBe("true");
                expect((await readdir(scratch)).length).toBe(1);
                if (withdraw) await withdrawPublicModel(db, id, owner.id);
                const restarted = await restart();
                expect(restarted).toMatchObject({ code: 0, signal: null, output: "scanner_idle\n" });
                await expect(docker(["inspect", container])).rejects.toThrow(/No such object/);
                expect(await readdir(scratch)).toEqual([]);
                const held = (await db.query(
                  "SELECT state,scan,attempts,lease_id FROM report_public_quarantine WHERE report_id=$1", [id],
                )).rows[0];
                if (withdraw) {
                  expect(held).toMatchObject({ state: "revoked", scan: null, attempts: 1, lease_id: null });
                  return;
                }
                expect(held).toEqual(before);
                // Advance only this fixture's durable deadline; no claim of a
                // twenty-minute wall-clock wait or synthetic engine verdict.
                await db.query("UPDATE report_public_quarantine SET lease_until=now()-interval '1 second' WHERE report_id=$1", [id]);
                expect(await restart()).toMatchObject({
                  code: 0, signal: null, output: "scanner_review\n",
                });
                const retried = (await db.query(
                  "SELECT state,scan,attempts,lease_id,approval FROM report_public_quarantine WHERE report_id=$1", [id],
                )).rows[0];
                expect(retried).toMatchObject({ state: "review", attempts: 2, approval: null,
                  scan: { sha256: sha(bytes), byteSize: bytes.length, outcome: "clean", complete: true } });
                expect(retried.lease_id).not.toBe(before.lease_id);
                expect(await readdir(scratch)).toEqual([]);
              } finally {
                for (const spawned of children) {
                  if (spawned.child.exitCode === null && spawned.child.signalCode === null) spawned.child.kill("SIGKILL");
                }
                await Promise.allSettled(children.map((spawned) => spawned.done));
                await cleanScannerScratch(scratch);
                if (container) {
                  const owned = await docker(["ps", "-aq", "--filter", `name=^/${container}$`]);
                  if (owned.stdout.trim()) await docker(["rm", "-f", container]);
                }
              }
            }, 180000,
          );
        }
        it("#7495 canonical EICAR cannot enter the public STEP pipeline", async () => {
          expect(workerModule).toBeDefined();
          // Harmless industry-standard AV test string; never execute it.
          const eicar =
            "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
          // ClamAV whole-file EICAR semantics do not cover arbitrary STEP comments.
          // The direct engine control lives in scanner-engine.test.ts.
          const bytes = Buffer.from(eicar);
          const id = await queue(bytes);
          expect(
            await workerModule!.scanPublicOnce(
              db,
              api(),
              signatures!,
              join(temporary, "scratch-infected"),
              new AbortController().signal,
            ),
          ).toBe("held");
          expect(
            (
              await db.query(
                "SELECT state,scan FROM report_public_quarantine WHERE report_id=$1",
                [id],
              )
            ).rows[0],
          ).toMatchObject({ state: "scanning", scan: null });
        }, 120000);
        it("#7495 withdrawal while the actual engine reads never revives public eligibility", async () => {
          expect(workerModule).toBeDefined();
          const id = await queue(step);
          const scratch = join(temporary, "scratch-withdrawn");
          const scanning = workerModule!.scanPublicOnce(
            db,
            api(),
            signatures!,
            scratch,
            new AbortController().signal,
          );
          for (let attempt = 0; attempt < 100; attempt++) {
            const state = (
              await db.query(
                "SELECT state FROM report_public_quarantine WHERE report_id=$1",
                [id],
              )
            ).rows[0]?.state;
            if (state === "scanning") break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          await withdrawPublicModel(db, id, owner.id);
          expect(await scanning).toBe("held");
          expect(
            (
              await db.query(
                "SELECT state,scan FROM report_public_quarantine WHERE report_id=$1",
                [id],
              )
            ).rows[0],
          ).toMatchObject({ state: "revoked", scan: null });
          expect(await readdir(scratch)).toEqual([]);
        }, 120000);
      },
    );
  },
);
