/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SCANNER_IMAGE } from "./scanner-sandbox.js";
import { scannerProcess, removeScannerContainer } from "./scanner-process.js";

/** Network-enabled update container receives NO models, application secrets or Docker socket. */
export async function updateScannerSignatures(
  destination: string,
  parentSignal: AbortSignal,
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "ifclite-signatures-"));
  const name = `ifclite-signatures-${randomUUID()}`;
  const signal = AbortSignal.any([
    parentSignal,
    AbortSignal.timeout(15 * 60 * 1000),
  ]);
  try {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const config = join(temporary, "freshclam.conf");
    await writeFile(
      config,
      "DatabaseDirectory /signatures\nDatabaseMirror database.clamav.net\nScriptedUpdates no\nTestDatabases yes\nForeground yes\n",
      { mode: 0o444 },
    );
    await chmod(temporary, 0o755);
    const updated = await scannerProcess(
      [
        "run",
        "--rm",
        "--pull=never",
        "--name",
        name,
        "--label",
        "ifclite.report-scanner=true",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        `--user=${process.getuid?.() ?? 65534}:${process.getgid?.() ?? 65534}`,
        "--cpus=1",
        "--memory=4g",
        "--memory-swap=4g",
        "--pids-limit=64",
        "--log-driver=none",
        "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864",
        "--mount",
        `type=bind,src=${resolve(destination)},dst=/signatures`,
        "--mount",
        `type=bind,src=${config},dst=/freshclam.conf,readonly`,
        "--entrypoint=freshclam",
        SCANNER_IMAGE,
        "--config-file=/freshclam.conf",
        "--stdout",
      ],
      signal,
    );
    if (updated.code !== 0) throw new Error("scanner_signature_update_failed");
    // FreshClam's tracking metadata is not a signature and must not enter a scan.
    await rm(join(destination, "freshclam.dat"), { force: true });
  } finally {
    try {
      await removeScannerContainer(name);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
