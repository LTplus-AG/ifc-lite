/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config } from "./config.js";
import { transaction, type Db } from "./database.js";
import { ReportError, requireCondition } from "./errors.js";
import type { PublicCopyRow } from "./public-release.js";
import type { PublicModelStorage } from "./public-storage.js";

const DOWNLOAD_MS = 15 * 60 * 1000;
async function admitDownload(db: Db, config: Config, token: string) {
  const limits = config.publicSharing;
  requireCondition(limits && /^[a-f0-9]{64}$/.test(token), 404, "not_found", "Not found.");
  requireCondition(Number.isSafeInteger(limits.maxDailyDownloadBytes) && limits.maxDailyDownloadBytes > 0 &&
    Number.isSafeInteger(limits.maxConcurrentDownloads) && limits.maxConcurrentDownloads > 0 && limits.maxConcurrentDownloads <= 4,
    503, "public_download_paused", "Public model downloads are temporarily unavailable.");
  return transaction(db, async (tx) => {
    const candidate = (await tx.query<{ report_id: string }>("SELECT report_id FROM report_public_copies WHERE token=$1", [token])).rows[0];
    requireCondition(candidate, 404, "not_found", "Not found.");
    const parent = (await tx.query<{ status: string; expires_at: Date }>("SELECT status,expires_at FROM model_reports WHERE id=$1 FOR SHARE", [candidate.report_id])).rows[0];
    const copy = (await tx.query<PublicCopyRow>("SELECT * FROM report_public_copies WHERE token=$1 FOR SHARE", [token])).rows[0];
    requireCondition(parent && parent.status === "published" && parent.expires_at.getTime() > Date.now() &&
      copy?.state === "available" && copy.expires_at.getTime() > Date.now() && copy.etag && copy.sha256,
      404, "not_found", "Not found.");
    // Validate the particular object before global admission: a slow cleanup of
    // another model must not monopolize the shared bandwidth lock.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('report-public-bandwidth'))");
    await tx.query("DELETE FROM report_public_download_leases WHERE expires_at<now()");
    const count = await tx.query<{ count: string }>("SELECT count(*) AS count FROM report_public_download_leases");
    requireCondition(Number(count.rows[0]?.count) < limits.maxConcurrentDownloads, 429,
      "public_download_busy", "Public model downloads are busy. Please try again shortly.");
    await tx.query("INSERT INTO report_public_download_budget(day) VALUES(CURRENT_DATE) ON CONFLICT DO NOTHING");
    const budget = (await tx.query<{ bytes: string }>("SELECT bytes FROM report_public_download_budget WHERE day=CURRENT_DATE FOR UPDATE")).rows[0]!;
    requireCondition(Number(budget.bytes) + Number(copy.byte_size) <= limits.maxDailyDownloadBytes,
      429, "public_download_allowance", "Today's public download allowance is used. Please try tomorrow.");
    // Conservatively charge the full transfer on admission, including interrupted downloads.
    await tx.query("UPDATE report_public_download_budget SET bytes=bytes+$1 WHERE day=CURRENT_DATE", [copy.byte_size]);
    const leaseId = randomUUID();
    const deadline = Date.now() + DOWNLOAD_MS;
    // Keep the immutable copy alive after admission, even before provider open.
    // Parent/copy SHARE locks serialize this durable pin with withdrawal/cleanup.
    await tx.query("INSERT INTO report_public_download_leases(id,expires_at,report_id,object_key) VALUES($1,$2,$3,$4)",
      [leaseId, new Date(deadline + 60000), copy.report_id, copy.object_key]);
    return { copy, leaseId, deadline };
  });
}
/** Anonymous, generic stream. No private object URL, filename or report identifier leaves this route. */
export async function downloadPublicModel(db: Db, storage: PublicModelStorage, config: Config,
  token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  requireCondition(req.method === "GET" && !req.headers.range, 416, "public_download_whole",
    "Download the complete model using its download link.");
  const { copy, leaseId, deadline } = await admitDownload(db, config, token);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
  res.once("close", abort);
  req.once("aborted", abort);
  // Admission may have waited on a database lock after the peer disconnected.
  if (req.aborted || res.destroyed || Date.now() >= deadline) controller.abort();
  try {
    controller.signal.throwIfAborted();
    const stream = await storage.open(copy.object_key, Number(copy.byte_size), copy.etag!, controller.signal);
    const reader = stream.getReader();
    const chunks = async function* () {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          yield chunk.value;
        }
      } finally {
        await reader.cancel().catch(() => console.warn("[report-service] public stream cancellation failed"));
        reader.releaseLock();
      }
    };
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", 'attachment; filename="model.ifc"');
    res.setHeader("Content-Length", copy.byte_size);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    await pipeline(Readable.from(chunks(), { objectMode: false }), res, { signal: controller.signal });
  } catch {
    if (res.headersSent || res.destroyed) res.destroy();
    else throw new ReportError(503, "public_download_unavailable", "The public model cannot be downloaded right now.");
  } finally {
    clearTimeout(timer);
    res.off("close", abort);
    req.off("aborted", abort);
    controller.abort();
    await db.query("DELETE FROM report_public_download_leases WHERE id=$1", [leaseId])
      .catch(() => console.warn("[report-service] public download lease cleanup deferred"));
  }
}
