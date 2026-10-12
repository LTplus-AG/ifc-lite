/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { audit, transaction, type Db } from "./database.js";
import type { ModelStorage } from "./storage.js";
import type { ReportRow, UploadRow } from "./reports.js";
export async function removeUpload(
  db: Db,
  storage: ModelStorage,
  row: UploadRow,
  actor: string,
): Promise<void> {
  await transaction(db, async (tx) => {
    const parent = await tx.query<{ status: string; expires_at: Date }>(
      "SELECT status,expires_at FROM model_reports WHERE id=$1 FOR UPDATE",
      [row.report_id],
    );
    const result = await tx.query<UploadRow>(
      "SELECT * FROM report_uploads WHERE id=$1 FOR UPDATE",
      [row.id],
    );
    const current = result.rows[0];
    if (!current) return;
    if (
      actor === "retention" &&
      current.expires_at > new Date() &&
      parent.rows[0]?.status !== "deleted" &&
      parent.rows[0]!.expires_at > new Date()
    )
      return;
    storage.cancelVerification(current.object_key);
    if (current.multipart_id)
      await storage.abort(current.object_key, current.multipart_id);
    await storage.delete(current.object_key);
    await tx.query(
      "UPDATE report_uploads SET status='aborted',reserved_bytes=0,input=jsonb_set(input,'{name}','\"deleted\"'::jsonb) WHERE id=$1",
      [current.id],
    );
    await audit(tx, current.report_id, "model_deleted", actor);
  });
}
export async function sweep(db: Db, storage: ModelStorage): Promise<void> {
  const uploads = await db.query<UploadRow>(
    "SELECT u.* FROM report_uploads u JOIN model_reports r ON r.id=u.report_id WHERE u.status!='aborted' AND (u.expires_at<now() OR r.expires_at<now() OR r.status='deleted') LIMIT 20",
  );
  for (const row of uploads.rows)
    await removeUpload(db, storage, row, "retention");
  await db.query(
    "UPDATE model_reports SET status='deleted',agreement=NULL,agreement_pdf=NULL,custom_nda=NULL,draft='{}'::jsonb WHERE expires_at<now() AND NOT EXISTS(SELECT 1 FROM report_uploads u WHERE u.report_id=model_reports.id AND u.status!='aborted')",
  );
  await db.query("DELETE FROM report_sessions WHERE expires_at<now()");
  await db.query("DELETE FROM report_admission WHERE day<CURRENT_DATE-31");
  await db.query("DELETE FROM report_audit WHERE at<now()-interval '90 days'");
}
export async function deleteReport(
  db: Db,
  storage: ModelStorage,
  id: string,
  ownerId: string,
): Promise<void> {
  await transaction(db, async (tx) => {
    const locked = await tx.query<ReportRow>(
      "SELECT * FROM model_reports WHERE id=$1 AND session_id=$2 FOR UPDATE",
      [id, ownerId],
    );
    if (!locked.rows[0]) return;
    await tx.query(
      "UPDATE model_reports SET status='deleted',agreement=NULL,agreement_pdf=NULL,custom_nda=NULL,draft='{}'::jsonb WHERE id=$1",
      [id],
    );
    await tx.query("DELETE FROM report_outbox WHERE report_id=$1", [id]);
    await audit(tx, id, "report_deletion_requested", ownerId);
  });
  // Durable tombstone commits before storage I/O. Retention retries failures.
  const uploads = await db.query<UploadRow>(
    "SELECT * FROM report_uploads WHERE report_id=$1",
    [id],
  );
  if (uploads.rows[0])
    await removeUpload(db, storage, uploads.rows[0], ownerId);
}
