/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolve } from "node:path";
import { isMainEntry } from "../../../scripts/lib/is-main-entry.mjs";
import { openDatabase } from "../src/database.js";
import { ScannerSource } from "../src/scanner-source.js";
import { scanPublicOnce } from "../src/scanner-worker.js";
import { updateScannerSignatures } from "../src/scanner-signatures.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("scanner_configuration_missing");
  return value;
}
async function main(): Promise<void> {
  const stop = new AbortController();
  const cancel = () => stop.abort();
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  try {
    const signatures = resolve(required("REPORT_SCANNER_SIGNATURE_DIRECTORY"));
    if (process.argv[2] === "update-signatures") {
      await updateScannerSignatures(signatures, stop.signal);
      console.log("scanner_signatures_updated");
      return;
    }
    if (process.argv[2] !== "scan-once")
      throw new Error("scanner_command_required");
    const db = openDatabase(required("REPORT_DATABASE_URL"));
    const source = new ScannerSource({
      bucket: required("REPORT_S3_BUCKET"),
      region: required("REPORT_S3_REGION"),
      endpoint: process.env.REPORT_S3_ENDPOINT,
      forcePathStyle: process.env.REPORT_S3_FORCE_PATH_STYLE === "true",
      accessKeyId: required("REPORT_S3_ACCESS_KEY_ID"),
      secretAccessKey: required("REPORT_S3_SECRET_ACCESS_KEY"),
    });
    try {
      console.log(
        `scanner_${await scanPublicOnce(db, source, signatures, resolve(required("REPORT_SCANNER_SCRATCH_DIRECTORY")), stop.signal)}`,
      );
    } finally {
      source.close();
      await db.end();
    }
  } finally {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
}
if (isMainEntry(import.meta.url))
  void main().catch(() => {
    console.error("scanner_operation_failed");
    process.exitCode = 1;
  });
