/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isUuid, isRecord, boundedText } from "@ifc-lite/report-contract";
import type { Config } from "./config.js";
import { audit, type Db } from "./database.js";
import { ReportError, requireCondition } from "./errors.js";
import { secretEquals } from "./sessions.js";
import type { UploadRow } from "./reports.js";
import type { ModelStorage } from "./storage.js";
import { body, json } from "./http.js";
export async function admin(
  db: Db,
  storage: ModelStorage,
  config: Config,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  const auth = req.headers.authorization;
  requireCondition(
    typeof auth === "string" &&
      auth.startsWith("Bearer ") &&
      secretEquals(auth.slice(7), config.adminToken),
    401,
    "admin_auth",
    "Maintainer authentication required.",
  );
  if (path === "/api/reports/admin/pending" && req.method === "GET") {
    const result = await db.query(
      "SELECT id,status,created_at,expires_at,issue_url,custom_nda FROM model_reports WHERE status!='deleted' ORDER BY created_at DESC LIMIT 100",
    );
    await audit(db, null, "maintainer_queue_read", "configured-maintainer");
    json(res, { reports: result.rows });
    return;
  }
  const detail = /^\/api\/reports\/admin\/([^/]+)$/.exec(path);
  if (detail && isUuid(detail[1]) && req.method === "GET") {
    const result = await db.query(
      "SELECT id,status,created_at,expires_at,issue_url,draft,agreement,custom_nda FROM model_reports WHERE id=$1 AND expires_at>now() AND status!='deleted'",
      [detail[1]],
    );
    requireCondition(
      result.rows[0],
      404,
      "report_missing",
      "Report not found.",
    );
    await audit(
      db,
      detail[1],
      "maintainer_report_read",
      "configured-maintainer",
    );
    json(res, result.rows[0]);
    return;
  }
  const match = /^\/api\/reports\/admin\/([^/]+)\/(download|custom-nda)$/.exec(
    path,
  );
  const id = match?.[1];
  requireCondition(isUuid(id), 404, "not_found", "Not found.");
  if (match?.[2] === "download" && req.method === "POST") {
    const rows = await db.query<UploadRow>(
      "SELECT u.* FROM report_uploads u JOIN model_reports r ON r.id=u.report_id WHERE u.report_id=$1 AND u.status='ready' AND r.status!='deleted' AND r.expires_at>now()",
      [id],
    );
    const upload = rows.rows[0];
    requireCondition(upload, 404, "upload_missing", "Model not found.");
    await audit(db, id, "maintainer_download", "configured-maintainer");
    json(res, {
      url: await storage.download(upload.object_key, upload.input.name),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    return;
  }
  if (match?.[2] === "custom-nda" && req.method === "POST") {
    const input = await body(req);
    requireCondition(
      isRecord(input) &&
        input.accepted === true &&
        boundedText(input.signedAgreementReference, 500),
      400,
      "review_invalid",
      "Record the reviewed, signed agreement reference.",
    );
    const result = await db.query(
      "UPDATE model_reports SET status='draft',custom_nda=custom_nda || $2::jsonb WHERE id=$1 AND status='manual_review' RETURNING id",
      [
        id,
        JSON.stringify({
          status: "approved",
          reference: input.signedAgreementReference,
          acceptedAt: new Date().toISOString(),
        }),
      ],
    );
    requireCondition(
      result.rowCount === 1,
      409,
      "review_state",
      "No pending custom agreement.",
    );
    await audit(db, id, "custom_agreement_approved", "configured-maintainer");
    json(res, { id, status: "draft" });
    return;
  }
  throw new ReportError(404, "not_found", "Not found.");
}
