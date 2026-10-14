/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { transaction, type Db } from "./database.js";
import type { JournalCheckpoint, RestoreJournal } from "./restore-journal.js";
/** Operational recovery, never a startup migration. Requires externally enforced
 * quiescence. Success deliberately does NOT release the service hold: an operator
 * must reconcile external publication and finish provider cleanup independently. */
export async function reconcileRestore(db: Db, journal: RestoreJournal, witness: JournalCheckpoint): Promise<void> {
  // Commit the hold before touching untrusted restored state or fetching storage.
  await db.query(`CREATE TABLE IF NOT EXISTS report_restore_hold (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    held boolean NOT NULL DEFAULT true, checkpoint jsonb, reconciled_at timestamptz
  ); INSERT INTO report_restore_hold(singleton,held) VALUES(true,true)
    ON CONFLICT(singleton) DO UPDATE SET held=true,reconciled_at=NULL`);
  const entries = await journal.verify(witness);
  await transaction(db, async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('report-restore-reconciliation'))");
    // Restore grants are never inferred from snapshot-time ready/approved state.
    await tx.query("DELETE FROM report_sessions");
    await tx.query("DELETE FROM report_outbox");
    await tx.query("UPDATE report_uploads SET authorizations='{}'::jsonb,expires_at=LEAST(expires_at,now()),deletion_after=now()");
    await tx.query("UPDATE report_public_quarantine SET state='revoked',consent=NULL,approval=NULL,scan=NULL");
    await tx.query("UPDATE report_public_copies SET state='revoked',sha256=NULL,etag=NULL,cleanup_after=GREATEST(now(),COALESCE(lease_until,now()))");
    for (const entry of entries) {
      if (entry.action === "delete") {
        await tx.query("UPDATE model_reports SET status='deleted',draft='{}'::jsonb,agreement=NULL,agreement_pdf=NULL,custom_nda=NULL,issue_binding=NULL WHERE id=$1", [entry.reportId]);
      } else if (entry.action === "remove-model") {
        // Expiry schedules provider cleanup; never release reserved bytes early.
        await tx.query("UPDATE report_uploads SET expires_at=LEAST(expires_at,now()),deletion_after=now() WHERE report_id=$1", [entry.reportId]);
      }
    }
    await tx.query("UPDATE model_reports SET status='deleted',draft='{}'::jsonb,agreement=NULL,agreement_pdf=NULL,custom_nda=NULL,issue_binding=NULL WHERE expires_at<=now()");
    await tx.query("UPDATE report_uploads SET deletion_after=now() WHERE report_id IN (SELECT id FROM model_reports WHERE status='deleted') OR expires_at<=now()");
    // A second independently authenticated head comparison closes read drift.
    await journal.verify(witness);
    await tx.query("UPDATE report_restore_hold SET checkpoint=$1,reconciled_at=now() WHERE singleton", [JSON.stringify(witness)]);
  });
}
/** Guard usable by the future deployment entrypoint and all workers. Absence is
 * NOT evidence of safety for a restored volume: an external restore mode must
 * force a hold before starting the process. No release API is supplied here. */
export async function assertRestoreNotHeld(db: Db): Promise<void> {
  const exists = await db.query<{ present: boolean }>("SELECT to_regclass('report_restore_hold') IS NOT NULL AS present");
  if (!exists.rows[0]?.present) return;
  const held = await db.query<{ held: boolean }>("SELECT held FROM report_restore_hold WHERE singleton");
  if (held.rows.length !== 1 || held.rows[0]?.held !== false) throw new Error("report_restore_held");
}
