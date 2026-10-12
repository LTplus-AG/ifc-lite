/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../src/database.js";

function launch(overrides: NodeJS.ProcessEnv) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("REPORT_")),
  );
  const child = spawn(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    fileURLToPath(new URL("../src/bin.ts", import.meta.url)),
  ], {
    env: {
      ...env,
      PORT: "0",
      REPORT_VIEWER_ORIGIN: "https://viewer.example.com",
      REPORT_ADMISSION_SECRET: "a".repeat(32),
      REPORT_ADMIN_TOKEN: "b".repeat(32),
      REPORT_GITHUB_PRIVATE_KEY: "fixture-private-key",
      REPORT_GITHUB_REPOSITORY: "owner/repo",
      REPORT_GITHUB_APP_ID: "1",
      REPORT_GITHUB_INSTALLATION_ID: "1",
      REPORT_STORAGE_PROVIDER: "test",
      REPORT_STORAGE_LOCATION: "test",
      REPORT_BACKUP_DISCLOSURE: "none",
      REPORT_S3_BUCKET: "unused",
      REPORT_S3_REGION: "test",
      REPORT_S3_ACCESS_KEY_ID: "test",
      REPORT_S3_SECRET_ACCESS_KEY: "fixture-secret",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  let output = "";
  const append = (chunk: Buffer) => { output += chunk.toString(); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => { clearTimeout(timeout); resolve({ code, output }); });
  });
  return { child, done };
}

it("#7495 startup errors never print private URL or template paths", async () => {
  const sentinel = "PRIVATE_SENTINEL_" + randomUUID();
  for (const overrides of [
    { REPORT_DATABASE_URL: `postgres://user:${sentinel}@[invalid/secret` },
    { REPORT_DATABASE_URL: "unused", REPORT_AGREEMENT_FILE: `/missing/${sentinel}` },
  ]) {
    const process = launch(overrides);
    try {
      const result = await process.done;
      expect(result.code).toBe(1);
      expect(result.output).toBe("[report-service] startup failed\n");
      expect(result.output).not.toContain(sentinel);
    } finally {
      if (process.child.exitCode === null) process.child.kill("SIGKILL");
    }
  }
}, 15000);

const databaseUrl = process.env.REPORT_TEST_DATABASE_URL;
if (process.env.REPORT_REQUIRE_INTEGRATION === "true" && !databaseUrl)
  throw new Error("Mandatory runtime privacy integration database is missing");
it.skipIf(!databaseUrl)("#7495 idle PostgreSQL errors exit safely without client secrets", async () => {
  const marker = "PRIVATE_SENTINEL_" + randomUUID();
  const url = new URL(databaseUrl!);
  url.searchParams.set("application_name", marker);
  const admin = openDatabase(databaseUrl!);
  const running = launch({ REPORT_DATABASE_URL: url.toString() });
  try {
    let pid: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await admin.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='idle'",
        [marker],
      );
      pid = result.rows[0]?.pid;
      if (pid) break;
      await delay(50);
    }
    expect(pid).toBeDefined();
    // Kill only this child service's unique application_name backend.
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND application_name=$2",
      [pid, marker],
    );
    const result = await running.done;
    expect(result.code).toBe(1);
    expect(result.output).toBe("[report-service] database connection failed\n");
    expect(result.output).not.toContain(marker);
    expect(result.output).not.toContain(url.password);
  } finally {
    if (running.child.exitCode === null) running.child.kill("SIGKILL");
    await running.done;
    await admin.end();
  }
}, 15000);
