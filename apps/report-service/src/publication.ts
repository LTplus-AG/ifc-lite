/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { audit, transaction, type Db } from "./database.js";
import { commitPublicationIntent } from "./publication-intent.js";
import type { GithubIssues } from "./github.js";
import type { ReportRow } from "./reports.js";
export async function publishOne(db: Db, github: GithubIssues): Promise<void> {
  // Global publisher lock covers fingerprint deduplication and timeout reconciliation
  // across service replicas. DB transaction retains ownership through GitHub I/O.
  await transaction(db, async (tx) => {
    const lock = await tx.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('report-github-publisher')) AS locked",
    );
    if (!lock.rows[0]?.locked) return;
    const rows = await tx.query<ReportRow>(
      "SELECT r.* FROM report_outbox o JOIN model_reports r ON r.id=o.report_id WHERE o.available_at<=now() AND r.status='submitted' AND r.expires_at>now() ORDER BY o.available_at LIMIT 1",
    );
    const candidate = rows.rows[0];
    if (!candidate) return;
    const lockedReport = await tx.query<ReportRow>(
      "SELECT * FROM model_reports WHERE id=$1 AND expires_at>now() FOR UPDATE",
      [candidate.id],
    );
    const report = lockedReport.rows[0];
    if (!report || report.status !== "submitted") return;
    await tx.query(
      "SELECT report_id FROM report_outbox WHERE report_id=$1 FOR UPDATE",
      [report.id],
    );
    try {
      const known = await tx.query<{ issue_url: string }>(
        "SELECT issue_url FROM report_fingerprints WHERE fingerprint=$1",
        [report.fingerprint],
      );
      const beforeCreate = async () => {
        if (report.expires_at <= new Date()) throw new Error("github_report_expired");
        await commitPublicationIntent(db, report.id);
        if (report.expires_at <= new Date()) throw new Error("github_report_expired");
      };
      const url =
        known.rows[0]?.issue_url ?? (report.issue_binding
          ? await github.addToIssue(report, report.issue_binding.issueUrl, beforeCreate)
          : await github.findOrCreate(report, beforeCreate));
      await tx.query(
        "INSERT INTO report_fingerprints(fingerprint,issue_url) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [report.fingerprint, url],
      );
      await tx.query(
        "UPDATE model_reports SET status='published',issue_url=$2 WHERE id=$1",
        [report.id, url],
      );
      await tx.query("DELETE FROM report_outbox WHERE report_id=$1", [
        report.id,
      ]);
      await audit(tx, report.id, "github_published", "publisher", {
        issueUrl: url,
      });
    } catch (error) {
      // Do not put raw upstream errors (which can contain request headers) in logs.
      const code =
        error instanceof Error && /^github_[a-z_0-9]+$/.test(error.message)
          ? error.message
          : "github_request_failed";
      await tx.query(
        "UPDATE report_outbox SET attempts=attempts+1,available_at=now()+interval '5 minutes',last_error=$2 WHERE report_id=$1",
        [report.id, code],
      );
    }
  });
}
