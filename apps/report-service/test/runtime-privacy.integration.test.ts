/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
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
  // #7495: old shared fixture history must not bypass journal startup guards.
  const schema = `runtime_privacy_${randomUUID().replaceAll("-", "")}`;
  url.searchParams.set("options", `-c search_path=${schema}`);
  const admin = openDatabase(databaseUrl!);
  let running: ReturnType<typeof launch> | undefined;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve);
    });
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Health port reservation failed");
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    running = launch({ REPORT_DATABASE_URL: url.toString(), PORT: String(port) });
    // A PostgreSQL backend can be idle between startup transaction queries
    // while still checked out. Actual HTTP readiness proves migration finished.
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { healthy = (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(300) })).ok; }
      catch (error) { if (!(error instanceof TypeError || error instanceof DOMException)) throw error; }
      if (healthy) break;
      await delay(25);
    }
    expect(healthy).toBe(true);
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
    try {
      if (running?.child.exitCode === null) running.child.kill("SIGKILL");
      await running?.done;
    } finally {
      try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
      finally { await admin.end(); }
    }
  }
}, 15000);


for (const mode of ["checked-out", "idle"] as const) {
  it.skipIf(!databaseUrl)(`#7495 actual ${mode} PostgreSQL client error stays categorical and notifies shutdown once`, async () => {
    const marker = "PRIVATE_CLIENT_" + randomUUID();
    const url = new URL(databaseUrl!);
    url.searchParams.set("application_name", marker);
    const admin = openDatabase(databaseUrl!);
    const child = spawn(process.execPath, [
      "--import", import.meta.resolve("tsx"),
      fileURLToPath(new URL("./fixtures/checked-out-database.mjs", import.meta.url)),
    ], { env: { PATH: process.env.PATH, HOME: process.env.HOME, REPORT_TEST_DATABASE_URL: url.toString(), OWN_DATABASE_MODE: mode }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    if (!child.stdout || !child.stderr) {
      child.kill("SIGKILL");
      await admin.end();
      throw new Error("Privacy fixture requires captured stdout and stderr");
    }
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
    let output = "";
    const messages: Record<string, unknown>[] = [];
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("message", (message: unknown) => {
      if (message && typeof message === "object") messages.push(message as Record<string, unknown>);
    });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", code => resolve(code));
    });
    try {
      let ready: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        ready = messages.find(message => message.ready === true);
        if (ready || child.exitCode !== null) break;
        await delay(25);
      }
      expect(ready?.idleCount).toBe(mode === "idle" ? 1 : 0);
      expect(typeof ready?.pid).toBe("number");
      const observed = await admin.query<{ state: string }>(
        "SELECT state FROM pg_stat_activity WHERE pid=$1 AND application_name=$2", [ready!.pid, marker],
      );
      expect(observed.rows[0]?.state).toBe(mode === "idle" ? "idle" : "idle in transaction");
      const killed = await admin.query<{ killed: boolean }>(
        "SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE pid=$1 AND application_name=$2", [ready!.pid, marker],
      );
      expect(killed.rows).toEqual([{ killed: true }]);
      expect(await done).toBe(1);
      expect(output).toBe("[report-service] database connection failed\n");
      expect(output).not.toContain(marker);
      expect(output).not.toContain(url.password);
      expect(messages.filter(message => 'notifications' in message)).toEqual([{ notifications: 1 }]);
      if (mode === "checked-out") expect(messages).toContainEqual({ rejected: true });
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill("SIGKILL");
      try { await done; } finally { await admin.end(); }
    }
  }, 15000);
}
