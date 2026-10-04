# Hosted cloud gateway

Linux Node 24 backend for Dropbox and Microsoft OneDrive. Users authenticate on
vendor pages. OAuth secrets and access/refresh tokens stay in process memory;
the browser receives an opaque HttpOnly cookie, identity and a CSRF token.
Autodesk and its Windows SDK worker remain separate services.

Run `pnpm typecheck` and
`pnpm test --filter=@ifc-lite/cloud-service` from the repository root through Turbo.
Build with `pnpm build --filter=@ifc-lite/cloud-service`; start with
`node apps/cloud-service/dist/bin.js` after workspace dependencies are built.

Configuration and deployment: [Railway runbook](../../deploy/cloud/railway.md).

The gateway is read-only and permits existing Dropbox RPCs and the signed-in
user's own OneDrive endpoints. It does not discover SharePoint sites or provide
historical Microsoft downloads. Graph metadata removes preauthenticated download
links; file transfers check current cTag/eTag before and after download.

Session lifetime is eight hours, with a 30-minute idle timeout. Restart signs
users out. Dropbox uses short-lived interactive authorization without refresh
tokens. Microsoft uses confidential Web authorization with PKCE, delegated
`User.Read Files.Read offline_access`, serialized refresh and local disconnect.
Disconnect removes the gateway's access; revoking app consent is performed in
the vendor account settings.

API JSON is bounded to 8 MiB; request JSON to 64 KiB. File transfers are capped
at 512 MiB and two concurrent downloads, with 15-minute cancellation deadlines.
Files spool to private ephemeral directories before streaming. Reserve at least
1.5 GiB temporary disk; no model artifact is intentionally retained after a
transfer. Startup removes owned crash leftovers from its dedicated private
runtime directory before serving requests. Shutdown aborts transfers and awaits
owned cleanup for up to five seconds, with a six-second process deadline. Use
one process per runtime directory and ephemeral container storage. Never mount
the temporary directory as a shared artifact volume.

Offline invariant tests do not establish live vendor qualification. Production
acceptance requires actual user sign-in, listing and loading an IFC file, expiry,
disconnect and permission-denial checks for each registered application.
