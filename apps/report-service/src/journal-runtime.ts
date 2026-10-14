/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Config } from "./config.js";
import { type Db, transaction } from "./database.js";
import { journalDigest, readCustody, type JournalCustody } from "./journal-config.js";
import { RestoreJournal } from "./restore-journal.js";
import { assertRestoreNotHeld } from "./restore-recovery.js";

type JournalStorageConfig = Pick<Config,
  "bucket" | "region" | "endpoint" | "forcePathStyle" | "accessKeyId" | "secretAccessKey">;
type JournalRuntimeConfig = JournalStorageConfig & Pick<Config,
  "journal" | "submissionsEnabled" | "qualificationToken">;

export function journalTargetDigest(config: JournalStorageConfig): string {
  return journalDigest(JSON.stringify([config.bucket, config.region, config.endpoint ?? null, Boolean(config.forcePathStyle)]));
}
async function identity(db: Pick<Db, "query">): Promise<{ database: string; schema: string }> {
  const result = await db.query<{ database: string; schema: string }>(
    "SELECT current_database() AS database,current_schema() AS schema");
  return result.rows[0];
}
function checkCustody(config: JournalStorageConfig, custody: JournalCustody, actual: { database: string; schema: string }): void {
  if (custody.database !== actual.database || custody.schema !== actual.schema ||
      custody.targetDigest !== journalTargetDigest(config))
    throw new Error("report_journal_custody_target_mismatch");
}
async function assertEmptyHistory(tx: Pick<Db, "query">): Promise<void> {
  await tx.query("SET LOCAL lock_timeout = '5s'");
  // Catalog discovery includes later report_* tables instead of silently
  // forgetting a newly added history table. Names come only from pg_class.
  const tables = await tx.query<{ name: string }>(`SELECT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()
    AND c.relkind IN ('r','p') AND (c.relname LIKE 'report\\_%' ESCAPE '\\' OR c.relname='model_reports') ORDER BY c.relname`);
  if (!tables.rows.some(row => row.name === "report_journal_binding"))
    throw new Error("report_journal_schema_missing");
  for (const { name } of tables.rows) {
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    await tx.query(`LOCK TABLE ${quoted} IN ACCESS EXCLUSIVE MODE`);
    const occupied = await tx.query(`SELECT 1 FROM ${quoted} LIMIT 1`);
    if (occupied.rowCount) throw new Error("report_journal_pre_epoch_history");
  }
  const auditSequence = await tx.query<{ is_called: boolean }>("SELECT is_called FROM report_audit_id_seq");
  if (auditSequence.rows[0]?.is_called) throw new Error("report_journal_pre_epoch_history");
}
/** Startup authenticates an existing head, never creates one. This is NOT a
 * rollback detector: an operator must quiesce all actors, preserve an external
 * latest checkpoint and reconcile under a restore hold after any DB restore. */
export async function openRuntimeJournal<T extends JournalRuntimeConfig>(db: Db, config: T): Promise<RestoreJournal | undefined> {
  const binding = await db.query<{ epoch: string; key_fingerprint: string; target_digest: string; database_name: string; schema_name: string }>(
    "SELECT epoch,key_fingerprint,target_digest,database_name,schema_name FROM report_journal_binding WHERE singleton");
  if (!config.journal) {
    if (binding.rowCount || config.submissionsEnabled || config.qualificationToken)
      throw new Error("report_journal_required");
    await transaction(db, assertEmptyHistory);
    return undefined;
  }
  const custody = readCustody(config.journal);
  const actual = await identity(db);
  checkCustody(config, custody, actual);
  const row = binding.rows[0];
  if (!row || row.epoch !== config.journal.epoch || row.key_fingerprint !== custody.keyFingerprint ||
      row.target_digest !== custody.targetDigest || row.database_name !== actual.database ||
      row.schema_name !== actual.schema)
    throw new Error("report_journal_binding_mismatch");
  const journal = new RestoreJournal(config, config.journal.epoch, config.journal.key);
  try {
    const head = await journal.checkpoint();
    if (head.sequence === 0 && head.hash !== custody.initialCheckpoint.hash)
      throw new Error("report_journal_genesis_mismatch");
    return journal;
  } catch (error) { journal.close(); throw error; }
}
/** Explicit initialization only. Every known reporting table is exclusively
 * locked while testing emptiness and binding. Historical tombstones, audit,
 * admission, publication intents and recovery holds are all disqualifying.
 * No automatic removal or recovery of a partial remote initialization exists. */
export async function initializeRuntimeJournal(db: Db, config: Config): Promise<void> {
  if (config.submissionsEnabled || config.qualificationToken || !config.journal)
    throw new Error("report_journal_initialization_gate");
  const journalConfig = config.journal;
  const custody = readCustody(journalConfig);
  await assertRestoreNotHeld(db);
  const journal = new RestoreJournal(config, journalConfig.epoch, journalConfig.key);
  try {
    await transaction(db, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('report-schema-v1'))");
      checkCustody(config, custody, await identity(tx));
      await assertEmptyHistory(tx);
      const checkpoint = await journal.initialize();
      if (checkpoint.epoch !== custody.initialCheckpoint.epoch || checkpoint.sequence !== 0 || checkpoint.hash !== custody.initialCheckpoint.hash)
        throw new Error("report_journal_initial_checkpoint_mismatch");
      await tx.query(`INSERT INTO report_journal_binding
        (singleton,epoch,key_fingerprint,target_digest,database_name,schema_name) VALUES(true,$1,$2,$3,$4,$5)`,
        [journalConfig.epoch, custody.keyFingerprint, custody.targetDigest, custody.database, custody.schema]);
    });
  } finally { journal.close(); }
}
