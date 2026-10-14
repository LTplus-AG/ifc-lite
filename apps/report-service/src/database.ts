/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import pg, { type PoolClient } from "pg";
import { migratePublicQuarantine } from "./public-schema.js";
export type Db = Pick<pg.Pool, "query" | "connect">;
export function openDatabase(url: string, onConnectionError?: () => void): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  const observed = new WeakSet<object>();
  let fatalNotified = false;
  const connectionFailed = (error: unknown): void => {
    // pg-pool forwards the same Error from an idle Client onto the Pool, adding
    // private client/config details. Never print it or retain it strongly.
    if (typeof error === "object" && error !== null) {
      if (observed.has(error)) return;
      observed.add(error);
    }
    console.error("[report-service] database connection failed");
    if (!fatalNotified) {
      fatalNotified = true;
      onConnectionError?.();
    }
  };
  pool.on("error", connectionFailed);
  // pg-pool removes its own idle error listener during checkout. Install a
  // persistent listener before handing each new client to any transaction.
  pool.on("connect", client => { client.on("error", connectionFailed); });
  return pool;
}
export async function transaction<T>(
  db: Db,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
/** All private uploads and immutable public copies reserve from the same capacity. */
export async function lockStorageCapacity(tx: PoolClient): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('report-upload-capacity'))");
}
export async function migrate(db: Db): Promise<void> {
  await transaction(db, async (tx) => {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtext('report-schema-v1'))",
    );
    await tx.query(`
    CREATE TABLE IF NOT EXISTS report_journal_binding (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), epoch text NOT NULL,
      key_fingerprint text NOT NULL, target_digest text NOT NULL, database_name text NOT NULL,
      schema_name text NOT NULL, initialized_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS report_sessions (id text PRIMARY KEY, csrf text NOT NULL, admission text NOT NULL, expires_at timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS report_admission (key text NOT NULL, day date NOT NULL DEFAULT CURRENT_DATE, reports integer NOT NULL DEFAULT 0, bytes bigint NOT NULL DEFAULT 0, PRIMARY KEY(key,day));
    CREATE TABLE IF NOT EXISTS model_reports (
      id uuid PRIMARY KEY, session_id text NOT NULL, client_key uuid NOT NULL, draft jsonb NOT NULL,
      status text NOT NULL DEFAULT 'draft', agreement jsonb, agreement_pdf bytea, custom_nda jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
      issue_url text, fingerprint text NOT NULL, UNIQUE(session_id,client_key));
    CREATE TABLE IF NOT EXISTS report_uploads (
      id uuid PRIMARY KEY, report_id uuid NOT NULL UNIQUE REFERENCES model_reports(id), object_key text NOT NULL UNIQUE,
      multipart_id text, input jsonb NOT NULL, status text NOT NULL DEFAULT 'initializing', reserved_bytes bigint NOT NULL,
      expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day', parts jsonb NOT NULL DEFAULT '{}'::jsonb,
      completed_at timestamptz, object_checksum text, authorizations jsonb NOT NULL DEFAULT '{}'::jsonb);
    ALTER TABLE report_uploads ADD COLUMN IF NOT EXISTS authorizations jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE report_uploads ADD COLUMN IF NOT EXISTS verification_attempts integer NOT NULL DEFAULT 0;
    ALTER TABLE report_uploads ADD COLUMN IF NOT EXISTS verification_after timestamptz DEFAULT now();
    ALTER TABLE report_uploads ADD COLUMN IF NOT EXISTS deletion_attempts integer NOT NULL DEFAULT 0;
    ALTER TABLE report_uploads ADD COLUMN IF NOT EXISTS deletion_after timestamptz DEFAULT now();

    ALTER TABLE model_reports ADD COLUMN IF NOT EXISTS issue_binding jsonb;
    ALTER TABLE report_admission ADD COLUMN IF NOT EXISTS issue_lookups integer NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS report_outbox (
      report_id uuid PRIMARY KEY REFERENCES model_reports(id), attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, last_error text);
    -- No FK: committed using a second connection while publisher owns the parent
    -- row lock. Only opaque IDs; survives parent transaction/process rollback.
    CREATE TABLE IF NOT EXISTS report_publication_intents (
      report_id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS report_fingerprints (fingerprint text PRIMARY KEY, issue_url text NOT NULL);
    CREATE TABLE IF NOT EXISTS report_audit (id bigserial PRIMARY KEY, report_id uuid, action text NOT NULL, actor text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS report_uploads_expiry ON report_uploads(expires_at);
    CREATE INDEX IF NOT EXISTS model_reports_expiry ON model_reports(expires_at);
  `);
    await migratePublicQuarantine(tx);
  });
}
export async function audit(
  db: Pick<Db, "query">,
  reportId: string | null,
  action: string,
  actor: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    "INSERT INTO report_audit(report_id,action,actor,detail) VALUES($1,$2,$3,$4)",
    [reportId, action, actor, JSON.stringify(detail)],
  );
}
