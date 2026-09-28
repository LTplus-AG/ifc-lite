# @ifc-lite/source-commit-http

A generic **commit-aware** file-source provider for IFClite. It implements the
`@ifc-lite/plugin-api` 2.1.0 commit contract over a documented REST API, so a
commit service can plug into the viewer without anyone writing a bespoke
provider for it.

See `docs/architecture/commit-history/01-commit-source-api.md` for the contract
this implements.

## Registering it

`permissions.network` is the host's security boundary and is checked before
every request, so the hostnames are supplied **in code**, by the application
registering the provider — not as a user preference. The capability set is
supplied the same way, because a manifest is read once at registration and the
contract requires a method to exist exactly when its flag is true.

```ts
import { createCommitHttpProvider, fetchCommitCapabilities } from '@ifc-lite/source-commit-http';

const commits = await fetchCommitCapabilities('https://commits.example.com/api/v1');

sourceHost.registerFactory(
  () => createCommitHttpProvider({
    network: ['commits.example.com', 'id.example.com'],
    commits,
  }),
  'commit-http',
);
```

The user then fills in three preferences: `baseUrl`, `clientId`, and optionally
`issuer` (defaults to `baseUrl`). `testConnection` re-reads `/capabilities` and
reports any flag on which the registered declaration disagrees with the live
service.

## Authentication

OIDC authorization code with PKCE (public client — no secret), via
`@ifc-lite/oauth-pkce`. The authorization and token endpoints are **discovered**
from `{issuer}/.well-known/openid-configuration` rather than configured, so a
deployment cannot get three URLs out of step with each other.

Register `/oauth/commit-http/callback` (on the viewer's origin) as a redirect
URI with the identity provider.

## REST contract

Base URL is the configured `baseUrl`. Every request carries
`Authorization: Bearer <access token>`.

| Method | Endpoint |
| --- | --- |
| capabilities | `GET /capabilities` |
| `listProjects` | `GET /projects?cursor&limit&query` |
| `listModels` | `GET /projects/{projectId}/models?cursor&limit&query` |
| `getModel` | `GET /projects/{projectId}/models/{modelId}` |
| `listCommits` | `GET .../models/{modelId}/commits?cursor&limit&before&after&includeUnpublished` |
| `getCommit` | `GET .../commits/{commitId}` |
| `loadCommit` | `GET .../commits/{commitId}/payload`, `Accept` listing media types |
| `loadCommitFingerprints` | `GET .../commits/{commitId}/fingerprints?keyProperty&maxEntries&dataOnly` |
| `getCommitDiff` | `GET .../models/{modelId}/diff?base&head&keyProperty` |
| `listElementHistory` | `GET .../models/{modelId}/elements/{key}/history?atCommitId&keyProperty&cursor&limit` |
| `listIdentityRecords` | `GET .../models/{modelId}/identity?base&head` |
| `createModel` | `POST /projects/{projectId}/models` |
| `createCommit` | `POST .../models/{modelId}/commits`, multipart (`meta` JSON part + `file` part), `Idempotency-Key` header |
| `recordIdentity` | `POST .../models/{modelId}/identity?base&head` |
| `watchCommits` | `POST /projects/{projectId}/commit-events` |

Paged endpoints return `{ "items": [...], "cursor": "..." }`; `cursor` is
omitted on the last page.

### Payload media types

| Format | Media type |
| --- | --- |
| `ifc-step` | `application/x-step` |
| `ifc-zip` | `application/zip` |
| `ifcx` | `application/json` |
| `ifc-lite-cache` | `application/vnd.ifc-lite.cache` (reserved) |

`GET .../payload` should also send `X-Artifact-Digest` (`sha256:<hex>` over the
original bytes) and `X-Artifact-Filename`. The host verifies the digest before
loading; without the header the client falls back to the commit record, which
costs an extra round trip.

### Errors

A non-2xx response returns `{ code, message, retryAfterMs?, details? }`:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `not-found` | 404 | No such project, model or commit |
| `forbidden` | 401 / 403 | Not authorized |
| `conflict` | 409 | `expectedParentId` is not the head — put the real one in `details.headCommitId` |
| `not-ready` | 202 | Still computing; send `retryAfterMs` or a `Retry-After` header |
| `unsupported-format` | 415 | Cannot serve any accepted payload format |
| `invalid` | 400 | Malformed request |
| `unavailable` | 503 | Temporary failure |

A response with no usable `code` is mapped from its status, so a proxy's own
error page still reaches the host as something it can branch on.

## Not a file store

`listContainers` and `listFiles` return empty pages and `download` throws:
a commit service has models and commits, not folders and files. The
corresponding 2.0.0 capability flags are all `false`.
