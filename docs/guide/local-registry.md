# Open with and push to an OCI file store

IFC Lite receives a selected version from a file browser, authorizes its own
access, and downloads the model directly from an OCI registry. **Push to…**
publishes an edited model to a chosen destination and is also available for
models opened locally, without a preceding handoff.

The Subsoil demonstration uses independent Zot storage and Keycloak identity.
Subsoil supplies file/version browsing and application selection. Its proposed
`oci-handoff/1` contract is separate from OCI Distribution, OAuth, and the IFC
artifact format; it is not an existing OCI or IETF standard.

## Run the Compose demonstration

Use the matching [Subsoil checkout](https://github.com/zahmadsaleem/subsoil).
Its root `compose.yaml` includes the demo services and an optional IFC Lite
viewer built from this checkout:

```sh
# From the Subsoil repository; IFC Lite is at ../../lt-plus/ifc-lite by default.
docker compose --profile viewer up --build -d
```

Set `IFC_LITE_CHECKOUT` to this checkout's absolute path when the repositories
have another layout. Open `http://localhost:5080/explore`, sign in as `writer`
with `writer-demo-password`, select `project/model:issued`, and choose
**Open with…** or **Edit with… → IFC Lite**. Approve the application's read
access on Keycloak. The Compose viewer on port 3001 opens the pinned version received from Zot.

Edit a property, then choose **File → Cloud Sources → Push to…**. Choose the
file store and folder, enter a fresh version name, and approve publication
access. **Open saved version** opens the saved digest in a new tab; refresh
Subsoil's versions to see the publication. `reader` / `reader-demo-password`
can receive `project/model` but cannot publish. The writer can also publish to
`reviews/model`.

The Compose deployment is a local HTTP demonstration with known credentials.
Its gateway validates JWT signature, issuer, audience and expiry, while Zot
enforces repository actions. Keycloak stores users and policies. IFC Lite and
Subsoil have no local account or token-issuer requirement.

## Configure a viewer connection

Enable the UI and explicitly configure each trusted registry and authorization
issuer. For a local development viewer, start the other Compose services
without the viewer profile. Set the IFC Lite application launch URL in
Subsoil’s `demo/subsoil.json` to `http://localhost:3000/open-artifact` and
restart Subsoil, then run from this repository:

```sh
VITE_REGISTRY_ENABLED=true \
VITE_REGISTRY_CONNECTIONS='[{"name":"Demo files","registry":"http://localhost:5001","authorization_server":"http://localhost:8080/realms/subsoil","client_id":"ifc-lite"}]' \
pnpm dev
```

A registry URL is an origin without a trailing slash. The issuer can have a
path. Register the exact viewer callbacks at that issuer:

- `/open-artifact/callback` receives a handoff's code exchange.
- `/oauth/registry/callback` returns a publishing popup's result through the
  origin-scoped OAuth callback channel.

For `http://localhost:3000`, the supplied Keycloak realm already registers both
URLs and its browser origin. Another viewer origin or port requires matching
registration and registry CORS configuration. Transfers use direct requests;
there is no fixed Subsoil API proxy, refresh cookie, or loopback-only routing
contract. HTTPS registries are supported when explicitly configured. Local HTTP
is accepted only on loopback addresses.

## Handoff contents

The application launch URL carries `#handoff=<base64url>`, containing UTF-8 JSON:

```json
{
  "protocol": "oci-handoff/1",
  "source": {
    "registry": "http://localhost:5001",
    "repository": "project/model",
    "digest": "sha256:32982f1d25a7c6d12f627c1fbc5d3d09df56514c3a24de7647bcc6808d6be214"
  },
  "intent": "edit"
}
```

The digest identifies exact manifest bytes. `intent` is a `view` or `edit` UI
hint and grants no authority. Optional `destination` contains a suggested
`registry` and `repository`; the person saving chooses the final destination
and version. The handoff contains no credentials, issuer configuration,
profile registry, expiration promise, or permission rules.

The viewer accepts only configured stores, removes the handoff from the
address, and creates its own OAuth transaction. Changing the locator never
grants access. A repository token can read other permitted versions in that
repository; a digest-pinned link does not narrow its authorization.

## Authorization and file integrity

Endpoint discovery uses RFC 8414 metadata or OIDC discovery and verifies the
configured issuer. Login uses Authorization Code with PKCE S256, exact callback
and state checks, issuer-bound responses, and the registry as the OAuth resource
indicator. The viewer consumes ordinary `access_token`, `token_type`,
`expires_in`, and optional `scope` fields. It treats access tokens as opaque and
keeps them in tab memory. Only pending state and the verifier temporarily use
session storage. Reloading starts a fresh authorization; the provider can reuse
its SSO session.

Opening requests `repository:<folder>:pull`. The demo's publication requests
independently grantable `repository:<folder>:pull` and
`repository:<folder>:push` scope values. Returned permissions must be a subset
of the request. The application separately authorizes a changed destination
and never sends a source token to another registry.

The OCI package verifies manifest and layer digests and sizes. This IFC
application accepts exactly one `application/x-step` layer up to 512 MiB and
uses the canonical model-loading path. Publication exports the complete active
IFC, including pending property edits, with the artifact type
`application/vnd.ifc-lite.ifc.v1` and an OCI empty config.

The client checks an existing tag before uploading and again before committing.
These checks are not atomic tag immutability; the registry deployment owns any
such policy. Successful manifest publication returns an immutable digest.
Opening the saved version in a new tab preserves the current editing session.
A successful publication remains successful if later metadata retrieval fails.

## Checks

Run checks through the root workspace scripts:

```sh
pnpm typecheck
TEST_PATTERN='lib/registry/.*test|components/sources/Oci.*test|components/sources/SourcesPanel.*test' \
pnpm test --filter=@ifc-lite/viewer
```

The tests exercise locator validation, opaque OAuth responses and scope
narrowing, actual HTTP push/pull boundaries, and publication of a real edited
IFC through the Push to control. The Compose-native integration check is run
from Subsoil:

```sh
docker compose --profile test run --rm smoke
```

See Subsoil's [integration contract](https://github.com/zahmadsaleem/subsoil/blob/main/docs/DEVELOPMENT.md)
and [deployment guide](https://github.com/zahmadsaleem/subsoil/blob/main/docs/DEPLOYMENT.md)
for the wire contract, role mapping, runtime components, and demo limitations.
