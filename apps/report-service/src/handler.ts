/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  REPORT_LIMITS,
  isDraftInput,
  isAgreementAcceptance,
  isUploadInput,
  isRecord,
  boundedText,
  isUuid,
  isReportCorrelation,
} from "@ifc-lite/report-contract";
import type { Config } from "./config.js";
import { type Db } from "./database.js";
import { ReportError, requireCondition } from "./errors.js";
import {
  session,
  requireMutation,
  secretEquals,
  refreshSessionCookie,
} from "./sessions.js";
import {
  createReport,
  requestCustomAgreement,
  ownedReport,
  receipt,
  submitReport,
  type UploadRow,
} from "./reports.js";
import { acceptAgreement } from "./agreement.js";
import {
  startUpload,
  uploadRow,
  uploadDto,
  authorizePart,
  completeUpload,
} from "./uploads.js";
import { removeUpload, deleteReport } from "./maintenance.js";
import type { ModelStorage } from "./storage.js";
import { body, json } from "./http.js";
import { resolveIssueTarget } from "./issue-binding.js";
import { admin } from "./admin.js";
import type { PublicModelStorage } from "./public-storage.js";
import { publicModelReceipt, withdrawPublicModel } from "./public-release.js";
import { downloadPublicModel } from "./public-download.js";
import { PUBLIC_MAX_BYTES } from "./public-quarantine.js";
export function createHandler(
  db: Db,
  storage: ModelStorage,
  config: Config,
  publicStorage?: PublicModelStorage,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const path = new URL(req.url ?? "/", config.origin).pathname;
      const method = req.method ?? "GET";
      if (path === "/healthz" && method === "GET") {
        await db.query("SELECT 1");
        json(res, { ok: true });
        return;
      }
      requireCondition(
        path.startsWith("/api/reports/"),
        404,
        "not_found",
        "Not found.",
      );
      const publicDownload = /^\/api\/reports\/public\/([a-f0-9]{64})$/.exec(path);
      if (publicDownload) {
        requireCondition(publicStorage && config.publicSharing, 404, "not_found", "Not found.");
        await downloadPublicModel(db, publicStorage, config, publicDownload[1]!, req, res);
        return;
      }
      if (path.startsWith("/api/reports/admin/")) {
        await admin(db, storage, config, req, res, path);
        return;
      }
      const qualification = req.headers["x-ifclite-qualification"];
      const admitted =
        config.submissionsEnabled ||
        Boolean(
          config.qualificationToken &&
          typeof qualification === "string" &&
          secretEquals(qualification, config.qualificationToken),
        );
      if (path === "/api/reports/capabilities" && method === "GET") {
        json(res, { submissionsEnabled: admitted });
        return;
      }
      // Disabling admission must not remove existing owners' read/delete rights.
      if (method !== "GET" && method !== "DELETE")
        requireCondition(
          admitted,
          503,
          "submissions_disabled",
          "Reporting is not accepting new submissions yet.",
        );
      const sessionRequest =
        path === "/api/reports/session" && method === "GET";
      if (sessionRequest) {
        // Same-origin GET fetches may omit Origin. Browser metadata still rejects
        // cross-origin embeds before they can consume the session admission quota.
        const origin = req.headers.origin;
        const site = req.headers["sec-fetch-site"];
        requireCondition(
          (origin === undefined || origin === config.origin) &&
            (site === undefined || site === "same-origin" || site === "none"),
          403,
          "session_origin",
          "Open reporting directly in IFC Lite.",
        );
      }
      const owner = await session(
        db,
        config,
        req,
        res,
        sessionRequest && admitted,
      ).catch((error) => {
        if (
          sessionRequest &&
          !admitted &&
          error instanceof ReportError &&
          error.code === "session_expired"
        )
          throw new ReportError(
            503,
            "submissions_disabled",
            "Reporting is not accepting new submissions yet.",
          );
        throw error;
      });
      if (method !== "GET") requireMutation(config, req, owner);
      if (path === "/api/reports/session" && method === "GET") {
        json(res, {
          csrfToken: owner.csrf,
          submissionsEnabled: admitted,
          issueLinkingEnabled: Boolean(config.posthog),
          limits: REPORT_LIMITS,
          agreement: config.agreement,
          storage: {
            provider: config.storageProvider,
            location: config.storageLocation,
            backupDisclosure: config.backupDisclosure,
            retentionDays: 30,
            deletionDays: 7,
            publicSharingEnabled: Boolean(config.publicSharing && publicStorage),
            publicMaxFileBytes: PUBLIC_MAX_BYTES,
          },
        });
        return;
      }
      if (path === "/api/reports/resolve-issue" && method === "POST") {
        const input = await body(req);
        requireCondition(isReportCorrelation(input), 400, "correlation_invalid", "An exact captured error is needed to check for an existing issue.");
        json(res, await resolveIssueTarget(db, config, owner, input));
        return;
      }
      if (path === "/api/reports/drafts" && method === "POST") {
        const input = await body(req);
        requireCondition(
          isDraftInput(input),
          400,
          "draft_invalid",
          "Review the report fields.",
        );
        requireCondition(
          input.visibility === "private" || Boolean(config.publicSharing && publicStorage),
          409,
          "public_unavailable",
          "Public model sharing is not yet available.",
        );
        const created = await createReport(db, config, owner, input);
        refreshSessionCookie(req, res, owner);
        json(res, created, 201);
        return;
      }
      const match = /^\/api\/reports\/([^/]+)(?:\/(.*))?$/.exec(path);
      const id = match?.[1];
      requireCondition(isUuid(id), 404, "not_found", "Not found.");
      const action = match?.[2] ?? "";
      const report = await ownedReport(db, id, owner);
      if (action === "" && method === "GET") {
        const uploads = await db.query<UploadRow>(
          "SELECT * FROM report_uploads WHERE report_id=$1",
          [id],
        );
        json(res, {
          ...receipt(report),
          draft: report.draft,
          publicModel: report.draft.visibility === "public" ? await publicModelReceipt(db, config, id) : undefined,
          customNdaStatus: report.custom_nda?.status,
          agreementAccepted: Boolean(
            report.agreement?.agreementSha256 === config.agreement.sha256,
          ),
          ...(uploads.rows[0]
            ? {
                upload: uploadDto(uploads.rows[0]),
                uploadSource: {
                  name: uploads.rows[0].input.name,
                  size: uploads.rows[0].input.size,
                  confidentiality: uploads.rows[0].input.confidentiality,
                  publicSharingConsent: uploads.rows[0].input.publicSharingConsent,
                },
              }
            : {}),
        });
        return;
      }
      if (action === "" && method === "DELETE") {
        await deleteReport(db, storage, id, owner.id);
        json(res, { id, status: "deleted" });
        return;
      }
      if (action === "public-model" && method === "DELETE") {
        await withdrawPublicModel(db, id, owner.id);
        json(res, { ...receipt(report), publicModel: { state: "withdrawn" } });
        return;
      }
      if (action === "consent" && method === "POST") {
        const input = await body(req);
        requireCondition(
          isAgreementAcceptance(input),
          400,
          "consent_invalid",
          "Complete and accept the agreement.",
        );
        json(res, await acceptAgreement(db, config, id, owner, input));
        return;
      }
      if (action === "agreement.pdf" && method === "GET") {
        const rows = await db.query<{ agreement_pdf: Buffer | null }>(
          "SELECT agreement_pdf FROM model_reports WHERE id=$1",
          [id],
        );
        const pdf = rows.rows[0]?.agreement_pdf;
        requireCondition(
          pdf,
          404,
          "agreement_missing",
          "No accepted agreement is available.",
        );
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="IFC-Lite-confidentiality-receipt.pdf"',
        );
        res.end(pdf);
        return;
      }
      if (action === "custom-nda" && method === "POST") {
        const input = await body(req);
        requireCondition(
          isRecord(input) && boundedText(input.message, 10000),
          400,
          "custom_invalid",
          "Describe your custom agreement request.",
        );
        await requestCustomAgreement(db, id, owner, input.message);
        json(res, { id, status: "manual_review" });
        return;
      }
      if (action === "uploads" && method === "POST") {
        const input = await body(req);
        requireCondition(
          isUploadInput(input),
          400,
          "upload_invalid",
          "Choose an IFC, IFCZIP or IFCX model within the size limit.",
        );
        json(
          res,
          await startUpload(db, storage, config, id, owner, input),
          201,
        );
        return;
      }
      const uploadMatch =
        /^uploads\/([^/]+)(?:\/(parts|complete|abort))?$/.exec(action);
      if (uploadMatch && isUuid(uploadMatch[1])) {
        const row = await uploadRow(db, id, uploadMatch[1], owner);
        const step = uploadMatch[2];
        if (!step && method === "GET") {
          json(
            res,
            uploadDto(
              row,
              row.status === "uploading" && row.multipart_id
                ? await storage.parts(row.object_key, row.multipart_id)
                : [],
            ),
          );
          return;
        }
        if (step === "parts" && method === "POST") {
          const input = await body(req);
          requireCondition(
            isRecord(input) &&
              typeof input.partNumber === "number" &&
              typeof input.sha256 === "string",
            400,
            "part_invalid",
            "Invalid part.",
          );
          json(
            res,
            await authorizePart(
              db,
              storage,
              row,
              input.partNumber,
              input.sha256,
            ),
          );
          return;
        }
        if (step === "complete" && method === "POST") {
          await body(req);
          json(res, await completeUpload(db, storage, row, owner));
          return;
        }
        if (step === "abort" && method === "POST") {
          await body(req);
          await removeUpload(db, storage, row, owner.id);
          json(res, { ...uploadDto(row), status: "aborted" });
          return;
        }
      }
      if (action === "submit" && method === "POST") {
        const input = await body(req);
        requireCondition(
          isRecord(input),
          400,
          "submit_invalid",
          "Review your report.",
        );
        json(
          res,
          { ...await submitReport(db, id, owner, input.publicModelConfirmed === true),
            publicModel: report.draft.visibility === "public" ? await publicModelReceipt(db, config, id) : undefined },
          202,
        );
        return;
      }
      throw new ReportError(404, "not_found", "Not found.");
    } catch (error) {
      if (error instanceof ReportError)
        json(res, { error: error.code, message: error.message }, error.status);
      else {
        console.error("[report-service] request failed", "request_failed");
        json(
          res,
          {
            error: "service_unavailable",
            message:
              "The report service is unavailable. Your report has not been discarded; retry shortly.",
          },
          503,
        );
      }
    }
  };
}
