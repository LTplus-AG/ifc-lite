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

## CORS

The Dalux API does not send CORS headers, so direct browser fetches to it
will fail. The viewer routes Dalux requests through a fixed same-origin path
(`/api/dalux/*`) served by `server/sources/dalux-relay.ts`, the same handler in
production (`api/dalux.ts`) and in Vite dev (`apps/viewer/vite-plugins/dalux-relay.ts`).
The user's own API key is attached client-side and never leaves the browser
except as part of the relayed request; there is no shared server-side secret.

The relay is read-only (GET/HEAD) on the API versions the provider calls, plus
the two `1.1` file-property mapping reads. Its only write is the file upload
(`server/sources/dalux-relay-upload.ts`): POST on exactly the slot, part and
finalize paths, with the media type, `Content-Range` and `Content-Disposition`
each step requires. A relayed part is capped at 4 MiB (the function request-body
limit), below the 100 MiB Dalux itself accepts, so uploads through the relay
must use parts of at most `MAX_RELAYED_BODY_BYTES`.

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
