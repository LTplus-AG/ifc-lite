# @ifc-lite/source-dalux

Dalux Build (Box) file-source provider for ifc-lite.

Implements `FileSourceProvider` from `@ifc-lite/plugin-api` to browse projects,
file areas, folders, and files in Dalux Build, and download IFC revisions
directly into the viewer.

Uses the published `dalux-build-api` npm client for Dalux route/version
compatibility, while keeping browser requests on the host-provided `fetch`
path.

Targets the Dalux **API Identities** auth model (legacy API keys expired
2026-02-28). The API base URL is fixed at `https://node1.field.dalux.com/service/api`
— it's not company-specific, so there's no base URL setting.

## CORS

The Dalux API does not send CORS headers, so direct browser fetches to it
will fail. The viewer routes Dalux requests through a fixed same-origin path
(`/api/dalux/*`) that the app's own server forwards upstream — a plain
reverse-proxy rewrite (see `vercel.json` in production, and the Vite dev
proxy in `apps/viewer/vite.config.ts`), the same pattern already used for
bSDD/EPSG. The user's own API key is attached client-side and never leaves
the browser except as part of the proxied request; there is no shared
server-side secret and no separate relay service to deploy.

## API key storage

The API key is stored in the browser's `localStorage`, unencrypted, with no
expiry. Anything that can execute script in the page (e.g. the viewer's own
script panel) can read it. Users who want to revoke access should rotate the
key in Dalux and use the "forget key" action in Source Settings.
