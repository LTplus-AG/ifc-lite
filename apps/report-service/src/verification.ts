/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { RestoreJournal } from "./restore-journal.js";
import type { ModelUpload } from "@ifc-lite/report-contract";
import { transaction, audit, type Db } from "./database.js";
import { requireCondition } from "./errors.js";
import type { UploadRow, ReportRow } from "./reports.js";
import type { ModelStorage } from "./storage.js";
import type { Session } from "./sessions.js";
import { uploadDto, verifyParts } from "./uploads.js";
export async function completeUpload(
  db: Db,
  storage: ModelStorage,
  row: UploadRow,
  owner: Session,
): Promise<ModelUpload> {
  return transaction(db, async (tx) => {
    const parent = await tx.query<ReportRow>(
      "SELECT * FROM model_reports WHERE id=$1 FOR UPDATE",
      [row.report_id],
    );
    requireCondition(
      parent.rows[0]?.status === "draft",
      409,
      "report_state",
      "Report no longer accepts uploads.",
    );
    const result = await tx.query<UploadRow>(
      "SELECT * FROM report_uploads WHERE id=$1 FOR UPDATE",
      [row.id],
    );
    const current = result.rows[0]!;
    if (current.status === "ready") return uploadDto(current);
    requireCondition(
      ["uploading", "verifying"].includes(current.status) &&
        current.multipart_id &&
        current.expires_at > new Date(),
      409,
      "upload_expired",
      "Upload is no longer active.",
    );
    // A completed object may exist after a previous complete response or DB commit
    // was lost. HEAD reconciles that durable outcome before attempting completion.
    let object: { size: number; checksum?: string } | undefined;
    try {
      object = await storage.head(current.object_key);
    } catch (error) {
      if (!(
        error instanceof Error && ["NotFound", "NoSuchKey"].includes(error.name)
      ))
        throw error;
    }
    if (!object) {
      const parts = await storage.parts(
        current.object_key,
        current.multipart_id,
      );
      verifyParts(current.input, parts, current.parts);
      await storage.complete(
        current.object_key,
        current.multipart_id,
        parts.map((part) => ({
          ...part,
          sha256: part.sha256 || current.parts[String(part.partNumber)]!,
        })),
      );
      object = await storage.head(current.object_key);
    }
    requireCondition(
      object.size === current.input.size,
      409,
      "object_mismatch",
      "Stored model size does not match.",
    );
    await tx.query("UPDATE report_uploads SET status='verifying' WHERE id=$1", [
      current.id,
    ]);
    await audit(tx, current.report_id, "upload_verification_queued", owner.id, {
      bytes: object.size,
    });
    current.status = "verifying";
    return uploadDto(current);
  });
}

export async function verifyNext(db: Db, storage: ModelStorage, journal?: RestoreJournal): Promise<void> {
  await transaction(db, async (lease) => {
    const lock = await lease.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('report-byte-verifier')) AS locked",
    );
    if (!lock.rows[0]?.locked) return;
    const candidates = await lease.query<UploadRow>(
      "SELECT u.* FROM report_uploads u JOIN model_reports r ON r.id=u.report_id WHERE u.status='verifying' AND u.verification_after<=now() AND u.expires_at>now() AND r.status='draft' AND r.expires_at>now() ORDER BY u.expires_at LIMIT 1",
    );
    const row = candidates.rows[0];
    if (!row) return;
    let checksum: string | undefined;
    let errorCode: string | undefined;
    try {
      checksum = await storage.verify(
        row.object_key,
        row.input.size,
        row.parts,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "model_verification_interrupted"
      )
        return;
      errorCode =
        error instanceof Error &&
        [
          "model_part_checksum_mismatch",
          "model_size_exceeded",
          "model_size_truncated",
          "model_part_count_mismatch",
          "model_size_mismatch",
        ].includes(error.message)
          ? error.message
          : undefined;
    }
    await transaction(db, async (tx) => {
      const parent = await tx.query<ReportRow>(
        "SELECT * FROM model_reports WHERE id=$1 FOR UPDATE",
        [row.report_id],
      );
      const current = await tx.query<UploadRow>(
        "SELECT * FROM report_uploads WHERE id=$1 FOR UPDATE",
        [row.id],
      );
      if (
        parent.rows[0]?.status !== "draft" ||
        parent.rows[0].expires_at <= new Date() ||
        !current.rows[0] ||
        current.rows[0].expires_at <= new Date() ||
        current.rows[0]?.status !== "verifying"
      )
        return;
      if (checksum) {
        await tx.query(
          "UPDATE report_uploads SET status='ready',verification_after=NULL,object_checksum=$2,completed_at=now(),expires_at=now()+interval '30 days' WHERE id=$1",
          [row.id, checksum],
        );
        await audit(tx, row.report_id, "upload_verified", "byte-verifier", {
          sha256: checksum,
          bytes: row.input.size,
        });
      } else if (errorCode) {
        if (journal) await journal.append(row.report_id, "remove-model");
        await tx.query(
          "UPDATE report_uploads SET status='failed',verification_after=NULL,expires_at=now() WHERE id=$1",
          [row.id],
        );
        await audit(
          tx,
          row.report_id,
          "upload_verification_failed",
          "byte-verifier",
          { code: errorCode },
        );
      } else {
        // Provider/read failures are not evidence of corrupt model bytes. Keep
        // durable state retryable, with a 10s..15min backoff and original expiry.
        await tx.query(
          `UPDATE report_uploads SET
            verification_after=now()+make_interval(secs => LEAST(900,10*power(2,LEAST(verification_attempts,7)))::integer),
            verification_attempts=LEAST(verification_attempts+1,1000000)
            WHERE id=$1`,
          [row.id],
        );
        await audit(
          tx,
          row.report_id,
          "upload_verification_retry",
          "byte-verifier",
        );
      }
    });
  });
}
