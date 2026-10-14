/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import type { Config } from "../src/config.js";
import type { Db } from "../src/database.js";
import type { ModelStorage } from "../src/storage.js";
import type { Session } from "../src/sessions.js";
import { createReport, submitReport } from "../src/reports.js";
import { startUpload, authorizePart, uploadRow } from "../src/uploads.js";
import { completeUpload, verifyNext } from "../src/verification.js";
import { PUBLIC_MAX_BYTES } from "../src/public-quarantine.js";
import { scannerChild, runningContainer, cleanScannerScratch, docker } from "./scanner-child.js";

/** Preserve the catalogued IFC entities and add only a STEP block comment.
 * The largest allocation is one ordinary upload part, never the whole model. */
function* paddedParts(model: Buffer, size: number): Generator<Buffer> {
  const data = model.indexOf("DATA;");
  if (data < 0 || model.includes(0)) throw new Error("Invalid public model fixture");
  const prefix = Buffer.concat([model.subarray(0, data + 5), Buffer.from("\n/* scanner size qualification\n")]);
  const suffix = Buffer.concat([Buffer.from("\n*/\n"), model.subarray(data + 5)]);
  if (prefix.length + suffix.length >= size) throw new Error("Fixture exceeds selected size");
  const suffixStart = size - suffix.length;
  for (let offset = 0; offset < size; offset += 16 * 1024 ** 2) {
    const part = Buffer.alloc(Math.min(16 * 1024 ** 2, size - offset), 32);
    if (offset < prefix.length) prefix.copy(part, 0, offset, offset + part.length);
    const start = Math.max(offset, suffixStart);
    if (start < offset + part.length)
      suffix.copy(part, start - offset, start - suffixStart, offset + part.length - suffixStart);
    yield part;
  }
}

export async function qualifyMaxModel(context: {
  db: Db; storage: ModelStorage; config: Config; owner: Session;
  signatures: string; model: string; temporary: string; trackReport(id: string): void;
}) {
  const { db, storage, config, owner } = context;
  const started = Date.now();
  let peakHarnessRss = process.memoryUsage().rss;
  const sampling = setInterval(() => {
    peakHarnessRss = Math.max(peakHarnessRss, process.memoryUsage().rss);
  }, 250);
  const scratch = join(context.temporary, `scratch-max-${randomUUID()}`);
  let child: ReturnType<typeof scannerChild> | undefined;
  try {
    expect(PUBLIC_MAX_BYTES).toBe(1024 ** 3);
    const report = await createReport(db, config, owner, {
      clientRequestId: randomUUID(), title: "Maximum-size public scanner fixture",
      description: "Catalogued FZK with STEP comment padding; explicitly synthetic size qualification.",
      diagnostics: { errorCode: "fixture", appVersion: "test", buildSha: "test" }, visibility: "public",
    });
    context.trackReport(report.id);
    const upload = await startUpload(db, storage, config, report.id, owner, {
      name: "scanner-size-fixture.ifc", size: PUBLIC_MAX_BYTES, type: "application/octet-stream",
      confidentiality: "none", uploadConsent: true, publicModelConfirmed: true,
      publicSharingConsent: { version: "public-model-v1", authorityConfirmed: true,
        redistributionReviewed: true, confidentialContentReviewed: true,
        downloadedCopiesCannotBeRecalled: true, publishDownloadLink: true },
    });
    const hash = createHash("sha256");
    let byteSize = 0;
    let number = 0;
    for (const bytes of paddedParts(await readFile(context.model), PUBLIC_MAX_BYTES)) {
      hash.update(bytes);
      byteSize += bytes.length;
      const checksum = createHash("sha256").update(bytes).digest("base64");
      const signed = await authorizePart(db, storage,
        await uploadRow(db, report.id, upload.id, owner), ++number, checksum);
      const put = await fetch(signed.url, { method: "PUT", body: Uint8Array.from(bytes),
        signal: AbortSignal.timeout(60000), headers: { "x-amz-checksum-sha256": checksum } });
      expect(put.status).toBe(200);
      await put.body?.cancel();
    }
    const sha256 = hash.digest("hex");
    expect(byteSize).toBe(PUBLIC_MAX_BYTES);
    expect(number).toBe(64);
    await completeUpload(db, storage, await uploadRow(db, report.id, upload.id, owner), owner);
    await verifyNext(db, storage);
    expect(await uploadRow(db, report.id, upload.id, owner)).toMatchObject({
      status: "ready", object_checksum: sha256,
    });
    await submitReport(db, report.id, owner, true);
    // The worker retains its actual 15-minute deadline; the extra 30 seconds
    // only allows process startup/shutdown, not extra sandbox scan time.
    child = scannerChild(config, context.signatures, scratch, 15 * 60 * 1000 + 30000);
    const container = await runningContainer(scratch);
    const limits = JSON.parse((await docker(["inspect", "--format", "{{json .HostConfig}}", container])).stdout);
    expect(limits).toMatchObject({ NanoCpus: 1000000000, Memory: 4 * 1024 ** 3,
      MemorySwap: 4 * 1024 ** 3, NetworkMode: "none", ReadonlyRootfs: true });
    expect(await child.done).toMatchObject({ code: 0, signal: null, output: "scanner_review\n" });
    expect((await db.query(
      "SELECT state,scan,approval,attempts FROM report_public_quarantine WHERE report_id=$1", [report.id],
    )).rows[0]).toMatchObject({ state: "review", approval: null, attempts: 1,
      scan: { sha256, byteSize, outcome: "clean", complete: true } });
    expect(await readdir(scratch)).toEqual([]);
    await expect(docker(["inspect", container])).rejects.toThrow(/No such object/);
    console.info("scanner_max_model_qualification", JSON.stringify({
      byteSize, sha256, parts: number, elapsedMs: Date.now() - started,
      peakHarnessRss, sandboxMemoryLimit: limits.Memory, sandboxNanoCpus: limits.NanoCpus,
      resourceScope: "Harness RSS excludes Docker engine; elapsed time is observational, not a performance comparison.",
    }));
  } finally {
    clearInterval(sampling);
    if (child) {
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
      await Promise.allSettled([child.done]);
    }
    await cleanScannerScratch(scratch);
  }
}
