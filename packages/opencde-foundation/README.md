# @ifc-lite/opencde-foundation

Client for the buildingSMART [OpenCDE Foundation API](https://github.com/buildingSMART/foundation-API) — the small set of services and conventions every OpenCDE API (BCF, Documents, ...) shares: `/foundation/versions` discovery, OAuth2 `/auth` discovery and token exchange (including dynamic client registration), and `/current-user`.

This package is the shared foundation `@ifc-lite/bcf-api` and `@ifc-lite/documents-api` build their clients on — not a standalone product most apps depend on directly, though its OAuth2 helpers and error types are reusable on their own for any OpenCDE-flavored server.

Works in the browser and in Node (uses the global `fetch`; injectable for tests).

## Install

```bash
npm install @ifc-lite/opencde-foundation
```

## Discover what a server offers

```ts
import { getFoundationVersions, findApiVersion, apiBaseUrlFor } from '@ifc-lite/opencde-foundation';

// `/foundation/versions` always sits at the server's base, regardless of
// where a specific API's own base URL ends up.
const versions = await getFoundationVersions({ baseUrl: 'https://example.com' });
const documents = findApiVersion(versions, 'documents');
if (documents) {
  const documentsBaseUrl = apiBaseUrlFor('https://example.com', documents);
  // -> documents.api_base_url if the server relocated it, else
  //    'https://example.com/documents/1.0'
}
```

## Sign in

```ts
import { FoundationApiClient, requestPasswordToken } from '@ifc-lite/opencde-foundation';

const client = new FoundationApiClient({ baseUrl: 'https://example.com/bcf' });
const authInfo = await client.getAuthInfo();

const token = await requestPasswordToken({
  tokenUrl: authInfo.oauth2_token_url!,
  username: 'you@example.com',
  password: '...',
});
```

Other flows: `exchangeAuthorizationCode` (with PKCE), `requestClientCredentialsToken`, `refreshAccessToken`, and `registerClient` for servers that advertise `oauth2_dynamic_client_reg_url` (dynamic client registration). Errors are `FoundationApiError` (`status`, `url`, `isAuthError`) and `FoundationAuthenticationError` (adds the RFC 6749 `errorCode`).

## Building a client on top

`FoundationApiClient` implements URL building (`/versions` sits beside the version segment; everything else lives under `{baseUrl}/{version}`), Bearer token injection, and JSON error mapping. A concrete OpenCDE service client extends it and adds its own resources using the inherited protected `requestJsonAt`/`send`:

```ts
import { FoundationApiClient } from '@ifc-lite/opencde-foundation';

class ExampleApiClient extends FoundationApiClient {
  getWidgets() {
    return this.requestJsonAt('/widgets');
  }
}
```

`@ifc-lite/bcf-api`'s `BcfApiClient` is built exactly this way.

## License

MPL-2.0
