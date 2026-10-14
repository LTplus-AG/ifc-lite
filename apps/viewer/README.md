# IFC Lite viewer

The browser viewer lives in this workspace package. Run builds, typechecks and
tests through the repository's root pnpm/Turbo commands so workspace
prerequisites are built first; see the root `AGENTS.md` for commands.

## Reviewed error reports and model uploads

Reporting invitations are **off by default**. Enable them by setting
`VITE_MODEL_REPORTS_ENABLED=true` when building the viewer. This is a public
build-time feature flag, not a credential. Other values leave the report host
unmounted.

Enable the flag only after the [report service](../report-service/README.md)
is deployed, its database migrations and storage lifecycle are configured,
its publication and verification workers are running, and its same-origin
`/api/reports` route has passed end-to-end qualification. An enabled viewer
must reach the service through that route; the browser never receives the
GitHub App private key or storage credentials.

The service supplies upload limits, actual hosting/backup/retention disclosures
and NDA availability. Enabling the viewer flag does not enable NDA signing or
public model publication. Those capabilities remain controlled by the service.
Keep the flag unset while the service is unavailable; rebuilding without the
flag disables invitations without changing existing server-side reports.

A report receipt distinguishes durable submission from GitHub publication.
If the service returns a publication hold after an ambiguous GitHub response,
the dialog stops automatic status requests and explains the pause; the user
can still check its status manually. A custom NDA request has its own receipt
and does not upload the model while awaiting maintainer review.

Public model sharing also requires a qualified server capability; production
configuration currently keeps it disabled. When available, it remains an explicit
opt-in after choosing a model, with separate authority/licence, content/privacy,
and irreversible-copy/link permissions. Changing the file clears these choices.
Public attachments are uncompressed IFC up to 1 GiB and cannot use an NDA on the
same report. The final review repeats the public permissions before any upload.
A received report shows pending scan/review, held, available or withdrawn status;
only a same-origin generic download URL can become a link. Owners can separately
stop new public downloads while retaining the private support model. Started
downloads, saved copies and public GitHub content cannot be recalled. The UI does
not claim that a public download link has been posted to GitHub.
