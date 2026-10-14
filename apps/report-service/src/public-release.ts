/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RestoreJournal } from "./restore-journal.js";
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { PublicModelReceipt } from "@ifc-lite/report-contract";
import { audit, transaction, lockStorageCapacity, type Db } from "./database.js";
import type { Config } from "./config.js";
import { ReportError, requireCondition } from "./errors.js";
import { approvedPublicSource, revokePublicQuarantine } from "./public-quarantine.js";
import type { PublicModelStorage } from "./public-storage.js";

export interface PublicCopyRow {
  report_id: string;
  token: string;
  object_key: string;
  sha256: string | null;
  byte_size: string;
  reserved_bytes: string;
  state: "copying" | "available" | "revoked" | "held";
  etag: string | null;
  expires_at: Date;
  lease_id: string | null;
  lease_until: Date | null;
  attempts: number;
  cleanup_after: Date;
  cleanup_attempts: number;
}
const COPY_LEASE_MS = 20 * 60 * 1000;
export async function publicModelReceipt(db: Db, config: Config, id: string): Promise<PublicModelReceipt | undefined> {
  const copy = (await db.query<PublicCopyRow>("SELECT * FROM report_public_copies WHERE report_id=$1", [id])).rows[0];
  if (copy) {
    if (copy.state === "revoked" || copy.expires_at.getTime() <= Date.now()) return { state: "withdrawn" };
    if (copy.state === "available" && config.publicSharing)
      return { state: "available", downloadUrl: `${config.origin}/api/reports/public/${copy.token}`, expiresAt: copy.expires_at.toISOString() };
    return { state: copy.state === "held" || copy.state === "available" ? "held" : "preparing" };
  }
  const job = (await db.query<{ state: string }>("SELECT state FROM report_public_quarantine WHERE report_id=$1", [id])).rows[0];
  if (!job) return;
  return { state: job.state === "revoked" ? "withdrawn" : job.state === "blocked" ? "held" :
    job.state === "review" ? "review" : job.state === "approved" ? "preparing" : "quarantined" };
}
/** Called with the parent row locked. Revocation commits before any provider I/O. */
export async function revokePublicCopy(tx: PoolClient, id: string): Promise<void> {
  await tx.query(`UPDATE report_public_copies SET state='revoked',sha256=NULL,etag=NULL,
    cleanup_after=GREATEST(cleanup_after,now(),COALESCE(lease_until,now())) WHERE report_id=$1`, [id]);
}
export async function withdrawPublicModel(db: Db, id: string, ownerId: string, journal?: RestoreJournal): Promise<void> {
  await transaction(db, async (tx) => {
    const report = await tx.query("SELECT id FROM model_reports WHERE id=$1 AND session_id=$2 FOR UPDATE", [id, ownerId]);
    requireCondition(report.rowCount === 1, 404, "report_missing", "Report not found.");
    if (journal) {
      const prior = await tx.query("SELECT 1 FROM report_audit WHERE report_id=$1 AND action='public_downloads_withdrawn' LIMIT 1", [id]);
      if (!prior.rowCount) await journal.append(id, "withdraw");
    }
    await revokePublicQuarantine(tx, id);
    await revokePublicCopy(tx, id);
    await audit(tx, id, "public_downloads_withdrawn", ownerId);
  });
}
/** Copying is separate from scanning: an approved hash never exposes its private source key. */
export async function promotePublicModel(db: Db, storage: PublicModelStorage, config: Config): Promise<void> {
  if (!config.publicSharing) return;
  const candidate = await db.query<{ report_id: string }>(`SELECT q.report_id FROM report_public_quarantine q
    JOIN model_reports r ON r.id=q.report_id LEFT JOIN report_public_copies c ON c.report_id=q.report_id
    WHERE q.state='approved' AND q.promotion_after<=now() AND r.status='published' AND r.expires_at>now()
      AND (c.report_id IS NULL OR (c.state='copying' AND c.lease_until<now())) ORDER BY q.created_at LIMIT 1`);
  if (!candidate.rows[0]) return;
  const id = candidate.rows[0].report_id;
  const image = config.publicSharing.scannerImageDigest;
  let work: { source: Awaited<ReturnType<typeof approvedPublicSource>>; destination: string; leaseId: string } | undefined;
  try { work = await transaction(db, async (tx) => {
    await lockStorageCapacity(tx);
    const source = await approvedPublicSource(tx, id, image);
    let row = (await tx.query<PublicCopyRow>("SELECT * FROM report_public_copies WHERE report_id=$1 FOR UPDATE", [id])).rows[0];
    if (row && (row.state !== "copying" || row.lease_until!.getTime() > Date.now())) return;
    if (row && row.attempts >= 3) {
      await tx.query("UPDATE report_public_copies SET state='held' WHERE report_id=$1", [id]);
      return;
    }
    const leaseId = randomUUID();
    const leaseUntil = new Date(Date.now() + COPY_LEASE_MS);
    if (!row) {
      const used = await tx.query<{ bytes: string }>(`SELECT
        (SELECT COALESCE(sum(reserved_bytes),0) FROM report_uploads WHERE status!='aborted') +
        (SELECT COALESCE(sum(reserved_bytes),0) FROM report_public_copies) AS bytes`);
      requireCondition(Number(used.rows[0]?.bytes) + source.byteSize <= config.maxStorageBytes,
        429, "storage_quota", "Model publication is waiting for storage capacity.");
      const inserted = await tx.query<PublicCopyRow>(`INSERT INTO report_public_copies
        (report_id,token,object_key,sha256,byte_size,reserved_bytes,state,expires_at,lease_id,lease_until,attempts)
        VALUES($1,$2,$3,$4,$5,$5,'copying',$6,$7,$8,1) RETURNING *`,
        [id, randomBytes(32).toString("hex"), `published/${randomBytes(32).toString("hex")}`,
          source.sha256, source.byteSize, source.expiresAt, leaseId, leaseUntil]);
      row = inserted.rows[0]!;
    } else {
      requireCondition(row.sha256 === source.sha256 && Number(row.byte_size) === source.byteSize,
        409, "public_source_changed", "The approved model has changed.");
      await tx.query("UPDATE report_public_copies SET lease_id=$2,lease_until=$3,attempts=attempts+1 WHERE report_id=$1", [id, leaseId, leaseUntil]);
    }
    return { source, destination: row.object_key, leaseId };
  }); } catch (error) {
    if (!(error instanceof ReportError)) throw error;
    await transaction(db, async (tx) => {
      await tx.query("SELECT id FROM model_reports WHERE id=$1 FOR UPDATE", [id]);
      if (error.code === "storage_quota") {
        await tx.query("UPDATE report_public_quarantine SET promotion_after=now()+interval '1 minute' WHERE report_id=$1", [id]);
      } else {
        await tx.query("UPDATE report_public_quarantine SET state='blocked' WHERE report_id=$1 AND state='approved'", [id]);
        await tx.query("UPDATE report_public_copies SET state='held' WHERE report_id=$1 AND state='copying'", [id]);
      }
      await audit(tx, id, "public_copy_waiting_or_held", "publication-worker");
    });
    return;
  }
  if (!work) return;
  const copying = work;
  try {
    const verified = await storage.copy(copying.source.objectKey, copying.destination, copying.source.byteSize, copying.source.sha256);
    await transaction(db, async (tx) => {
      // Re-check consent, exact approval, current signatures and lifetime after I/O.
      const source = await approvedPublicSource(tx, id, image);
      const row = (await tx.query<PublicCopyRow>("SELECT * FROM report_public_copies WHERE report_id=$1 FOR UPDATE", [id])).rows[0];
      if (!row || row.state !== "copying" || row.lease_id !== copying.leaseId || row.lease_until!.getTime() <= Date.now()) return;
      requireCondition(source.sha256 === copying.source.sha256 && source.byteSize === copying.source.byteSize,
        409, "public_source_changed", "The approved model has changed.");
      await tx.query("UPDATE report_public_copies SET state='available',etag=$2,lease_id=NULL,lease_until=NULL WHERE report_id=$1", [id, verified.etag]);
      await audit(tx, id, "public_copy_available", "publication-worker");
    });
  } catch {
    // Provider output and keys must not enter logs or the public issue.
    await transaction(db, async (tx) => {
      await tx.query("SELECT id FROM model_reports WHERE id=$1 FOR UPDATE", [id]);
      await tx.query(`UPDATE report_public_copies SET state=CASE WHEN attempts>=3 THEN 'held' ELSE state END
        WHERE report_id=$1 AND state='copying' AND lease_id=$2`, [id, copying.leaseId]);
      await audit(tx, id, "public_copy_retry_or_hold", "publication-worker");
    });
  }
}
/** Releases quota only after provider deletion succeeds; each failure has its own backoff. */
export async function cleanupPublicCopies(db: Db, storage: PublicModelStorage): Promise<void> {
  const rows = await db.query<PublicCopyRow>(`SELECT c.* FROM report_public_copies c JOIN model_reports r ON r.id=c.report_id
    WHERE c.reserved_bytes>0 AND (c.state IN ('revoked','held') OR c.expires_at<now() OR r.status='deleted' OR r.expires_at<now())
      AND c.cleanup_after<=now() AND (c.lease_until IS NULL OR c.lease_until<now())
      AND NOT EXISTS (SELECT 1 FROM report_public_download_leases l WHERE l.expires_at>now()
        AND (l.report_id IS NULL OR l.object_key IS NULL OR (l.report_id=c.report_id AND l.object_key=c.object_key)))
      ORDER BY c.cleanup_after LIMIT 20`);
  for (const candidate of rows.rows) {
    try {
      await transaction(db, async (tx) => {
        const parents = await tx.query<{ status: string; expires_at: Date }>("SELECT status,expires_at FROM model_reports WHERE id=$1 FOR UPDATE", [candidate.report_id]);
        const row = (await tx.query<PublicCopyRow>("SELECT * FROM report_public_copies WHERE report_id=$1 FOR UPDATE", [candidate.report_id])).rows[0];
        const parent = parents.rows[0];
        if (!row || Number(row.reserved_bytes) === 0 || (row.lease_until && row.lease_until.getTime() > Date.now()) ||
          (!['revoked', 'held'].includes(row.state) && row.expires_at.getTime() > Date.now() && parent?.status !== 'deleted' && parent!.expires_at.getTime() > Date.now())) return;
        // Re-check after the canonical parent→copy locks: admission may have
        // committed its pin after the initial candidate query. Legacy unscoped
        // rows conservatively defer cleanup until their recorded expiry.
        const transfer = await tx.query(`SELECT 1 FROM report_public_download_leases
          WHERE expires_at>now() AND (report_id IS NULL OR object_key IS NULL OR
            (report_id=$1 AND object_key=$2)) LIMIT 1`, [row.report_id, row.object_key]);
        if (transfer.rowCount) return;
        await storage.delete(row.object_key);
        await tx.query(`UPDATE report_public_copies SET state=CASE WHEN state='held' THEN 'held' ELSE 'revoked' END,
          reserved_bytes=0,sha256=NULL,etag=NULL,byte_size=0,lease_id=NULL,lease_until=NULL,
          object_key='deleted-public/'||token WHERE report_id=$1`, [row.report_id]);
        await audit(tx, row.report_id, "public_copy_deleted", "retention");
      });
    } catch {
      await db.query(`UPDATE report_public_copies SET cleanup_attempts=cleanup_attempts+1,
        cleanup_after=now()+LEAST(3600,30*power(2,LEAST(cleanup_attempts,7))) * interval '1 second'
        WHERE report_id=$1 AND reserved_bytes>0`, [candidate.report_id]);
      console.warn("[report-service] public copy cleanup deferred");
    }
  }
  await db.query("DELETE FROM report_public_download_leases WHERE expires_at<now()");
  await db.query("DELETE FROM report_public_download_budget WHERE day<CURRENT_DATE-31");
}
