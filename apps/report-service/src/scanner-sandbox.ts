/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { scannerProcess, removeScannerContainer } from "./scanner-process.js";
import {
  PUBLIC_SCAN_POLICY,
  type ScanEvidence,
  type ScanLease,
} from "./public-quarantine.js";

// Official linux/amd64 manifest resolved from docker.io/clamav/clamav:stable.
// Upgrade only with a fresh real-engine qualification, never a floating tag.
export const SCANNER_IMAGE_DIGEST =
  "sha256:705e0723f02fc13bf6e5e8a8e13a8c44420acf5e7ed06dfa2197081da00c7a73";
export const SCANNER_IMAGE = `clamav/clamav@${SCANNER_IMAGE_DIGEST}`;

async function signatures(source: string, destination: string) {
  await mkdir(destination, { mode: 0o755 });
  const names = await readdir(source);
  // Signed full CVD snapshots only. No local custom rules/config or incremental CLD.
  if (
    !names.includes("main.cvd") ||
    !names.includes("daily.cvd") ||
    names.some(
      (name) =>
        !["main.cvd", "daily.cvd", "bytecode.cvd"].includes(name) &&
        !/^(?:main|daily|bytecode)-\d{1,12}\.cvd\.sign$/.test(name),
    )
  )
    throw new Error("scanner_signatures_invalid");
  let size = 0;
  for (const name of names) {
    const file = join(source, name);
    const info = await lstat(file);
    size += info.size;
    if (!info.isFile() || info.size < 512 || size > 512 * 1024 ** 2)
      throw new Error("scanner_signatures_invalid");
    await copyFile(file, join(destination, name));
    await chmod(join(destination, name), 0o444);
  }
  const file = await open(join(destination, "daily.cvd"), "r");
  const header = Buffer.alloc(512);
  try {
    await file.read(header, 0, header.length, 0);
  } finally {
    await file.close();
  }
  const fields = header.toString("ascii").trim().split(":");
  const epoch = Number(fields[8]);
  if (
    fields[0] !== "ClamAV-VDB" ||
    !/^\d{1,12}$/.test(fields[2] ?? "") ||
    !Number.isSafeInteger(epoch) ||
    epoch * 1000 > Date.now() ||
    Date.now() - epoch * 1000 > 86400000
  )
    throw new Error("scanner_signatures_stale");
  return {
    signatureVersion: fields[2]!,
    signaturesAt: new Date(epoch * 1000).toISOString(),
  };
}

/** The only model-reading subprocess has no network, credentials, sockets or host directory. */
export async function scanSandbox(
  lease: ScanLease,
  modelPath: string,
  signatureDirectory: string,
  workDirectory: string,
  signal: AbortSignal,
): Promise<ScanEvidence> {
  const snapshot = join(workDirectory, "signatures");
  const version = await signatures(signatureDirectory, snapshot);
  const name = `ifclite-scan-${randomUUID()}`;
  await writeFile(join(workDirectory, "container"), name, { mode: 0o600 });
  const flags = [
    "run",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--label",
    "ifclite.report-scanner=true",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=65534:65534",
    "--cpus=1",
    "--memory=4g",
    "--memory-swap=4g",
    "--pids-limit=64",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864",
    "--log-driver=none",
    "--mount",
    `type=bind,src=${resolve(modelPath)},dst=/model.ifc,readonly`,
    "--mount",
    `type=bind,src=${resolve(snapshot)},dst=/signatures,readonly`,
    "--entrypoint=/bin/sh",
    SCANNER_IMAGE,
    "-c",
    // Fixed command, no file-derived arguments. Database headers are authenticated
    // by libclamav when the real scan loads the copied signed CVD snapshot.
    "clamscan --version && exec timeout -s KILL 660 clamscan --database=/signatures --stdout --no-summary --alert-exceeds-max=yes --max-filesize=1073741824 --max-scansize=2147483648 --max-recursion=8 --max-files=1000 --max-scantime=600000 --pcre-max-filesize=1073741824 /model.ifc",
  ];
  let result: Awaited<ReturnType<typeof scannerProcess>>;
  try {
    result = await scannerProcess(flags, signal);
  } finally {
    // Killing the docker CLI does not kill the container. Remove by our unique
    // name on every path; daemon unavailability is surfaced, never called success.
    await removeScannerContainer(name);
  }
  const lines = result.output.trim().split(/\r?\n/);
  const engine = /^ClamAV (\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?)\//.exec(
    lines[0] ?? "",
  );
  // No skipped/error/warning/limit output is compatible with a complete clean scan.
  const clean =
    result.code === 0 &&
    lines.length === 2 &&
    lines[1] === "/model.ifc: OK" &&
    Boolean(engine);
  const infected =
    result.code === 1 &&
    lines.some((line) => /^\/model\.ifc: .+ FOUND$/.test(line));
  return {
    outcome: clean ? "clean" : infected ? "infected" : "inconclusive",
    complete: clean,
    format: "ifc-step",
    sha256: lease.sha256,
    byteSize: lease.byteSize,
    policyVersion: PUBLIC_SCAN_POLICY,
    imageDigest: SCANNER_IMAGE_DIGEST,
    engineVersion: engine?.[1] ?? "0.0.0",
    ...version,
    finishedAt: new Date().toISOString(),
  };
}
