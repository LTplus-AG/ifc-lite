# Autodesk on the existing Railway project

Add a separate **autodesk** service to **ifc-lite-server → production**, the project identified by the maintainer's dashboard screenshot. Leave collab-server, its volume, Postgres, ifc-lite-api and superset unchanged.

The Linux Docker image hosts the Autodesk session gateway and Rust Forma converter. The viewer can stay on Vercel, with a fixed external rewrite to Railway. Conversion is now a session-owned background job: creation returns 202, status requests are short, and the pinned artifact downloads separately. This avoids Vercel's [120-second origin-response limit](https://vercel.com/docs/errors/router_external_target_error) and Railway's [five-minute inactive-request limit](https://docs.railway.com/networking/public-networking/specs-and-limits).

## Provisioned service (2026-10-04)

CLI authentication was renewed and the production project was verified against the dashboard. Service `autodesk` was created with ID `16b59891-9fbd-4946-a871-9365b702a91e`, and `https://autodesk-production-50bc.up.railway.app` targets port 3002. Its Dockerfile/root, health check, restart policy, one replica and disabled sleep settings were applied through the live-schema public API, then read back. The non-secret origin/host/port variables were configured separately from the APS app credentials. Existing services were not edited.

The backend is running from uploaded implementation revision `d7083c0cf`; successful deployment `0f8d4363-76a5-44ab-b294-f464506fd356` passes `/healthz`. Live HTTPS checks passed unsigned sessions, secure host-only cookies, CSRF rejection, unsigned proxy rejection, PKCE authorization URL/canonical callback, cancellation and sign-out. These checks made no Autodesk calls and do not qualify the app credentials or source access. The first deployment failed its platform health check because the explicit service port lacked a matching PORT variable; the corrected configuration below passed. The Vercel rewrite is prepared but has not reached the public viewer.

The current CLI's `environment edit` returned “No changes to apply” for these new-service settings; the public API's `ServiceInstanceUpdateInput` succeeded. Its input Builder enum does not include DOCKERFILE: setting dockerfilePath selects Dockerfile discovery, and the configuration readback reports the effective builder as DOCKERFILE.

## Configure the new service

Use **Add → Empty Service**, name it `autodesk`, and configure the following before its first production deployment:

| Setting | Value |
| --- | --- |
| Repository | LTplus-AG/ifc-lite, implementation's merged branch |
| Repository root | `/` (shared monorepo; not apps/autodesk-service) |
| Builder | Dockerfile |
| Dockerfile | `apps/autodesk-service/Dockerfile` |
| Start command | Image default: `node dist/bin.js` |
| Health check | `/healthz` |
| Health timeout | 30 seconds |
| Replicas | 1, in one region |
| Serverless/sleep | Disabled: sessions/jobs are in memory |
| Restart policy | On failure, max 3 retries |
| Public domain target port | 3002 |
| Memory | At least 4 GiB available initially; measure real project sizes |

Watch the service, rust/cloud-import, shared packages, scripts, patches and root manifests/lock/TypeScript configs. Do not attach the collab volume; this service uses temporary scratch storage and does not need the room database.

Railway's old railway.toml/railway.json authoring is [deprecated](https://docs.railway.com/config-as-code/reference). Use the dashboard/current CLI settings for this new service, or import only this service into a new IaC partial. Do not apply an IaC project definition that takes ownership of, removes or resets existing rooms/database services.

Set these variables on **autodesk**, keeping both APS values in Railway rather than Git or chat:

```text
AUTODESK_VIEWER_ORIGIN=https://www.ifclite.com
AUTODESK_CLIENT_ID=<deployment APS app ID>
AUTODESK_CLIENT_SECRET=<server-only APS app secret>
AUTODESK_INSECURE_LOCALHOST=false
AUTODESK_SERVICE_HOST=0.0.0.0
AUTODESK_SERVICE_PORT=3002
PORT=3002
```

Use the actual canonical viewer origin if different. The image already sets `AUTODESK_FORMA_CONVERTER=/usr/local/bin/ifc-lite-cloud-import`. Leave AUTODESK_EXCHANGE_WORKER unset on Linux. The Node entry point also honors Railway's injected PORT when no explicit service port is configured. With the explicit port shown above, set PORT to the same value: Railway uses it for health checks. Omitting it caused the first real deployment to start successfully but fail the platform health check. See [Railway's health-check port instructions](https://docs.railway.com/deployments/healthchecks#configure-the-healthcheck-port).

Register an APS **Traditional Web App**, with exact callback `https://www.ifclite.com/api/autodesk/callback` (or the actual canonical origin), API access for the required products, and participating hub administrators' Custom Integration approval. [Autodesk app/provisioning setup](https://get-started.aps.autodesk.com/)

The service deliberately refuses to start without app configuration. Do not deploy fake credentials as working sign-in. Once configured, generate a Railway service domain and check `/healthz`: JSON, no user session cookie, no Autodesk request. This proves startup only.

## Connect the existing viewer

The following **fixed external rewrite before the SPA fallback** is now prepared in root vercel.json:

```json
{
  "source": "/api/autodesk/:path*",
  "destination": "https://autodesk-production-50bc.up.railway.app/api/autodesk/:path*"
}
```

The Railway backend is live; the public viewer rewrite remains pending. Set `VITE_AUTODESK_HOSTED=true` in the viewer's production build. No APS client secret belongs in Vercel's browser build. The browser still uses its viewer-origin cookie; do not replace this with cross-origin credentialed browser fetches.

Deploy/verify Railway before enabling the hosted viewer build. Ship the frontend through the existing main/production branch process. Its workflow does not install this backend.

After both routes are connected, run:

```sh
node deploy/autodesk/smoke.mjs https://www.ifclite.com proposal
```

The probe creates/discards its own unsigned session and checks actual API routing, secure host-only cookies, CSRF, unsigned access rejection, callback isolation/no-store headers and importer declarations. It makes no Autodesk calls. Next qualify real sign-in, historical Docs IFC files and Forma geometry/georeference using [the rollout acceptance checks](./README.md).

## Data Exchange and full support

The SDK executable targets Windows/.NET 8. The Linux gateway supports all three sources by configuring the delivered [authenticated remote Windows worker](./remote-exchange.md). Docs and Forma execute on Railway; Data Exchange IFC export executes on Windows and returns through the same session-owned gateway job.

Set AUTODESK_EXCHANGE_WORKER_ORIGIN and AUTODESK_EXCHANGE_WORKER_KEY on the gateway only once the Windows host and HTTPS endpoint are installed and verified. A local full-source Windows backend remains an alternative. The OVH Windows worker is installed at https://exchange-worker.ifclite.com with restricted SSH administration and LocalService runtime. Locked SDK publishing, snapshot guards, authenticated HTTPS, reboot recovery and induced worker-process recovery passed on the actual host. Railway has the paired origin/key and advertises exchange import. This remains an unmerged qualification bundle; a real delegated exchange export is still required.

## Job and deployment limits

Two slots bound conversion, retained artifacts and their downloads together. Prepared results expire after two minutes; unfinished jobs/downloads expire after fifteen minutes. Jobs belong to one signed-in session, artifacts are claimable once, and cancellation/sign-out abort owned work. Restarts drop sessions/jobs. Keep sleep disabled and one replica until shared session/job storage and refresh coordination are implemented.

The Railway backend, unsigned HTTPS contract and user-confirmed real preview login are verified. Canonical viewer activation, accessible project/source acceptance and final merged-revision deployment remain open rollout steps.

## Viewer rollout preparation (2026-10-04)

The existing Vercel `ltplus/ifc-lite` project is linked and its production build now has the non-secret `VITE_AUTODESK_HOSTED=true` setting. The public viewer still serves its previous deployment; changing a build variable does not deploy the rewrite. A fresh local Vercel build, including source-built WASM, was uploaded as [the implementation preview](https://ifc-lite-lwua0l5jj-ltplus.vercel.app). Its session rewrite returns the Railway JSON/secure cookie and its static callback has no-store/no-referrer/COOP/COEP headers. The rendered Cloud Sources panel was inspected through the collaborative browser and shows the Autodesk row and Sign in action. Screenshot capture remains unavailable in that browser.

Real preview sign-in requires its exact `/api/autodesk/callback` added to the APS app, then temporarily setting the single gateway's viewer origin to that exact preview origin. This is a qualification window before public viewer activation, not support for concurrent origins. Restore the canonical production origin before deploying the public viewer. Do not relax CSRF origin checks or register wildcard callbacks. The maintainer added the exact preview callback, and the gateway now temporarily uses that preview origin. An actual browser authorization-start request returned 200 with the matching preview callback. The maintainer confirmed real preview sign-in works after the token/profile fixes; the project list is empty and account project availability remains uncertain. Real source-import acceptance is pending. Restore AUTODESK_VIEWER_ORIGIN=https://www.ifclite.com before public activation.

A fresh first-layer review found and fixed failed-overlay rollback, with 208 IFCX tests and full typecheck passing. Required CI must pass on the current head before rollout. GitHub still requires independent approval because the workspace account is the PR author. Upper stacked layers receive main-only CI as predecessors merge and bases are retargeted. The production Windows bundle workflow has not run yet. DNS and worker HTTPS are live; the installed Windows bundle is explicitly for qualification.

Preview sign-in diagnosis (2026-10-04): a real login attempt surfaced a generic failure. The implementation incorrectly requested `/authentication/v2/userinfo` (an anonymous probe returned 404). Autodesk’s [published OIDC example](https://autodesk-platform-services.github.io/mcp-devcon2026/4-three-legged-aps) uses `https://api.userprofile.autodesk.com/userinfo` (anonymous probe returned 401). Both hosted and direct profile lookups now use that fixed endpoint, and direct mode declares the profile domain in its network permissions. Gateway regressions require the profile request with the delegated bearer token and reject altered/foreign profile URLs. All 33 gateway tests (including confidential-client login and refresh), 12 provider tests and root typecheck pass. Callback failures log only a bounded failure category, never callback parameters, credentials or upstream bodies. Both fixes are live in Railway deployment `6a4db065-0c7a-4a66-a671-a5a2c89713c3`, which passed its health check; the maintainer subsequently confirmed successful real sign-in.

The next real callback reached the token exchange and logged `exchange-failed`. A separate server-side client-credentials verification returned 200 without exposing or retaining its token, confirming the configured APS credentials. The confidential-client form incorrectly included `client_id` alongside Basic authentication. Autodesk’s [official authentication specification](https://github.com/autodesk-platform-services/aps-sdk-openapi/blob/main/authentication/authentication.yaml) distinguishes confidential-client header authentication from public-client form authentication. The gateway now removes the duplicate form credential from both authorization-code and shared TokenManager refresh requests, preserving the PKCE verifier. Login and refresh regressions check the actual outgoing forms and rotated-session access. The corrected deployment is healthy; real three-legged login is confirmed by the maintainer. Root lint and all 433 documentation samples also pass.
