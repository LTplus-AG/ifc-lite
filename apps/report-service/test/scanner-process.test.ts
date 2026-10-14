/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadFeature } from "./feature-loader.js";

// These real child-process fixtures exercise the process boundary only. They
// are not a ClamAV substitute and never produce malware-clearance evidence.
let temporary: string;
let originalPath: string | undefined;
let originalSecret: string | undefined;
let feature: typeof import("../src/scanner-process.js") | undefined;
beforeEach(async () => {
  feature = await loadFeature(
    "../src/scanner-process.js",
    () => import("../src/scanner-process.js"),
  );
  temporary = await mkdtemp(join(tmpdir(), "scanner-process-"));
  originalPath = process.env.PATH;
  originalSecret = process.env.REPORT_DATABASE_URL;
  process.env.PATH = temporary;
  process.env.REPORT_DATABASE_URL = "private-sentinel-must-not-reach-process";
});
afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalSecret === undefined) delete process.env.REPORT_DATABASE_URL;
  else process.env.REPORT_DATABASE_URL = originalSecret;
  await rm(temporary, { recursive: true, force: true });
});
async function executable(body: string) {
  await writeFile(join(temporary, "docker"), `#!/bin/sh\n${body}\n`, {
    mode: 0o700,
  });
  expect(
    feature,
    "The bounded credential-free process boundary must exist",
  ).toBeDefined();
  return feature!;
}
it("#7495 subprocesses do not inherit application credentials", async () => {
  const api = await executable(
    'if [ -n "$REPORT_DATABASE_URL" ]; then printf "private-env-leaked"; exit 8; fi; printf "credential-free"',
  );
  const result = await api.scannerProcess([], AbortSignal.timeout(2000));
  expect(result.code).toBe(0);
  expect(result.output).not.toContain("private-sentinel");
});
it("#7495 subprocess output overflow is interrupted without returning raw output", async () => {
  const api = await executable("/usr/bin/head -c 70000 /dev/zero");
  await expect(
    api.scannerProcess([], AbortSignal.timeout(2000)),
  ).rejects.toThrow("scanner_process_interrupted");
});
it("#7495 abort terminates a live subprocess and refuses arbitrary container cleanup names", async () => {
  const api = await executable("exec /bin/sleep 10");
  await expect(api.scannerProcess([], AbortSignal.timeout(30))).rejects.toThrow(
    "scanner_process_interrupted",
  );
  await expect(api.removeScannerContainer("foreign-service")).rejects.toThrow(
    "scanner_container_invalid",
  );
});
it("#7521 missing Docker during cleanup remains an unverified-removal failure", async () => {
  expect(feature, "The real cleanup boundary must exist").toBeDefined();
  // beforeEach supplies a genuinely empty executable directory.
  await expect(feature!.removeScannerContainer("ifclite-scan-00000000-0000-0000-0000-000000000001"))
    .rejects.toThrow("scanner_cleanup_failed");
});
it("#7521 cleanup output overflow retains the unverified-removal category", async () => {
  const api = await executable("/usr/bin/head -c 70000 /dev/zero");
  await expect(api.removeScannerContainer("ifclite-scan-00000000-0000-0000-0000-000000000002"))
    .rejects.toThrow("scanner_cleanup_failed");
});
