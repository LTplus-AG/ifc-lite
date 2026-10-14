/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Config } from "../src/config.js";

const exec = promisify(execFile);
export async function docker(args: string[]) {
  return exec("docker", args, { timeout: 10000, maxBuffer: 8192 });
}
export function scannerChild(config: Config, signatures: string, scratch: string, deadlineMs = 120000) {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(
    new URL("../scripts/scan-public-once.ts", import.meta.url)), "scan-once"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      REPORT_DATABASE_URL: config.databaseUrl,
      REPORT_S3_BUCKET: config.bucket, REPORT_S3_REGION: config.region,
      REPORT_S3_ENDPOINT: config.endpoint, REPORT_S3_FORCE_PATH_STYLE: "true",
      REPORT_S3_ACCESS_KEY_ID: config.accessKeyId,
      REPORT_S3_SECRET_ACCESS_KEY: config.secretAccessKey,
      REPORT_JOURNAL_EPOCH: config.journal?.epoch,
      REPORT_JOURNAL_HMAC_KEY: config.journal?.key,
      REPORT_JOURNAL_CUSTODY_FILE: config.journal?.custodyFile,
      REPORT_SCANNER_SIGNATURE_DIRECTORY: signatures,
      REPORT_SCANNER_SCRATCH_DIRECTORY: scratch,
    },
  });
  let output = "";
  const capture = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 8192) child.kill("SIGKILL");
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const timer = setTimeout(() => child.kill("SIGKILL"), deadlineMs);
  const done = new Promise<{ code: number | null; signal: string | null; output: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, output }));
  }).finally(() => clearTimeout(timer));
  // Attach failure cleanup immediately; callers still await the original
  // rejecting promise, including spawn failure before container observation.
  void done.catch(() => child.kill("SIGKILL"));
  return { child, done };
}
export async function runningContainer(scratch: string): Promise<string> {
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    let entries: string[] = [];
    try { entries = await readdir(scratch); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    for (const entry of entries) {
      if (!/^job-[a-zA-Z0-9]+$/.test(entry)) continue;
      let name: string;
      try { name = await readFile(join(scratch, entry, "container"), "utf8"); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      if (!/^ifclite-scan-[a-f0-9-]{36}$/.test(name)) throw new Error("invalid fixture container marker");
      try {
        const result = await docker(["inspect", "--format", "{{.State.Running}}", name]);
        if (result.stdout.trim() === "true") return name;
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("No such object"))) throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Real scanner container did not start within qualification deadline");
}

/** Only markers inside this test's unique scratch root authorize cleanup. */
export async function cleanScannerScratch(scratch: string) {
  let entries: string[];
  try { entries = await readdir(scratch); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!/^job-[a-zA-Z0-9]+$/.test(entry)) continue;
    let name: string;
    try { name = await readFile(join(scratch, entry, "container"), "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!/^ifclite-scan-[a-f0-9-]{36}$/.test(name)) throw new Error("invalid fixture container marker");
    const owned = await docker(["ps", "-aq", "--filter", `name=^/${name}$`]);
    if (owned.stdout.trim()) await docker(["rm", "-f", name]);
  }
}
