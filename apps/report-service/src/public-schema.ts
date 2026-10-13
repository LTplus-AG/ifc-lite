/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PoolClient } from "pg";
/** Quarantine has no public token, object or delivery URL. */
export async function migratePublicQuarantine(tx: PoolClient): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS report_public_quarantine (
    report_id uuid PRIMARY KEY REFERENCES model_reports(id),
    upload_id uuid NOT NULL REFERENCES report_uploads(id),
    state text NOT NULL CHECK(state IN ('pending','scanning','review','approved','blocked','revoked')),
    sha256 text, byte_size bigint NOT NULL, consent jsonb, policy_version text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
    lease_id uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
    scan jsonb, approval jsonb,
    CHECK(sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$')
  ); CREATE INDEX IF NOT EXISTS report_public_quarantine_queue
    ON report_public_quarantine(state,lease_until,created_at);
    ALTER TABLE report_public_quarantine ADD COLUMN IF NOT EXISTS promotion_after timestamptz NOT NULL DEFAULT now();
    CREATE TABLE IF NOT EXISTS report_public_copies (
      report_id uuid PRIMARY KEY REFERENCES model_reports(id), token text NOT NULL UNIQUE,
      object_key text NOT NULL UNIQUE, sha256 text, byte_size bigint NOT NULL,
      reserved_bytes bigint NOT NULL, state text NOT NULL CHECK(state IN ('copying','available','revoked','held')),
      etag text, expires_at timestamptz NOT NULL, lease_until timestamptz,
      lease_id uuid, attempts integer NOT NULL DEFAULT 0,
      cleanup_after timestamptz NOT NULL DEFAULT now(), cleanup_attempts integer NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS report_public_download_budget (
      day date PRIMARY KEY DEFAULT CURRENT_DATE, bytes bigint NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS report_public_download_leases (
      id uuid PRIMARY KEY, expires_at timestamptz NOT NULL,
      report_id uuid REFERENCES report_public_copies(report_id), object_key text
    );
    ALTER TABLE report_public_download_leases
      ADD COLUMN IF NOT EXISTS report_id uuid REFERENCES report_public_copies(report_id),
      ADD COLUMN IF NOT EXISTS object_key text;`);
}
