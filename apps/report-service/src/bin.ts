/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer, type Server } from "node:http";
import { validateAgreementFont } from "./agreement.js";
import { loadConfig } from "./config.js";
import { openDatabase, migrate } from "./database.js";
import { ModelStorage } from "./storage.js";
import { GithubIssues } from "./github.js";
import { createHandler } from "./handler.js";
import { verifyNext } from "./verification.js";
import { sweep } from "./maintenance.js";
import { publishOne } from "./publication.js";

type Worker = { stop: () => Promise<void> };
let db: ReturnType<typeof openDatabase> | undefined;
let storage: ModelStorage | undefined;
let server: Server | undefined;
const workers: Worker[] = [];
let closing: Promise<void> | undefined;

function worker(
  name: "retention" | "verification" | "publisher",
  run: () => Promise<void>,
): Worker {
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (active) return;
    active = run()
      .catch(() => {
        // Even Error.name may contain provider-controlled or private text.
        console.error(`[report-service] ${name} failed`);
      })
      .finally(() => { active = undefined; });
  }, 10000);
  return { stop: async () => { clearInterval(timer); await active; } };
}

function shutdown(failed: boolean): Promise<void> {
  if (failed) process.exitCode = 1;
  if (closing) return closing;
  const deadline = setTimeout(() => process.exit(1), 25000);
  deadline.unref();
  storage?.cancelVerifications();
  closing = (async () => {
    const listenerClosed = new Promise<void>((resolve, reject) => {
      if (!server?.listening) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve());
    });
    // Stop timers immediately, even while an HTTP request is draining.
    const results = await Promise.allSettled([
      listenerClosed,
      ...workers.map(job => job.stop()),
    ]);
    storage?.close();
    await db?.end();
    if (results.some(result => result.status === "rejected"))
      throw new Error("shutdown operation failed");
    clearTimeout(deadline);
  })().catch(() => {
    console.error("[report-service] shutdown failed");
    process.exitCode = 1;
  });
  return closing;
}

async function start(): Promise<void> {
  const config = loadConfig(process.env);
  await validateAgreementFont(config);
  if (closing) return;
  const database = openDatabase(config.databaseUrl, () => { void shutdown(true); });
  db = database;
  await migrate(database);
  if (closing) return;
  const models = new ModelStorage(config);
  storage = models;
  const github = new GithubIssues(config);
  const handler = createHandler(database, models, config);
  server = createServer((req, res) => { void handler(req, res); });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on("error", () => {
    console.error("[report-service] listener failed");
    void shutdown(true);
  });
  workers.push(
    worker("retention", () => sweep(database, models)),
    worker("verification", () => verifyNext(database, models)),
    worker("publisher", () => publishOne(database, github)),
  );
  server.listen(config.port, "0.0.0.0");
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => { void shutdown(false); });

// Never hand a config/provider error object to Node's uncaught-error printer.
void start().catch(async () => {
  console.error("[report-service] startup failed");
  await shutdown(true);
});
