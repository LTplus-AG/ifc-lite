# Report contract

Private workspace protocol for the viewer and report service. GitHub report text is public; `visibility` refers only to an optional model attachment. Files never enter analytics or GitHub issue bodies.

`@ifc-lite/report-contract` is private (not published). `apps/viewer`, `apps/viewer-embed` and `apps/report-service` import it.

## What it defines

- Report drafts and receipts: `ReportDraftInput` (title, description, public diagnostics, `visibility`, an optional verified issue target) and `ReportReceipt` (status, issue URL, upload, `publicModel` publication state, `issueDestination`).
- Sessions and the attachment agreement: `ReportSession`, `ReportAgreement`, `AgreementAcceptanceInput`, `AgreementReceipt`.
- Multipart model uploads: `UploadInput`, `ModelUpload`, `UploadedPart`, `PartAuthorization`, and the defaults in `REPORT_LIMITS` (2 GiB per file, 16 MiB parts, 2 parallel parts, 30-day retention).
- Runtime guards for every value that crosses the boundary: `isDraftInput`, `isAgreementAcceptance`, `isUploadInput`, `isReportCorrelation`, `isPublicSharingConsent`, plus the helpers `isRecord`, `boundedText` and `isUuid`.

## Public model sharing

Publishing a model attachment publicly is a separate opt-in. It is never inferred from `visibility` or from private support consent. `PublicSharingConsent` (version `public-model-v1`) must carry all five confirmations set to `true` (authority, redistribution reviewed, confidential content reviewed, downloaded copies cannot be recalled, publish a download link), and `isPublicSharingConsent` rejects any other shape. A receipt reports the outcome in `publicModel.state` (`quarantined`, `review`, `preparing`, `available`, `withdrawn` or `held`).

`ReportCorrelation` (event, session and build ids) is private and never part of the public GitHub diagnostics.
