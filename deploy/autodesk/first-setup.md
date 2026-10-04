# First production setup

The deployment needs one APS application owned by IFClite. End users only need Autodesk accounts with permission to the files/sites/exchanges they select. The Railway project already contains a separate configured `autodesk` service; it has not been activated.

## Register the APS app

1. Open https://aps.autodesk.com/myapps and sign in or create an Autodesk account. If the current portal requires a developer hub, create or select the organization's hub first. Keep the organization's app under an administrator-controlled account with recovery/MFA rather than a shared password.
2. Create an application named `IFClite Cloud Sources` with application type **Traditional Web App**. The server uses confidential authorization code plus PKCE; do not select a browser-only/public app for the hosted deployment.
3. Set the callback exactly to `https://www.ifclite.com/api/autodesk/callback`. The hostname and absence of a trailing slash must match the gateway's AUTODESK_VIEWER_ORIGIN. Do not use the Railway domain as the viewer callback.
4. Enable API access for Data Management, Forma Site Design and Data Exchange, using the product names actually offered by the portal. Availability and offering approval depend on the APS developer hub/app; do not assume a missing API is enabled. Consult Autodesk's current [create-app instructions](https://aps.autodesk.com/en/docs/oauth/v2/tutorials/create-app).
5. In Railway, open `ifc-lite-server → production → autodesk → Variables`. Add AUTODESK_CLIENT_ID and AUTODESK_CLIENT_SECRET directly from the portal. The secret belongs only in the service variables; never put it into VITE_ variables, Git, screenshots or chat. Let the agent verify the variable names/presence rather than copying their values back.
6. Participating Forma Data Management hub administrators provision the application's client ID through **Custom Integrations**, following [Autodesk's hub setup instructions](https://help.autodesk.com/cloudhelp/ENG/Docs-Admin/files/hub-administration/Custom_Integrations.html). Each end user still needs project permissions. Empty catalogs and authorization failures must be investigated as provisioning/permission failures, not bypassed with an application-principal account.

The read-only import integration requests `data:read user-profile:read`. Do not add write scopes as a speculative workaround for a failed import. Record actual API/region authorization errors without tokens, and compare against Autodesk's current required scopes first.

## Choose the Windows worker host

Railway runs the gateway and native Forma converter. Autodesk's current Data Exchange SDK worker needs a Windows x64 host. Use an existing organization-managed AWS/Azure Windows VM when available. Otherwise compare a Windows Lightsail instance with an Azure Windows VM in the intended region. Check the current provider quote, Windows licensing, backup/snapshot and transfer costs before creating the host; estimate memory with real exchanges rather than treating the smallest instance as qualified.

The host needs Node 24, .NET 8, a dedicated low-privilege service account, automatic restart/start-on-boot, security updates, restricted administrator access, a public HTTPS worker hostname and persistent Caddy certificate storage. The worker's backend port remains loopback-only. Follow [the remote worker setup](./remote-exchange.md); the release bundle contains its Node entry point and published SDK executable. No host or provider account is created by this document.

## Activate in order

1. Review and merge the implementation stack only after its required checks and review pass. Run the exact-revision Windows release workflow and download its bundle.
2. Install and verify the authenticated HTTPS Windows worker; then add its origin/key to Railway. The same random server-only key authorizes the gateway to submit user tokens.
3. Connect Railway to the merged implementation with the supplied Dockerfile and configured APS variables. Deploy and verify its `/healthz`, then check importer declarations. One replica, sleep disabled; restarts sign users out.
4. Set VITE_AUTODESK_HOSTED=true for the production viewer build. Ship the prepared Vercel rewrite through the repository's normal production deployment process.
5. Run the operational smoke, then real Autodesk sign-in and source-versus-import acceptance for Docs, Forma and Data Exchange. An unsigned HTTPS smoke or configured importer does not prove account access, real geometry fidelity or a working export.
