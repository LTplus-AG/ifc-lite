/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** @unwired-by-design Child process used only by restart.integration.test.ts.
 * Runs actual report HTTP/session/upload/verifier code, with no GitHub publisher.
 * Configuration is passed privately through the child environment, never stdout. */
import { createServer } from "node:http";
import type { Config } from "../src/config.js";
import { openDatabase, migrate } from "../src/database.js";
import { ModelStorage } from "../src/storage.js";
import { createHandler } from "../src/handler.js";
import { verifyNext } from "../src/verification.js";
if (!process.send || !process.env.REPORT_RESTART_CONFIG)
  throw new Error("This fixture requires an IPC test parent");
const config: Config = JSON.parse(process.env.REPORT_RESTART_CONFIG);
const db = openDatabase(config.databaseUrl);
await migrate(db);
const storage = new ModelStorage(config);
const handler = createHandler(db, storage, config);
const server = createServer((req, res) => {
  void handler(req, res);
});
let active: Promise<void> | undefined;
const timer = setInterval(() => {
  if (active) return;
  active = verifyNext(db, storage)
    .catch((error) => {
      process.send?.({
        error: error instanceof Error ? error.name : "Unknown",
      });
    })
    .finally(() => {
      active = undefined;
    });
}, 50);
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No bound test port");
  process.send?.({ port: address.port, pid: process.pid });
});
let closing = false;
process.on("SIGTERM", () => {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  storage.cancelVerifications();
  server.close(() => {
    void (async () => {
      await active;
      storage.close();
      await db.end();
      process.disconnect?.();
    })().catch((error) => {
      process.send?.({
        error: error instanceof Error ? error.name : "Unknown",
      });
      process.exitCode = 1;
    });
  });
});
