/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isMainEntry } from "../../../scripts/lib/is-main-entry.mjs";
import { loadConfig } from "../src/config.js";
import { migrate, openDatabase } from "../src/database.js";
import { initializeRuntimeJournal } from "../src/journal-runtime.js";

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== "--confirm-independent-custody-and-quiescence" ||
      process.env.REPORT_RESTORE_REQUIRED === "true")
    throw new Error("report_journal_initialization_confirmation_required");
  const config = loadConfig(process.env);
  const db = openDatabase(config.databaseUrl);
  try {
    await migrate(db);
    await initializeRuntimeJournal(db, config);
    console.log("report_journal_initialized");
  } finally { await db.end(); }
}
if (isMainEntry(import.meta.url)) {
  void main().catch(() => {
    console.error("report_journal_initialization_failed");
    process.exitCode = 1;
  });
}
