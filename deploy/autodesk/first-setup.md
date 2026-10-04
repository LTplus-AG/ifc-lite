# First production setup

The deployment needs one APS application owned by IFClite. End users only need Autodesk accounts with permission to the files/sites/exchanges they select. The Railway project already contains a separate configured `autodesk` service; it is running and passes unsigned HTTPS checks; the public viewer and real account qualification remain pending.

## Register the APS app

1. Open https://aps.autodesk.com/myapps and sign in or create an Autodesk account. If the current portal requires a developer hub, create or select the organization's hub first. Keep the organization's app under an administrator-controlled account with recovery/MFA rather than a shared password.
2. Create an application named `IFClite Cloud Sources` with application type **Traditional Web App**. The server uses confidential authorization code plus PKCE; do not select a browser-only/public app for the hosted deployment.
3. Set the callback exactly to `https://www.ifclite.com/api/autodesk/callback`. The hostname and absence of a trailing slash must match the gateway's AUTODESK_VIEWER_ORIGIN. Do not use the Railway domain as the viewer callback.
4. Enable API access for Data Management, Forma Site Design and Data Exchange, using the product names actually offered by the portal. Availability and offering approval depend on the APS developer hub/app; do not assume a missing API is enabled. Consult Autodesk's current [create-app instructions](https://aps.autodesk.com/en/docs/oauth/v2/tutorials/create-app).
5. In Railway, open `ifc-lite-server → production → autodesk → Variables`. Add AUTODESK_CLIENT_ID and AUTODESK_CLIENT_SECRET directly from the portal. The secret belongs only in the service variables; never put it into VITE_ variables, Git, screenshots or chat. Let the agent verify the variable names/presence rather than copying their values back.
6. Participating Forma Data Management hub administrators provision the application's client ID through **Custom Integrations**, following [Autodesk's hub setup instructions](https://help.autodesk.com/cloudhelp/ENG/Docs-Admin/files/hub-administration/Custom_Integrations.html). Each end user still needs project permissions. Empty catalogs and authorization failures must be investigated as provisioning/permission failures, not bypassed with an application-principal account.

The read-only import integration requests `data:read user-profile:read`. Do not add write scopes as a speculative workaround for a failed import. Record actual API/region authorization errors without tokens, and compare against Autodesk's current required scopes first.

## Choose the Windows worker host

Railway runs the gateway and native Forma converter. Autodesk's current Data Exchange SDK worker needs a Windows x64 host. Use an existing organization-managed AWS/Azure Windows VM when available. For a new small deployment, compare a monthly Windows VPS before selecting a hyperscaler. The maintainer has no existing provider account and considers the proposed $74/month Lightsail worker too expensive. OVHcloud is the current budget candidate, pending the actual checkout quote and availability; no paid host has been ordered. Check the current provider quote, Windows licensing, backup/snapshot and transfer costs before creating the host; estimate memory with real exchanges rather than treating the smallest instance as qualified.

The host needs Node 24, .NET 8, a dedicated low-privilege service account, automatic restart/start-on-boot, security updates, restricted administrator access, a public HTTPS worker hostname and persistent Caddy certificate storage. The worker's backend port remains loopback-only. Follow [the remote worker setup](./remote-exchange.md); the release bundle contains its Node entry point and published SDK executable. No host or provider account is created by this document.

## Activate in order

1. Review and merge the implementation stack only after its required checks and review pass. Run the exact-revision Windows release workflow and download its bundle.
2. Install and verify the authenticated HTTPS Windows worker; then add its origin/key to Railway. The same random server-only key authorizes the gateway to submit user tokens.
3. Connect Railway to the merged implementation with the supplied Dockerfile and configured APS variables. Deploy and verify its `/healthz`, then check importer declarations. One replica, sleep disabled; restarts sign users out.
4. Set VITE_AUTODESK_HOSTED=true for the production viewer build. Ship the prepared Vercel rewrite through the repository's normal production deployment process.
5. Run the operational smoke, then real Autodesk sign-in and source-versus-import acceptance for Docs, Forma and Data Exchange. An unsigned HTTPS smoke or configured importer does not prove account access, real geometry fidelity or a working export.

## Worker hosting comparison (checked 2026-10-04)

AWS lists its Windows/public-IPv4 8 GB bundle at $74/month before extras in [Lightsail bundles](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html). OVHcloud's [public French VPS catalogue](https://eu.api.ovh.com/v1/order/catalog/public/vps?ovhSubsidiary=FR) lists monthly, zero-commitment `vps-2027-model2` at €8.49, its Windows option at €8.00 and mandatory basic backup at €0.50: €16.99/month before tax. That reference catalogue is not a Swiss checkout quote, regional availability or a performance qualification. The advertised [Windows VPS price](https://www.ovhcloud.com/en/vps/os/vps-windows/) links to annual prepayment; select monthly billing and include the Windows option when comparing. Contabo is another budget candidate, but [its Windows licence is charged separately](https://help.contabo.com/en/support/solutions/articles/103000270398-can-i-use-my-own-windows-license-on-my-contabo-erver-) and its exact configuration/term total has not been verified.

Prefer a one-month qualification deployment to an annual commitment. Confirm the final tax-inclusive checkout, region, Windows version, backup and cancellation terms with the maintainer before ordering. These are unmanaged Windows servers: updates, restricted administration, service recovery and monitoring remain operational work whichever provider is selected. Measure real exports before choosing capacity or promising throughput.
