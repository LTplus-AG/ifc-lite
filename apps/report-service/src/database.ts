/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import pg, { type PoolClient } from "pg";
export type Db = Pick<pg.Pool, "query" | "connect">;
export function openDatabase(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 6 });
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
export async function migrate(db: Db): Promise<void> {
  await transaction(db, async (tx) => {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtext('report-schema-v1'))",
    );
    await tx.query(`
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
    CREATE TABLE IF NOT EXISTS report_outbox (
      report_id uuid PRIMARY KEY REFERENCES model_reports(id), attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, last_error text);
    CREATE TABLE IF NOT EXISTS report_fingerprints (fingerprint text PRIMARY KEY, issue_url text NOT NULL);
    CREATE TABLE IF NOT EXISTS report_audit (id bigserial PRIMARY KEY, report_id uuid, action text NOT NULL, actor text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS report_uploads_expiry ON report_uploads(expires_at);
    CREATE INDEX IF NOT EXISTS model_reports_expiry ON model_reports(expires_at);
  `);
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
