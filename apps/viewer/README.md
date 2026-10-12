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
