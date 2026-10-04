# Hosted Dropbox and Microsoft deployment

Create a separate Linux Railway service `cloud` in the existing project; keep
Autodesk and Windows worker configuration unchanged. Reverse proxy the exact
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
Git or viewer build variables. Startup rejects partial app configurations.
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

Acceptance checklist: real sign-in and identity, empty-account guidance, list
folders and root files, download/load a known IFC, refresh expiration, denied
consent, cancelled popup, signout during transfer, wrong CSRF/Origin rejection,
safe logs, and container restart. Local/mock tests are not these acceptance runs.

Dalux has a company-admin API-identity/key flow. Do not display an ordinary-user
OAuth sign-in claim or share a company identity across unauthenticated viewers.
