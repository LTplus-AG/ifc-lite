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

## Model history from version sets

Dalux has **no endpoint that lists a file's revisions** — only "fetch this
exact revision's content", which needs a revision id you already have. So
`capabilities.revisionHistory` is `false` and always will be.

Version sets are the way in. A version set is a named, lockable snapshot of a
file area pinning one revision of each file, and
`GET /3.0/projects/{p}/version_sets/{vs}/files` returns those pinned rows —
each with its own `fileRevisionId`, `contentHash`, timestamps and author.
Sweeping a project's sets therefore reconstructs every revision of every
model they cover, which is exactly a commit history
(`capabilities.commits`, contract 2.1.0).

| Contract | Dalux |
| --- | --- |
| model | a model file appearing in ≥1 version set; `modelId` is the `fileId` |
| commit | one distinct **revision** of that file; `commitId` is the `fileRevisionId` |
| `parents[0]` | the next older revision |
| `message` | the name(s) of the version set(s) pinning that revision |
| `artifact.digest` | `dalux-content:<contentHash>` |
| `loadCommit` | the row's own `downloadLink` — `GET /1.0/.../version_sets/{vs}/files/{f}/revisions/{r}/content` |

**A commit is a revision, not a version set.** Two sets pinning the same
revision are not two versions of that model — it did not change between them —
so they collapse into one commit carrying both set names.

**Download through the link, never a built URL.** A version-set file row
carries its own `downloadLink`, and it is *version-set scoped at api version
1.0* — not the file-area-scoped `/2.0/.../file_areas/{fa}/...` route a client
would reasonably construct. Measured live. The file-area route stays as a
fallback for a row with no link, since it is documented and does take a
revision id.

**`modelIdsAreFileIds: true`.** A model *is* a file here, so the History panel
works for a model opened through the ordinary file browser, not only for one
opened from the panel itself.

### Two honest limitations

**The digest is not `sha256:<hex>`.** Measured against a live tenant,
`contentHash` is `<43-char base64url>.<ext>` — a 256-bit hash, base64url
rather than hex, with the file extension appended
(`"wbX4PzzI6iWxaKnSMCkmV3RP8vQv3JCbwCuyHd6QhTM.ifc"`). The width is
consistent with SHA-256, but the algorithm is undocumented and has not been
verified against the bytes, so it is reported as `dalux-content:<hash>`
rather than relabelled: a host would otherwise "verify" a payload against a
hash it cannot actually recompute. The consequence is real — a host cannot
independently prove `loadCommit`'s bytes belong to the commit, and an
identity-map sidecar written against `sha256:` cannot pin to a Dalux commit.
What still holds is the property the field needs: it changes when the bytes
change.

It is also a **content** hash, so re-uploading identical bytes yields the same
hash under a new revision id. Nothing here (or in the conformance suite) may
require digests to be unique per commit.

*To upgrade this to `sha256:`*: download any revision, `sha256` it, base64url-
encode the digest, and compare with `contentHash` minus its extension. A match
makes `sha256:<hex>` honest, and buys host-side payload verification plus
sidecar compatibility.

**Building the history costs one request per version set**, because nothing
can filter `listVersionSetFiles` down to one file. The sweep is bounded
(`MAX_VERSION_SETS`), cached per project for five minutes, shared between
concurrent callers, and drops non-model files as it goes. A project past the
cap reports `historyTruncated` on every model rather than presenting a stale
revision as the newest.

**Ordering** uses three signals in order of trust: `File.version` (Dalux's own
revision number), then the pinned row's timestamp, then sweep position.
`version` leads because `lastModified` is a **date with no time**, so every
revision uploaded on one day ties — on a live project that is the normal case,
not an edge case. Sweep position last assumes the version-set listing is
chronological, which it was on the tenant checked (ids ascend with it).

## Every other Dalux endpoint (`/sdk`)

The provider only calls the handful of endpoints a file source needs. For the rest of Dalux Build
— tasks, forms, users, companies, work packages, inspection plans, test plans, project templates —
the `sdk` subpath exposes [`dalux-build-api`](https://www.npmjs.com/package/dalux-build-api)'s full
endpoint catalogue with zod-parsed responses:

```ts
const { createDaluxClient, createDaluxSdk } = await import('@ifc-lite/source-dalux/sdk');
const dalux = createDaluxSdk(await createDaluxClient(ctx));

const tasks = await dalux.tasks.getProjectTasks(projectId);
```

It borrows the catalogue, not the transport: requests go through this package's own client, so the
same-origin relay routing, the `daluxNode` selector, byte-exact handling of signed download links
and `ctx.log` tracing described below all still apply. Writes throw `DaluxReadOnlyError` — this
provider is read-only, so a `POST` would otherwise be silently dropped.

Import it dynamically, as above. It is a separate subpath because `DaluxBuildProvider` is loaded at
app start and the catalogue costs zod plus its schemas; nothing reachable from this package's main
entry point pulls it in.

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
