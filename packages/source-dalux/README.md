# @ifc-lite/source-dalux

Dalux Build (Box) file-source provider for ifc-lite.

Implements `FileSourceProvider` from `@ifc-lite/plugin-api` to browse projects,
file areas, folders, and files in Dalux Build, and download IFC revisions
directly into the viewer.

Has no runtime dependencies beyond `@ifc-lite/plugin-api`. Requests go through
the host-provided `fetch`, and responses are narrowed by hand-written decoders
in `src/dalux-types.ts` that reject wrong-typed fields rather than coercing
them, dropping an individually invalid row from a listing instead of failing
the whole page.

Targets the Dalux **API Identities** auth model (legacy API keys expired
2026-02-28). The API base URL is fixed at `https://node1.field.dalux.com/service/api`
— it's not company-specific, so there's no base URL setting.

## Revision history

Dalux has no endpoint that lists a file's revisions directly. `listRevisions`
answers from **version sets** instead: a named, lockable snapshot that pins
one revision of every file in a file area. Sweeping a project's version sets
(`GET /2.1/projects/{p}/version_sets` then `GET /3.0/.../version_sets/{vs}/files`,
`src/commit-index.ts`) reconstructs each covered file's revision history —
which is also the only per-file history Dalux exposes at all, so the current revision is included even when no version set pins it. The sweep is cached per project for a few
minutes and shared across every call, so opening "Versions" on several files
costs it once.

Two sets pinning the same revision collapse into one entry (the model did not
change between them); ordering puts numbered revisions first (highest number first), then date,
sweep position and ID. `lastModified` is date-only, so same-day revisions
would otherwise tie.

The current file revision is always included, even if no version set pins it.
Dates stay blank when unavailable, and raw author IDs are not displayed as names.
The project history is cached for five minutes; rebuilding reads fresh pins.
A failed or undecodable set makes history unavailable with an explicit error and
short retry window. Projects above 250 version sets are refused rather than
silently showing an arbitrary older subset: the listing has no documented date
or recency order from which to choose the newest sets safely.

Revision history supports model files. Requests for document history report that it is unavailable rather than presenting a current-only list as complete.


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

### BIMcollab relay

The viewer also serves `/api/bimcollab/*` through the same production-handler
pattern in Vite and on Vercel. It accepts a caller's OAuth bearer for enumerated
Documents API reads (`docs/<spaceGuid>/…`), streaming web-app downloads
(`space/<label>/download/<id>`), and a fixed, paged index request
(`space/<label>/index?locationId=<id>&projectId=<id>`; project is optional).
Index results contain only document/version identifiers, names and attachment
metadata; an index over 5,000 records is an error (never truncated), and an
unreadable record marks the result `incomplete`. Cookies are never forwarded and responses
are not cached. `BIMCOLLAB_RELAY_ALLOWED_ORIGINS` overrides the comma-separated
origin allowlist; defaults include `APP_URL` and registered BIMcollab callback
origins. Configure a Vercel WAF rate-limit rule on `/api/bimcollab`: holders of
valid tokens can otherwise consume deployment bandwidth through our egress IPs.
