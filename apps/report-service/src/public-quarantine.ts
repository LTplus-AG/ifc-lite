/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { isPublicSharingConsent, type UploadInput } from "@ifc-lite/report-contract";
import { audit, transaction, type Db } from "./database.js";
import { requireCondition } from "./errors.js";
import type { ReportRow, UploadRow } from "./reports.js";

export const PUBLIC_SCAN_POLICY = "ifc-step-clamav-v1";
export const PUBLIC_MAX_BYTES = 1024 ** 3;
const LEASE_MS = 20 * 60 * 1000;
const SIGNATURE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
export interface ScanEvidence {
  outcome: "clean" | "infected" | "inconclusive";
  format: "ifc-step" | "unsupported";
  sha256: string;
  byteSize: number;
  policyVersion: string;
  imageDigest: string;
  engineVersion: string;
  signatureVersion: string;
  signaturesAt: string;
  finishedAt: string;
  /** Full file scanned without timeout, unsupported content or work-limit warning. */
  complete: boolean;
}
export interface ScanLease {
  reportId: string;
  uploadId: string;
  leaseId: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  policyVersion: string;
}
interface QuarantineRow {
  report_id: string;
  upload_id: string;
  state: "pending" | "scanning" | "review" | "approved" | "blocked" | "revoked";
  sha256: string | null;
  byte_size: string;
  policy_version: string;
  expires_at: Date;
  lease_id: string | null;
  lease_until: Date | null;
  attempts: number;
  scan: ScanEvidence | null;
}
export function requirePublicConsent(report: ReportRow, input: UploadInput): void {
  requireCondition(
    input.publicModelConfirmed === true && isPublicSharingConsent(input.publicSharingConsent) &&
      input.confidentiality === "none" && !report.agreement && !report.custom_nda,
    400, "public_consent", "Public sharing requires reviewed redistribution permission and no confidentiality agreement on this report.",
  );
  requireCondition(/\.ifc$/i.test(input.name) && input.size <= PUBLIC_MAX_BYTES,
    400, "public_format", "Public sharing supports uncompressed IFC files up to 1 GiB.");
}
/** Called inside the report's submission transaction, after its parent row lock. */
export async function queuePublicScan(tx: PoolClient, report: ReportRow, upload: UploadRow): Promise<void> {
  requirePublicConsent(report, upload.input);
  requireCondition(upload.status === "ready" && /^[a-f0-9]{64}$/.test(upload.object_checksum ?? ""),
    409, "public_integrity", "The complete model must pass integrity verification first.");
  await tx.query(`INSERT INTO report_public_quarantine
    (report_id,upload_id,state,sha256,byte_size,consent,policy_version,expires_at)
    VALUES($1,$2,'pending',$3,$4,$5,$6,$7)`,
    [report.id, upload.id, upload.object_checksum, upload.input.size,
      JSON.stringify(upload.input.publicSharingConsent), PUBLIC_SCAN_POLICY,
      new Date(Math.min(report.expires_at.getTime(), upload.expires_at.getTime()))]);
  await audit(tx, report.id, "public_model_quarantined", report.session_id);
}
async function locked(tx: PoolClient, id: string) {
  // Same lock order as upload, approval, deletion and eventual promotion.
  const reports = await tx.query<ReportRow>("SELECT * FROM model_reports WHERE id=$1 FOR UPDATE", [id]);
  const uploads = await tx.query<UploadRow>("SELECT * FROM report_uploads WHERE report_id=$1 FOR UPDATE", [id]);
  const jobs = await tx.query<QuarantineRow>("SELECT * FROM report_public_quarantine WHERE report_id=$1 FOR UPDATE", [id]);
  return { report: reports.rows[0], upload: uploads.rows[0], job: jobs.rows[0] };
}
function eligible(report: ReportRow | undefined, upload: UploadRow | undefined, job: QuarantineRow | undefined): boolean {
  return Boolean(report && upload && job && ["submitted", "published"].includes(report.status) &&
    report.expires_at.getTime() > Date.now() && upload.expires_at.getTime() > Date.now() &&
    job.expires_at.getTime() > Date.now() && !report.agreement && !report.custom_nda &&
    report.draft.visibility === "public" && upload.input.confidentiality === "none" &&
    upload.status === "ready" && job.upload_id === upload.id && job.sha256 === upload.object_checksum &&
    Number(job.byte_size) === upload.input.size && job.policy_version === PUBLIC_SCAN_POLICY);
}
/** Trusted isolated-scanner orchestrator only; never callable by an upload client. */
export async function claimPublicScan(db: Db): Promise<ScanLease | null> {
  const candidate = await db.query<{ report_id: string }>(`SELECT report_id FROM report_public_quarantine
    WHERE state='pending' OR (state='scanning' AND lease_until<now()) ORDER BY created_at LIMIT 1`);
  if (!candidate.rows[0]) return null;
  return transaction(db, async (tx) => {
    const { report, upload, job } = await locked(tx, candidate.rows[0]!.report_id);
    if (!job || !(job.state === "pending" || (job.state === "scanning" && job.lease_until!.getTime() < Date.now()))) return null;
    if (!eligible(report, upload, job) || job.attempts >= MAX_ATTEMPTS) {
      await tx.query("UPDATE report_public_quarantine SET state='blocked',lease_id=NULL,lease_until=NULL WHERE report_id=$1", [job.report_id]);
      return null;
    }
    const leaseId = randomUUID();
    await tx.query(`UPDATE report_public_quarantine SET state='scanning',lease_id=$2,
      lease_until=$3,attempts=attempts+1 WHERE report_id=$1`, [job.report_id, leaseId, new Date(Date.now() + LEASE_MS)]);
    return { reportId: job.report_id, uploadId: job.upload_id, leaseId, objectKey: upload!.object_key,
      sha256: job.sha256!, byteSize: Number(job.byte_size), policyVersion: job.policy_version };
  });
}
function cleanEvidence(scan: ScanEvidence, job: QuarantineRow, qualifiedImage: string): boolean {
  const finished = Date.parse(scan.finishedAt);
  const signatures = Date.parse(scan.signaturesAt);
  return scan.outcome === "clean" && scan.format === "ifc-step" && scan.complete === true && scan.sha256 === job.sha256 &&
    scan.byteSize === Number(job.byte_size) && scan.policyVersion === job.policy_version &&
    /^sha256:[a-f0-9]{64}$/.test(qualifiedImage) && scan.imageDigest === qualifiedImage &&
    scan.engineVersion.length <= 80 && /^\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?$/.test(scan.engineVersion) && /^\d{1,12}$/.test(scan.signatureVersion) &&
    Number.isFinite(finished) && Number.isFinite(signatures) && finished <= Date.now() &&
    finished >= (job.lease_until?.getTime() ?? 0) - LEASE_MS &&
    signatures <= finished && Date.now() - signatures <= SIGNATURE_AGE_MS;
}
/** No HTTP endpoint accepts scan verdicts; the trusted runner supplies bounded evidence. */
export async function finishPublicScan(db: Db, lease: ScanLease, scan: ScanEvidence, qualifiedImage: string): Promise<boolean> {
  return transaction(db, async (tx) => {
    const { report, upload, job } = await locked(tx, lease.reportId);
    if (!job || job.state !== "scanning" || job.lease_id !== lease.leaseId ||
      !job.lease_until || job.lease_until.getTime() <= Date.now() || !eligible(report, upload, job)) return false;
    const clean = cleanEvidence(scan, job, qualifiedImage);
    // Construct explicitly: a compromised scanner cannot persist arbitrary paths/output.
    const evidence = clean ? {
      outcome: "clean", format: "ifc-step", complete: true, sha256: job.sha256, byteSize: Number(job.byte_size),
      policyVersion: job.policy_version, imageDigest: qualifiedImage, engineVersion: scan.engineVersion,
      signatureVersion: scan.signatureVersion, signaturesAt: new Date(scan.signaturesAt).toISOString(),
      finishedAt: new Date(scan.finishedAt).toISOString(),
    } : null;
    await tx.query("UPDATE report_public_quarantine SET state=$2,scan=$3 WHERE report_id=$1",
      [job.report_id, clean ? "review" : "blocked", evidence ? JSON.stringify(evidence) : null]);
    await audit(tx, job.report_id, clean ? "public_scan_review_required" : "public_scan_held", "isolated-scanner");
    return clean;
  });
}
/** Malware clearance never replaces a separate human content/rights review. */
export async function approvePublicModel(db: Db, id: string, expectedSha256: string, qualifiedImage: string,
  reviewed: { redistribution: boolean; confidentialContent: boolean }): Promise<void> {
  await transaction(db, async (tx) => {
    const { report, upload, job } = await locked(tx, id);
    requireCondition(job && eligible(report, upload, job) && ["review", "approved"].includes(job.state) &&
      reviewed.redistribution === true && reviewed.confidentialContent === true &&
      job.sha256 === expectedSha256 && job.scan && cleanEvidence(job.scan, job, qualifiedImage),
      409, "public_review", "A fresh complete scan and a review of this exact model are required.");
    if (job.state === "approved") return;
    await tx.query("UPDATE report_public_quarantine SET state='approved',approval=$2 WHERE report_id=$1",
      [id, JSON.stringify({ sha256: job.sha256, policyVersion: job.policy_version, approvedAt: new Date().toISOString() })]);
    await audit(tx, id, "public_model_approved", "configured-maintainer");
  });
}
/** Parent must already be locked. In-flight scans can never revive this tombstone. */
export async function revokePublicQuarantine(tx: PoolClient, id: string): Promise<void> {
  await tx.query(`UPDATE report_public_quarantine SET state='revoked',sha256=NULL,consent=NULL,
    scan=NULL,approval=NULL,lease_id=NULL,lease_until=NULL,byte_size=0 WHERE report_id=$1`, [id]);
}
