/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Reviewed error reports. Model visibility never changes GitHub issue visibility. */
export type ModelVisibility = "private" | "public";
export interface ReportDiagnostics {
  errorCode: string;
  appVersion: string;
  buildSha: string;
  browser?: string;
  eventId?: string;
  sessionId?: string;
}
export interface ReportDraftInput {
  clientRequestId: string;
  title: string;
  description: string;
  diagnostics: ReportDiagnostics;
  visibility: ModelVisibility;
}
export interface ReportLimits {
  maxFileBytes: number;
  partBytes: number;
  maxParallelParts: number;
  retentionDays: number;
}
export interface ReportAgreement {
  version: string;
  sha256: string;
  text: string;
  issuer: "LTplus AG";
  jurisdiction: "Switzerland";
  signingEnabled: boolean;
}
export interface ReportSession {
  csrfToken: string;
  limits: ReportLimits;
  agreement: ReportAgreement;
  storage: {
    provider: string;
    location: string;
    backupDisclosure: string;
    retentionDays: number;
    deletionDays: number;
    publicSharingEnabled: false;
  };
}
export interface AgreementAcceptanceInput {
  agreementSha256: string;
  signerName: string;
  signerEmail: string;
  organization: string;
  authorityConfirmed: true;
  accepted: true;
}
export interface AgreementReceipt {
  acceptedAt: string;
  pdfUrl: string;
  agreementSha256: string;
}
export interface UploadedPart {
  partNumber: number;
  size: number;
  etag: string;
  sha256: string;
  checksumVerified?: boolean;
}
export interface ModelUpload {
  id: string;
  partBytes: number;
  partCount: number;
  status: "uploading" | "verifying" | "ready" | "aborted" | "failed";
  uploadedParts: UploadedPart[];
}
export interface UploadInput {
  name: string;
  size: number;
  type: "application/octet-stream";
  confidentiality: "none" | "standard" | "custom";
  uploadConsent: true;
  publicModelConfirmed?: boolean;
}
export interface ReportReceipt {
  id: string;
  status: "draft" | "manual_review" | "submitted" | "published" | "deleted";
  issueUrl?: string;
  upload?: ModelUpload;
  draft?: ReportDraftInput;
  uploadSource?: {
    name: string;
    size: number;
    confidentiality: "none" | "standard" | "custom";
  };
  agreementAccepted?: boolean;
  customNdaStatus?: "pending" | "approved";
}
export interface PartAuthorization {
  url: string;
  expiresAt: string;
}
export interface ReportApiError {
  error: string;
  message: string;
}
export const REPORT_LIMITS: Readonly<ReportLimits> = Object.freeze({
  maxFileBytes: 2 * 1024 ** 3,
  partBytes: 16 * 1024 ** 2,
  maxParallelParts: 2,
  retentionDays: 30,
});
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function boundedText(
  value: unknown,
  max: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (allowEmpty || value.trim().length > 0) &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && ![9, 10, 13].includes(code);
    })
  );
}
export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
export function isDraftInput(value: unknown): value is ReportDraftInput {
  if (
    !isRecord(value) ||
    !isUuid(value.clientRequestId) ||
    !boundedText(value.title, 180) ||
    !boundedText(value.description, 10000, true) ||
    !["private", "public"].includes(String(value.visibility)) ||
    !isRecord(value.diagnostics)
  )
    return false;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "clientRequestId",
          "title",
          "description",
          "diagnostics",
          "visibility",
        ].includes(key),
    )
  )
    return false;
  const d = value.diagnostics;
  return (
    Object.keys(d).every((key) =>
      [
        "errorCode",
        "appVersion",
        "buildSha",
        "browser",
        "eventId",
        "sessionId",
      ].includes(key),
    ) &&
    boundedText(d.errorCode, 160) &&
    boundedText(d.appVersion, 80) &&
    boundedText(d.buildSha, 80) &&
    ["browser", "eventId", "sessionId"].every(
      (key) => d[key] === undefined || boundedText(d[key], 160),
    )
  );
}
export function isAgreementAcceptance(
  value: unknown,
): value is AgreementAcceptanceInput {
  return (
    isRecord(value) &&
    typeof value.agreementSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.agreementSha256) &&
    boundedText(value.signerName, 200) &&
    boundedText(value.signerEmail, 254) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.signerEmail) &&
    boundedText(value.organization, 200) &&
    value.authorityConfirmed === true &&
    value.accepted === true
  );
}
export function isUploadInput(
  value: unknown,
  maxBytes = REPORT_LIMITS.maxFileBytes,
): value is UploadInput {
  return (
    isRecord(value) &&
    boundedText(value.name, 240) &&
    !/[\\/]/.test(value.name) &&
    /\.(ifc|ifczip|ifcx)$/i.test(value.name) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) > 0 &&
    Number(value.size) <= maxBytes &&
    value.type === "application/octet-stream" &&
    ["none", "standard", "custom"].includes(String(value.confidentiality)) &&
    value.uploadConsent === true
  );
}
