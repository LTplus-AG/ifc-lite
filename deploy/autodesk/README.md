# Autodesk production rollout

The full-source deployment serves the built viewer and Autodesk API on **one HTTPS origin**, with a Windows backend running Node 24, the Rust Forma converter and Autodesk's .NET 8 Data Exchange worker. Users sign in with their own Autodesk accounts. One APS application belongs to the IFClite deployment; ordinary users do not need developer apps.

For the existing Railway rooms/sharing project, follow [the Railway rollout](./railway.md): use a separate Linux Autodesk service and keep the Vercel viewer with a fixed same-origin rewrite. Imports use short job creation/status requests rather than long conversion requests through the edge proxy. Docs and Forma run on Railway; add the [authenticated remote Windows worker](./remote-exchange.md) for Data Exchange.

For the full-source Windows stack below, start on a dedicated hostname (for example `cloud.ifclite.com`) and qualify real projects before moving the existing viewer domain. This hostname is a proposal, not a provisioned endpoint.

For the first APS registration and host choice, use [first production setup](./first-setup.md).

## What must exist first

1. A Windows x64 host, a low-privilege service account, Node 24 and the .NET 8 runtime. Rust and the SDK build toolchain are needed only on the build machine. Use a host with at least 4 GiB available memory for the configured two concurrent imports; measure actual project sizes before increasing capacity.
2. A chosen public hostname with DNS pointing to the gateway and inbound TCP 80/443 for Caddy HTTPS. Keep Node port 3002 bound to loopback and blocked from public access.
3. A registered APS **Traditional Web App**, with the exact callback `https://YOUR-HOST/api/autodesk/callback`. Enable Data Management, Forma and Data Exchange API access as offered for the app. [Autodesk application setup](https://get-started.aps.autodesk.com/)
4. The app's client ID and secret stored on the service host, outside the viewer build and release bundle. For Docs/ACC access, each participating account's administrator must authorize the app under Custom Integrations. [Autodesk provisioning instructions](https://help.autodesk.com/cloudhelp/ENG/Docs-Admin/files/hub-administration/Custom_Integrations.html)

The service requests delegated `data:read` and `user-profile:read`, not application-wide data access. Setting environment placeholders does not create an APS app or authorize an account. Do not paste secrets into chat or GitHub issue/PR descriptions.

## Build a reviewable release

Use the repository's normal PR/required-check process for the implementation. The existing `production` branch workflow deploys the Vercel viewer; it does **not** install this backend. Do not enable `VITE_AUTODESK_HOSTED` on the existing Vercel viewer until it has a working same-origin backend route.

The manual **Autodesk deployment bundle** workflow builds:

- A hosted-auth viewer using the canonical WASM toolchain.
- A production Node package and Windows Rust executable.
- The locked Autodesk SDK worker, including its native runtime dependencies.
- Gateway configuration, this runbook, a smoke probe, and `release.json` identifying the exact commit.

The workflow needs no Autodesk credentials and does not deploy. A bundle built from a branch is a preview artifact; production uses a merged commit whose required checks passed. After the workflow is on the default branch, run it on that commit's branch and download its Windows artifact from the Actions run. Both build jobs use the same checked-out commit. Require the Linux native-contract and Windows SDK lanes to pass as well as the main required checks.

Keep the previous release directory for rollback. Extract the new bundle to `C:\IFClite\releases\COMMIT`, with `viewer`, `service`, `native`, `exchange`, `deployment` and `release.json` directly inside. Copy it to `C:\IFClite\current` only during a stopped-service release switch, or configure your service manager to the immutable release path. Do not overlay files onto a running release.

## Configure the host

Copy `windows.env.example` to `C:\IFClite\config\.env.local`, replace the hostname and APS placeholders, and update executable paths for the selected release. Restrict that file to the administrator and service account using Windows ACLs. No actual secret belongs in `windows.env.example` or `release.json`.

Start the Node service initially in a foreground terminal to verify configuration:

```powershell
node --env-file=C:\IFClite\config\.env.local C:\IFClite\current\service\dist\bin.js
```

In another terminal, install Caddy and validate/start the supplied gateway:

```powershell
$env:IFCLITE_PUBLIC_HOST = 'YOUR-HOST'
$env:IFCLITE_VIEWER_ROOT = 'C:\IFClite\current\viewer'
caddy validate --config C:\IFClite\current\deployment\Caddyfile.windows --adapter caddyfile
caddy run --config C:\IFClite\current\deployment\Caddyfile.windows --adapter caddyfile
```

Configure both commands in the host's service manager with automatic restart and start-on-boot under the service account. Set the two gateway environment variables there too; an interactive terminal's variables do not configure a Windows service. Caddy needs a persistent, writable certificate storage directory owned by its service account. Keep full callback request URLs and query strings out of access logs. The supplied config enables no access logging.

This service deliberately has one process and in-memory sessions. Restart/release changes sign users out. Do not horizontally replicate it or put several independent backend instances behind a load balancer.

For a Linux-only initial rollout, use `compose.yml` and the service README; Data Exchange remains unavailable. The Linux container supports Docs and native Forma imports only.

## Verify before inviting users

Run from a machine that can reach the public hostname:

```powershell
node C:\IFClite\current\deployment\smoke.mjs https://YOUR-HOST proposal exchange
```

The probe creates and discards its own unsigned session, checks real gateway routing, secure host-only cookies, no-store caching, CSRF rejection, signed-out access rejection, callback isolation headers and installed importer declarations. It never invokes Autodesk or prints session values. It must fail if the session URL returns the SPA HTML fallback. Installed importer declarations prove configuration, not successful native execution.

Next, with an authorized project user, verify sign-in, denial, popup blocking, cancellation, refresh, account switching and disconnect. Load a real Docs IFC and an older version; compare source revision tags. Load a real Forma proposal with repeated elements, terrain volume mesh and known control points. Export a real current Data Exchange, comparing geometry, units and properties against its authoring application. Check cancellation during conversion, deleted/denied resources and a failed update preserving the previously loaded model. These account-dependent checks cannot be replaced by the unsigned smoke probe.

Only announce the qualified feature set. Whole-exchange exports are current-version only; unsupported Forma physical representations fail, and textures/vertex colors/2D overlays remain disclosed omissions.

## Rollback and operation

On a failed release, stop the gateway/backend service pair, select the previous complete release, restore its matching environment paths, restart, and rerun the smoke probe. The current viewer's locally loaded models are independent of the server session; restarting the service drops sign-in state and active transfers.

Monitor process restarts, importer failures/timeouts, scratch-disk and memory usage, busy responses and HTTPS renewal. Do not log bearer tokens, authorization codes, signed URLs or raw SDK errors. A real import succeeds only after the viewer loads/registers the returned pinned artifact; successful gateway health alone is insufficient.

Local preparation on 2026-10-04 established the Docker build/native contract and SDK compilation. The isolated Railway backend is running and passes unsigned HTTPS checks, with APS variables configured. No Windows host, public viewer activation or live account sign-in/export qualification is complete.
