# Hosted Dropbox and Microsoft deployment

Use the separate Linux Railway service `cloud` in the existing project. Reverse proxy the exact
`/api/cloud/*` path from the viewer's origin to this service. Register exact
callback URLs for each deployed viewer origin; no wildcard callback or credential
in a frontend environment variable.

Set:

```dotenv
CLOUD_VIEWER_ORIGIN=https://www.ifclite.com
CLOUD_SERVICE_HOST=0.0.0.0
PORT=3004
CLOUD_DOWNLOAD_DIRECTORY=/tmp/ifclite-cloud-service
# Configure each complete pair, or leave both absent to show an unconfigured source.
CLOUD_DROPBOX_CLIENT_ID=
CLOUD_DROPBOX_CLIENT_SECRET=
CLOUD_MICROSOFT_CLIENT_ID=
CLOUD_MICROSOFT_CLIENT_SECRET=
CLOUD_MICROSOFT_TENANT=common
```

Secrets go directly into Railway's protected variable settings, never chat,
Git or viewer build variables. Startup rejects partial app configurations. Stage the public client ID and
secret as a complete pair before deploying: use Railway `--skip-deploys` for
CLI changes, save the secret privately in Railway, verify both variables are
present without printing their values, then redeploy. A secret-only deployment
exits before its health check; restarting that old configuration does not fix it.
Use one replica, disable sleeping, health check `/healthz`, and no persistent
artifact volume. Allocate at least 1.5 GiB temporary disk; file spooling avoids
full-model memory buffering. Sessions are process-local; a deploy signs users
out. Multiple replicas require a separately designed shared session store.
Each process must own a separate private download runtime directory. Startup
removes only its `download-*` crash leftovers before accepting traffic. Shutdown
aborts active work, waits up to five seconds for cleanup, then enforces a
six-second process deadline. Do not share the runtime directory with another
process or mount it as a persistent artifact volume.

Dropbox registration: scoped app, Full Dropbox access for browsing existing
files, read-only `account_info.read files.metadata.read files.content.read`.
Register `https://www.ifclite.com/api/cloud/dropbox/callback` and the exact
qualification preview callback. Development apps initially connect only their
owner; enable additional development users explicitly. Apply for production
approval under Dropbox's published user thresholds.
[Official OAuth guidance](https://docs.dropboxapi.com/dropbox-api/docs/oauth)
recommends short-lived access without refresh for interactive server web apps;
this gateway follows that guidance.

Microsoft registration: Web platform, authorization code with PKCE, multitenant
organizational and personal accounts, exact callback
`https://www.ifclite.com/api/cloud/msgraph/callback` and qualification callback.
Use delegated `User.Read`, `Files.Read`, `offline_access`; do not grant app-only
access to all company files. Configure publisher branding/verification and
document enterprise administrator approval where tenant policy requires it.
The gateway exposes OneDrive only; SharePoint discovery needs separately scoped
work and delegated site permissions.

Downloads use immediate preparation replies, short status polls and single-use,
session-owned artifact claims. Vercel external rewrites wait at most 120 seconds
for an upstream response, so do not wait for full vendor downloads inside the
preparation request. Keep the backend and hosted viewer client protocol at the
same merged revision. See [Vercel proxy limits](https://vercel.com/docs/limits#proxied-request-timeout).

Acceptance checklist: real sign-in and identity, empty-account guidance, list
folders and root files, download/load a known IFC, refresh expiration, denied
consent, cancelled popup, signout during transfer, wrong CSRF/Origin rejection,
safe logs, and container restart. Local/mock tests are not these acceptance runs.

Dalux has a company-admin API-identity/key flow. Do not display an ordinary-user
OAuth sign-in claim or share a company identity across unauthenticated viewers.

## Qualification deployment (2026-10-04)

Service `cloud` (`53cab0a6-dacd-4457-86ea-a11a737e1a61`) is provisioned in
`ifc-lite-server` production with one replica, sleeping disabled, Dockerfile
`apps/cloud-service/Dockerfile`, `/healthz` and port 3004. Its public endpoint is
https://cloud-production-6b9b.up.railway.app. Settings were applied through
Railway's public API and read back; the build log confirms the Dockerfile
multi-stage image, even though the service builder field reports RAILPACK.

Uploaded revision `e3ab51b4a` passed deployment
`4beadaf5-4bcb-4d48-9a0d-5a2101e265f0` and the platform health check. Live HTTPS
checks passed health, both unsigned/unconfigured sessions, Secure/HttpOnly/Lax
host-only cookies, no-store responses, correct-origin unconfigured authorize
(503), and foreign-origin rejection (403). Local Docker qualification also
passed under the non-root image user. These probes made no vendor calls.

Both vendor app credential pairs are now configured. Microsoft uses the common
tenant and delegated User.Read, Files.Read and offline_access. Replacement
deployment `055736c2-c470-42f4-9a41-6925d2bcf150` passes HTTPS health and both
configured-session checks. Both authorization routes return the expected vendor
host, production callback and S256 PKCE; cancellation cleans up each transaction.
These checks do not exchange a vendor code or prove a real file import.

The viewer flag and fixed Vercel rewrite are prepared but are not yet live on
the public viewer. After required checks, review and merge, activate the
production viewer and run real sign-in/import acceptance with consenting users
who have the relevant subscriptions and project access. The deployment operator
does not need their own Autodesk subscription. Keep this qualification status
separate from real vendor import acceptance.
