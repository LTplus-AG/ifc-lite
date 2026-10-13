/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from "node:crypto";
import {
  REPORT_LIMITS,
  type UploadInput,
  type ModelUpload,
  type UploadedPart,
} from "@ifc-lite/report-contract";
import type { Config } from "./config.js";
import { transaction, audit, type Db } from "./database.js";
import { requireCondition } from "./errors.js";
import { requirePublicConsent } from "./public-quarantine.js";
import { ownedReport, type UploadRow, type ReportRow } from "./reports.js";
import type { Session } from "./sessions.js";
import type { ModelStorage } from "./storage.js";
export function verifyParts(
  input: UploadInput,
  parts: UploadedPart[],
  expected: Record<string, string>,
): void {
  const count = Math.ceil(input.size / REPORT_LIMITS.partBytes);
  requireCondition(
    parts.length === count,
    409,
    "parts_missing",
    "Some model parts are missing. Resume the upload.",
  );
  for (let i = 0; i < count; i++) {
    const part = parts[i];
    const size = Math.min(
      REPORT_LIMITS.partBytes,
      input.size - i * REPORT_LIMITS.partBytes,
    );
    requireCondition(
      part?.partNumber === i + 1 &&
        part.size === size &&
        Boolean(expected[String(i + 1)]) &&
        (!part.sha256 || part.sha256 === expected[String(i + 1)]),
      409,
      "part_mismatch",
      "A model part failed integrity verification. Retry that part.",
    );
  }
}
export async function uploadRow(
  db: Db,
  reportId: string,
  uploadId: string,
  owner: Session,
): Promise<UploadRow> {
  await ownedReport(db, reportId, owner);
  const rows = await db.query<UploadRow>(
    "SELECT * FROM report_uploads WHERE report_id=$1 AND id=$2",
    [reportId, uploadId],
  );
  requireCondition(rows.rows[0], 404, "upload_missing", "Upload not found.");
  return rows.rows[0];
}
export function uploadDto(
  row: UploadRow,
  parts: UploadedPart[] = [],
): ModelUpload {
  return {
    id: row.id,
    partBytes: REPORT_LIMITS.partBytes,
    partCount: Math.ceil(row.input.size / REPORT_LIMITS.partBytes),
    status: row.status === "initializing" ? "uploading" : row.status,
    sourceParts: Object.entries(row.parts).map(([number, sha256]) => ({
      partNumber: Number(number),
      size: Math.min(REPORT_LIMITS.partBytes, row.input.size - (Number(number) - 1) * REPORT_LIMITS.partBytes),
      sha256,
    })),
    uploadedParts: parts.map((part) => ({
      ...part,
      sha256: part.sha256 || row.parts[String(part.partNumber)] || "",
      checksumVerified: Boolean(part.sha256),
    })),
  };
}
export async function startUpload(
  db: Db,
  storage: ModelStorage,
  config: Config,
  id: string,
  owner: Session,
  input: UploadInput,
): Promise<ModelUpload> {
  const row = await transaction(db, async (tx) => {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtext('report-upload-capacity'))",
    );
    const rows = await tx.query<ReportRow>(
      "SELECT * FROM model_reports WHERE id=$1 AND session_id=$2 AND expires_at>now() FOR UPDATE",
      [id, owner.id],
    );
    const report = rows.rows[0];
    requireCondition(
      report && report.status === "draft",
      409,
      "report_state",
      "An editable report is required.",
    );
    requireCondition(
      input.confidentiality !== "standard" ||
        (config.agreement.signingEnabled &&
          report.agreement?.agreementSha256 === config.agreement.sha256),
      409,
      "agreement_required",
      "Accept the current standard agreement before uploading.",
    );
    requireCondition(
      input.confidentiality !== "custom" ||
        report.custom_nda?.status === "approved",
      409,
      "custom_agreement_pending",
      "Your custom agreement needs maintainer review.",
    );
    if (report.draft.visibility === "public") requirePublicConsent(report, input);
    const prior = await tx.query<UploadRow>(
      "SELECT * FROM report_uploads WHERE report_id=$1",
      [id],
    );
    if (prior.rows[0]) {
      requireCondition(
        [
          "name",
          "size",
          "type",
          "confidentiality",
          "uploadConsent",
          "publicModelConfirmed",
        ].every(
          (key) =>
            prior.rows[0]!.input[key as keyof UploadInput] ===
            input[key as keyof UploadInput],
        ) && (report.draft.visibility !== "public" || prior.rows[0].input.publicSharingConsent?.version === input.publicSharingConsent?.version) &&
          !["aborted", "failed"].includes(prior.rows[0].status),
        409,
        "upload_exists",
        "This report already has a different upload.",
      );
      return prior.rows[0];
    }
    const usage = await tx.query<{ bytes: string }>(
      "SELECT COALESCE(sum(reserved_bytes),0) AS bytes FROM report_uploads WHERE status != 'aborted'",
    );
    requireCondition(
      Number(usage.rows[0]?.bytes) + input.size <= config.maxStorageBytes,
      429,
      "storage_quota",
      "Model storage is temporarily full. Submit the report without a model.",
    );
    const quota = await tx.query<{ bytes: string }>(
      "SELECT bytes FROM report_admission WHERE key=$1 AND day=CURRENT_DATE FOR UPDATE",
      [owner.admission],
    );
    requireCondition(
      Number(quota.rows[0]?.bytes ?? 0) + input.size <= config.maxDailyBytes,
      429,
      "upload_quota",
      "Daily upload allowance reached.",
    );
    await tx.query(
      "INSERT INTO report_admission(key,bytes) VALUES($1,$2) ON CONFLICT(key,day) DO UPDATE SET bytes=report_admission.bytes+EXCLUDED.bytes",
      [owner.admission, input.size],
    );
    const uploadId = randomUUID();
    const key = `private/${id}/${uploadId}`;
    const result = await tx.query<UploadRow>(
      "INSERT INTO report_uploads(id,report_id,object_key,input,reserved_bytes) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [uploadId, id, key, JSON.stringify(input), input.size],
    );
    await audit(tx, id, "upload_consent", owner.id, {
      confidentiality: input.confidentiality,
      visibility: report.draft.visibility,
      bytes: input.size,
    });
    return result.rows[0]!;
  });
  if (!row.multipart_id) {
    // Serialize external initialization across retries; crash-created orphan parts
    // are bounded by the bucket's mandatory 1-day multipart lifecycle.
    return transaction(db, async (tx) => {
      const parent = await tx.query<ReportRow>(
        "SELECT * FROM model_reports WHERE id=$1 FOR UPDATE",
        [id],
      );
      requireCondition(
        parent.rows[0]?.status === "draft",
        409,
        "report_state",
        "Report no longer accepts uploads.",
      );
      const locked = await tx.query<UploadRow>(
        "SELECT * FROM report_uploads WHERE id=$1 FOR UPDATE",
        [row.id],
      );
      const current = locked.rows[0]!;
      requireCondition(
        ["initializing", "uploading"].includes(current.status),
        409,
        "upload_state",
        "Upload was cancelled.",
      );
      if (!current.multipart_id) {
        const multipartId = await storage.create(current.object_key);
        await tx.query(
          "UPDATE report_uploads SET multipart_id=$2,status='uploading' WHERE id=$1",
          [current.id, multipartId],
        );
        current.multipart_id = multipartId;
        current.status = "uploading";
      }
      return uploadDto(current);
    });
  }
  return uploadDto(
    row,
    row.status === "uploading"
      ? await storage.parts(row.object_key, row.multipart_id)
      : [],
  );
}
export async function authorizePart(
  db: Db,
  storage: ModelStorage,
  row: UploadRow,
  part: number,
  checksum: string,
): Promise<{ url: string; expiresAt: string }> {
  requireCondition(
    Number.isSafeInteger(part) &&
      part >= 1 &&
      part <= Math.ceil(row.input.size / REPORT_LIMITS.partBytes) &&
      /^[A-Za-z0-9+/]{43}=$/.test(checksum),
    400,
    "part_invalid",
    "Invalid upload part.",
  );
  const size = Math.min(
    REPORT_LIMITS.partBytes,
    row.input.size - (part - 1) * REPORT_LIMITS.partBytes,
  );
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
    const rows = await tx.query<UploadRow>(
      "SELECT * FROM report_uploads WHERE id=$1 FOR UPDATE",
      [row.id],
    );
    const current = rows.rows[0]!;
    requireCondition(
      current.status === "uploading" &&
        current.multipart_id &&
        current.expires_at > new Date(),
      409,
      "upload_expired",
      "This upload is no longer active.",
    );
    requireCondition(
      !current.parts[String(part)] || current.parts[String(part)] === checksum,
      409,
      "source_changed",
      "The selected model differs from the upload being resumed.",
    );
    const uploaded = new Set(
      (await storage.parts(current.object_key, current.multipart_id)).map((p) =>
        String(p.partNumber),
      ),
    );
    const active = Object.entries(current.authorizations).filter(
      ([number, expires]) =>
        number !== String(part) &&
        expires > Date.now() &&
        !uploaded.has(number),
    );
    requireCondition(
      active.length < REPORT_LIMITS.maxParallelParts,
      429,
      "parts_busy",
      "Wait for an active model part to finish.",
    );
    const expiresAt = Date.now() + 300000;
    await tx.query(
      "UPDATE report_uploads SET parts=parts || $2::jsonb,authorizations=$3 WHERE id=$1",
      [
        row.id,
        JSON.stringify({ [part]: checksum }),
        JSON.stringify({ ...Object.fromEntries(active), [part]: expiresAt }),
      ],
    );
    return {
      url: await storage.signPart(
        current.object_key,
        current.multipart_id,
        part,
        checksum,
        size,
      ),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  });
}
export { completeUpload } from "./verification.js";
