/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from "node:crypto";
import type {
  ReportDraftInput,
  ReportReceipt,
  UploadInput,
} from "@ifc-lite/report-contract";
import type { Config } from "./config.js";
import { audit, transaction, type Db } from "./database.js";
import { verifyIssueBinding, type IssueBinding } from "./issue-binding.js";
import { requireCondition } from "./errors.js";
import { queuePublicScan } from "./public-quarantine.js";
import type { Session } from "./sessions.js";
export interface ReportRow {
  id: string;
  created_at: Date;
  expires_at: Date;
  session_id: string;
  draft: ReportDraftInput;
  status: ReportReceipt["status"];
  agreement: Record<string, unknown> | null;
  custom_nda: { status: string; message: string } | null;
  issue_url: string | null;
  fingerprint: string;
  publication_hold?: boolean;
  issue_binding?: IssueBinding | null;
}
export interface UploadRow {
  id: string;
  report_id: string;
  object_key: string;
  multipart_id: string | null;
  input: UploadInput;
  status:
    "initializing" | "uploading" | "verifying" | "ready" | "aborted" | "failed";
  parts: Record<string, string>;
  authorizations: Record<string, number>;
  object_checksum?: string | null;
  expires_at: Date;
}
// Every existing-report receipt uses the same durable publication hold projection.
const RECEIPT_REPORT_SELECT = `SELECT r.*, (r.status='submitted' AND EXISTS(
  SELECT 1 FROM report_publication_intents i WHERE i.report_id=r.id
)) AS publication_hold FROM model_reports r`;

export async function ownedReport(
  db: Db,
  id: string,
  owner: Session,
): Promise<ReportRow> {
  const r = await db.query<ReportRow>(
    `${RECEIPT_REPORT_SELECT} WHERE id=$1 AND session_id=$2 AND expires_at>now()`,
    [id, owner.id],
  );
  requireCondition(
    r.rows[0],
    404,
    "report_missing",
    "Report not found or expired.",
  );
  return r.rows[0];
}
export function receipt(r: ReportRow): ReportReceipt {
  return {
    id: r.id,
    status: r.status,
    ...(r.publication_hold ? { publicationHold: "review_required" as const } : {}),
    ...(r.issue_binding ? { issueDestination: { issueUrl: r.issue_binding.issueUrl, title: r.issue_binding.title } } : {}),
    ...(r.issue_url ? { issueUrl: r.issue_url } : {}),
  };
}
export async function createReport(
  db: Db,
  config: Config,
  owner: Session,
  input: ReportDraftInput,
): Promise<ReportReceipt> {
  let renewedExpiry: Date | undefined;
  const result = await transaction(db, async (tx) => {
    async function renewOwner(expiresAt: Date): Promise<void> {
      // Internal CLI/fixture owners do not represent authenticated browser rows.
      if (!owner.expiresAt) return;
      const renewed = await tx.query<{ expires_at: Date }>(
        "UPDATE report_sessions SET expires_at=GREATEST(expires_at,$2) WHERE id=$1 AND expires_at>now() RETURNING expires_at",
        [owner.id, expiresAt],
      );
      requireCondition(
        renewed.rows[0],
        401,
        "session_expired",
        "Your report session expired. Start a new report.",
      );
      renewedExpiry = renewed.rows[0].expires_at;
    }
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      owner.admission,
    ]);
    const existing = await tx.query<ReportRow>(
      `${RECEIPT_REPORT_SELECT} WHERE session_id=$1 AND client_key=$2`,
      [owner.id, input.clientRequestId],
    );
    if (existing.rows[0]) {
      await renewOwner(existing.rows[0].expires_at);
      return receipt(existing.rows[0]);
    }
    await tx.query(
      "INSERT INTO report_admission(key) VALUES($1) ON CONFLICT DO NOTHING",
      [owner.admission],
    );
    const admission = await tx.query<{ reports: number }>(
      "SELECT reports FROM report_admission WHERE key=$1 AND day=CURRENT_DATE FOR UPDATE",
      [owner.admission],
    );
    requireCondition(
      (admission.rows[0]?.reports ?? 0) < config.maxDailyReports,
      429,
      "report_quota",
      "Daily report allowance reached. Please try tomorrow.",
    );
    await tx.query(
      "UPDATE report_admission SET reports=reports+1 WHERE key=$1 AND day=CURRENT_DATE",
      [owner.admission],
    );
    const binding = input.issueTarget ? verifyIssueBinding(config, owner, input.issueTarget, input.diagnostics.buildSha) : null;
    const { issueTarget: _issueTarget, ...publicDraft } = input;
    const id = randomUUID();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          input.diagnostics.errorCode,
          input.diagnostics.buildSha,
          id,
        ]),
      )
      .digest("hex");
    const inserted = await tx.query<ReportRow>(
      "INSERT INTO model_reports(id,session_id,client_key,draft,fingerprint,issue_binding) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [id, owner.id, input.clientRequestId, JSON.stringify(publicDraft), fingerprint, binding ? JSON.stringify(binding) : null],
    );
    await renewOwner(inserted.rows[0]!.expires_at);
    await audit(tx, id, "draft_created", owner.id);
    if (binding) await audit(tx, id, "issue_target_reviewed", owner.id);
    return receipt(inserted.rows[0]!);
  });
  if (renewedExpiry) owner.expiresAt = renewedExpiry;
  return result;
}
export async function submitReport(
  db: Db,
  id: string,
  owner: Session,
  publicConfirmed: boolean,
): Promise<ReportReceipt> {
  return transaction(db, async (tx) => {
    const result = await tx.query<ReportRow>(
      `${RECEIPT_REPORT_SELECT} WHERE id=$1 AND session_id=$2 AND expires_at>now() FOR UPDATE`,
      [id, owner.id],
    );
    const report = result.rows[0];
    requireCondition(report, 404, "report_missing", "Report not found.");
    if (report.status === "submitted" || report.status === "published")
      return receipt(report);
    requireCondition(
      report.status === "draft",
      409,
      "report_state",
      "This report cannot be submitted yet.",
    );
    const uploads = await tx.query<UploadRow>(
      "SELECT * FROM report_uploads WHERE report_id=$1",
      [id],
    );
    if (uploads.rows[0] && uploads.rows[0].status !== "aborted") {
      requireCondition(
        uploads.rows[0].status === "ready",
        409,
        "upload_pending",
        "Finish or remove the model upload first.",
      );
      requireCondition(
        report.draft.visibility !== "public" || publicConfirmed,
        400,
        "public_consent",
        "Confirm public model sharing explicitly.",
      );
    }
    if (report.draft.visibility === "public" && uploads.rows[0]?.status === "ready")
      await queuePublicScan(tx, report, uploads.rows[0]);
    await tx.query("UPDATE model_reports SET status='submitted' WHERE id=$1", [
      id,
    ]);
    await tx.query(
      "INSERT INTO report_outbox(report_id) VALUES($1) ON CONFLICT DO NOTHING",
      [id],
    );
    await audit(tx, id, "report_submitted", owner.id, {
      publicModelConfirmed: publicConfirmed,
    });
    return receipt({ ...report, status: "submitted" });
  });
}

export async function requestCustomAgreement(
  db: Db,
  id: string,
  owner: Session,
  message: string,
): Promise<void> {
  await transaction(db, async (tx) => {
    const result = await tx.query<ReportRow>(
      "SELECT * FROM model_reports WHERE id=$1 AND session_id=$2 AND expires_at>now() FOR UPDATE",
      [id, owner.id],
    );
    const report = result.rows[0];
    requireCondition(
      report && ["draft", "manual_review"].includes(report.status),
      409,
      "report_state",
      "An editable report is required.",
    );
    const uploads = await tx.query(
      "SELECT id FROM report_uploads WHERE report_id=$1 AND status!='aborted'",
      [id],
    );
    requireCondition(
      uploads.rowCount === 0,
      409,
      "upload_exists",
      "Remove the existing model before requesting a custom agreement.",
    );
    await tx.query(
      "UPDATE model_reports SET status='manual_review',custom_nda=$2 WHERE id=$1",
      [id, JSON.stringify({ status: "pending", message })],
    );
    await audit(tx, id, "custom_agreement_requested", owner.id);
  });
}
