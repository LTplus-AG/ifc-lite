/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer } from "node:http";
import { validateAgreementFont } from "./agreement.js";
import { loadConfig } from "./config.js";
import { openDatabase, migrate } from "./database.js";
import { ModelStorage } from "./storage.js";
import { GithubIssues } from "./github.js";
import { createHandler } from "./handler.js";
import { verifyNext } from "./verification.js";
import { sweep } from "./maintenance.js";
import { publishOne } from "./publication.js";
const config = loadConfig(process.env);
await validateAgreementFont(config);
const db = openDatabase(config.databaseUrl);
await migrate(db);
const storage = new ModelStorage(config);
const github = new GithubIssues(config);
const handler = createHandler(db, storage, config);
const server = createServer((req, res) => {
  void handler(req, res);
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
function worker(
  name: string,
  run: () => Promise<void>,
): { stop: () => Promise<void> } {
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (active) return;
    active = run()
      .catch((error) => {
        console.error(
          `[report-service] ${name} failed`,
          error instanceof Error ? error.name : "Unknown",
        );
      })
      .finally(() => {
        active = undefined;
      });
  }, 10000);
  return {
    stop: async () => {
      clearInterval(timer);
      await active;
    },
  };
}
const workers = [
  worker("retention", () => sweep(db, storage)),
  worker("verification", () => verifyNext(db, storage)),
  worker("publisher", () => publishOne(db, github)),
];
server.listen(config.port, "0.0.0.0");
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    storage.cancelVerifications();
    const stopped = Promise.all(workers.map((job) => job.stop()));
    server.close(() => {
      void (async () => {
        await stopped;
        storage.close();
        await db.end();
      })().catch((error) => {
        console.error(
          "[report-service] shutdown failed",
          error instanceof Error ? error.name : "Unknown",
        );
        process.exitCode = 1;
      });
    });
    setTimeout(() => process.exit(1), 25000).unref();
  });
