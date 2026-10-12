# Model reporting qualification (#7495)

The native T3 preview exercised the real viewer, PostgreSQL report service and private encrypted S3-compatible storage on this development host. The incident was deliberately offered for qualification; it was not a production crash. The GitHub publisher was disabled during this browser run, so the receipt proves durable submission, not live issue creation.

The catalogued Archicad `AC20-FZK-Haus.ifc` fixture contained 2,526,511 bytes. No mutation or model transfer occurred before the final Send action. The browser performed one draft creation, one upload creation, one part PUT and one report submission. Upload completion returned `verifying`; the browser waited for the server's `ready` status before submitting. The authenticated maintainer download matched the original SHA-256, while anonymous object access returned HTTP 403. See `private-model-receipt.json`.

A separate transport qualification uploaded the same public fixture and an explicitly synthetic 616 MiB object in 39 bounded parts. It recreated the database/storage adapters after the first part, compared the stored full-file hash with the source hash, and deleted the test objects. Peak process RSS includes upload and server-side verification. This is a functional transfer check, not a rendering benchmark or proof of a production hosting service. See `large-transfer.json`.

Automated checks exercise real HTTP ownership, origin/CSRF enforcement, report and session expiry, multipart integrity, deletion/publication races, optional NDA gating and an approved **test** agreement with a Unicode signer and a parsed PDF receipt. Production automatic issuance remains disabled: the LTplus AG draft has not been approved. Public model sharing also remains unavailable in this implementation.

The viewer displays the actual storage provider, location, retention and backup disclosures before consent. The selected private filename is absent from the reviewed public issue text. Queued reports retain an opaque recovery reference and poll for the eventual GitHub issue link. Local GitHub adapter tests exercise App authentication and ambiguous-response reconciliation; live GitHub App installation and production publication remain acceptance requirements.

- `invitation.png`: optional invitation after the controlled incident.
- `private-model-review.png`: public text and separate private attachment review.
- `queued-receipt.png`: durable receipt with publication explicitly pending.
