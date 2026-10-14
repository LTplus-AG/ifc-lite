/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./database.js";
import { claimPublicScan, finishPublicScan } from "./public-quarantine.js";
import { scanSandbox, SCANNER_IMAGE_DIGEST } from "./scanner-sandbox.js";
import type { ScannerSource } from "./scanner-source.js";
import { removeScannerContainer } from "./scanner-process.js";
import { assertRestoreNotHeld } from "./restore-recovery.js";

/** Dormant one-job CLI boundary. Not started by the API or any deployment config. */
export async function scanPublicOnce(
  db: Db,
  source: ScannerSource,
  signatureDirectory: string,
  scratchDirectory: string,
  parentSignal: AbortSignal,
): Promise<"idle" | "review" | "held"> {
  await assertRestoreNotHeld(db);
  // A session-level lock limits all trusted orchestrators using this database,
  // without holding a report transaction during a large file read or scan.
  const lock = await db.connect();
  let acquired = false;
  let directory: string | undefined;
  let retainScratch = false;
  try {
    acquired = Boolean(
      (
        await lock.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext('report-public-scanner')) AS locked",
        )
      ).rows[0]?.locked,
    );
    if (!acquired) return "idle";
    await assertRestoreNotHeld(db);
    await mkdir(scratchDirectory, { recursive: true, mode: 0o700 });
    // Dedicated scanner-only scratch root. The shared DB lock excludes a live
    // owner; after a crash, remove its sandbox before admitting another scan.
    for (const entry of await readdir(scratchDirectory, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !/^job-[a-zA-Z0-9]+$/.test(entry.name))
        continue;
      const abandoned = join(scratchDirectory, entry.name);
      let name: string | undefined;
      try {
        name = await readFile(join(abandoned, "container"), "utf8");
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
      if (name) {
        if (!/^ifclite-scan-[a-f0-9-]{36}$/.test(name))
          throw new Error("scanner_scratch_invalid");
        await removeScannerContainer(name);
      }
      await rm(abandoned, { recursive: true, force: true });
    }
    const lease = await claimPublicScan(db);
    if (!lease) return "idle";
    const signal = AbortSignal.any([
      parentSignal,
      AbortSignal.timeout(15 * 60 * 1000),
    ]);
    directory = await mkdtemp(join(scratchDirectory, "job-"));
    const model = join(directory, "model.ifc");
    try {
      await source.download(lease, model, signal);
      const evidence = await scanSandbox(
        lease,
        model,
        signatureDirectory,
        directory,
        signal,
      );
      await assertRestoreNotHeld(db);
      return (await finishPublicScan(db, lease, evidence, SCANNER_IMAGE_DIGEST))
        ? "review"
        : "held";
    } catch (error) {
      // Only enumerated categories reach logs, never raw provider/process text.
      const categories = new Set([
        "scanner_signatures_invalid",
        "scanner_signatures_stale",
        "scanner_cleanup_failed",
        "scanner_source_invalid",
        "scanner_source_changed",
        "scanner_format_unsupported",
        "scanner_process_unavailable",
        "scanner_process_interrupted",
      ]);
      const category =
        error instanceof Error && categories.has(error.message)
          ? error.message
          : "scanner_job_failed";
      // A failed Docker removal may leave the sandbox alive. Keep its opaque
      // recovery marker until the next owner verifies removal before cleanup.
      retainScratch = category === "scanner_cleanup_failed";
      console.error(`[report-service] ${category}`);
      // A crash, unavailable engine/signatures or transport failure leaves the
      // durable lease for bounded retry. Deletion/withdrawal independently revoke it.
      return "held";
    }
  } finally {
    try {
      if (directory && !retainScratch) await rm(directory, { recursive: true, force: true });
    } finally {
      try {
        if (acquired)
          await lock.query(
            "SELECT pg_advisory_unlock(hashtext('report-public-scanner'))",
          );
      } finally {
        lock.release();
      }
    }
  }
}
