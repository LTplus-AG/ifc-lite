/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { JournalCheckpoint } from "./restore-journal.js";

export interface JournalConfig {
  epoch: string;
  key: string;
  custodyFile: string;
}
export interface JournalCustody {
  version: 1;
  epoch: string;
  keyFingerprint: string;
  database: string;
  schema: string;
  targetDigest: string;
  custodian: string;
  independentLocation: string;
  initialCheckpoint: JournalCheckpoint;
}
export const journalDigest = (value: string): string => createHash("sha256").update(value).digest("hex");

/** No symlink or group/world-readable secret/custody file is accepted. The
 * operator must independently verify location/custodian; filesystem mode alone
 * cannot establish independence from a database backup or host failure. */
export function readProtectedFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid()))
      throw new Error("report_journal_file_protection");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
export function loadJournalConfig(env: NodeJS.ProcessEnv): JournalConfig | undefined {
  const names = ["REPORT_JOURNAL_EPOCH", "REPORT_JOURNAL_HMAC_KEY", "REPORT_JOURNAL_HMAC_KEY_FILE", "REPORT_JOURNAL_CUSTODY_FILE"];
  if (!names.some(name => env[name] !== undefined)) return undefined;
  const epoch = env.REPORT_JOURNAL_EPOCH?.trim();
  const custodyFile = env.REPORT_JOURNAL_CUSTODY_FILE?.trim();
  const inline = env.REPORT_JOURNAL_HMAC_KEY;
  const file = env.REPORT_JOURNAL_HMAC_KEY_FILE?.trim();
  if (!epoch || !/^[a-f0-9]{64}$/.test(epoch) || !custodyFile || (env.REPORT_JOURNAL_HMAC_KEY !== undefined) === (env.REPORT_JOURNAL_HMAC_KEY_FILE !== undefined) ||
      (env.REPORT_JOURNAL_HMAC_KEY_FILE !== undefined && !file))
    throw new Error("report_journal_configuration_incomplete");
  const key = file ? readProtectedFile(file).trim() : inline!;
  // Hex encoding makes the required 32 random bytes unambiguous. Generation and
  // custody remain operator responsibilities; never generate keys at startup.
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("report_journal_key_invalid");
  return { epoch, key, custodyFile };
}
export function readCustody(config: JournalConfig): JournalCustody {
  const value = JSON.parse(readProtectedFile(config.custodyFile)) as JournalCustody;
  if (!value || value.version !== 1 || value.epoch !== config.epoch ||
      value.keyFingerprint !== journalDigest(config.key) ||
      ![value.database, value.schema, value.custodian, value.independentLocation].every(v => typeof v === "string" && v.trim().length > 0) ||
      !/^[a-f0-9]{64}$/.test(value.targetDigest) ||
      value.initialCheckpoint?.epoch !== config.epoch || value.initialCheckpoint.sequence !== 0 ||
      value.initialCheckpoint.hash !== "0".repeat(64))
    throw new Error("report_journal_custody_invalid");
  return value;
}
