# @ifc-lite/source-buildagil

buildagil `FileSourceProvider` for ifc-lite: browse a buildagil project's
folders and open its IFC, IFCZIP, IFCXML and IFCX documents, including older
versions. Built on buildagil's openCDE API (`https://openapi.buildagil.com`,
OpenAPI document "buildagil openCDE API" 1.0 on SwaggerHub).

```ts
import { BuildagilProvider } from '@ifc-lite/source-buildagil';

const provider = new BuildagilProvider({ clientId: 'the deployment client id' });
```

## Sign-in

`auth: 'interactive'`: OAuth 2.0 authorization code with PKCE in a popup,
scopes `openid offline_access api`. buildagil fronts Microsoft Entra ID; its
authorize endpoint redirects there. Client ids are issued by buildagil support
against registered callback URLs. The default callback is the viewer's generic
OAuth page, `/oauth/bcf/callback` (option `redirectPath`).

buildagil issues a **confidential** client. This package never holds the
secret and never sends one: it posts standard RFC 6749 form grants to
`https://openapi.buildagil.com/oauth2/token` through `ctx.fetch`, and the
host's relay adds the secret. Tokens live in `ctx.storage` via
`@ifc-lite/oauth-pkce`'s `TokenManager` (refresh is single-flight and cannot
outlive a sign-out). The account shown comes from the access token's Entra
claims (`oid`, `name`, `preferred_username`), decoded for display only: the
API has no current-user endpoint.

## Relay

openapi.buildagil.com answers no CORS preflight, for the API and the token
endpoint alike, so the manifest declares a relay:
`https://openapi.buildagil.com` → `/api/buildagil`. A browser host rewrites
every request onto that same-origin path. In ifc-lite's viewer the relay is
`api/buildagil.ts` (handler `server/sources/buildagil-relay.ts`), served by
the dev server too. It forwards enumerated reads and `POST 1.0/search` with
the caller's bearer, and turns `oauth2/token` grants into confidential ones.

| Variable | Where | Value |
|---|---|---|
| `VITE_BUILDAGIL_CLIENT_ID` | public, compiled into the bundle | the client id; unset = the source is not offered |
| `BUILDAGIL_CLIENT_ID` | server-only | the same client id |
| `BUILDAGIL_CLIENT_SECRET` | server-only, mark *Sensitive* | the client secret |
| `BUILDAGIL_REDIRECT_URIS` | server-only, optional | comma-separated; defaults to `https://www.ifclite.com/oauth/bcf/callback` and `http://localhost:5000/oauth/bcf/callback` |
| `BUILDAGIL_RELAY_ALLOWED_ORIGINS` | server-only, optional | comma-separated; defaults to `APP_URL` plus the callbacks' origins |

Put a Vercel WAF rate-limit rule on `/api/buildagil`, as on `/api/dalux`.

## Browsing

Projects come from `GET /1.0/projects`. The API has no folder endpoint, so a
project's IFC documents are read in one bounded scan (`GET
…/documents` filtered by `file_type`, paged by creation time because the list
has `$top` but no `$skip`) and the folder tree is built from their
`folder_url` (`containerListing: 'flat-subtree'`). Folders without a model
beneath them are not shown. The scan is reused for a minute and dropped on
sign-out. Above 5000 IFC documents a project is refused rather than listed
partially; search still works. Search is `POST /1.0/search` over documents.

A revision is a document's `version_index`. Downloading a named revision
fetches exactly that version; without one, the current content. A download
the API redirects to Azure blob storage is followed by the relay without the
bearer.

Errors are `BuildagilHttpError` (`status`, `reauthenticationRequired` on 401).
buildagil throttles per user; the relay passes `429` with `Retry-After`
through so the host can back off.

## License

MPL-2.0
