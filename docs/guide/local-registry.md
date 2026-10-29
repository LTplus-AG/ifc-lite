# Local model registry demo

Use **File → Cloud Sources → Model registry** to connect to a local registry,
browse models and versions, open an IFC, edit it, and publish the saved model.
The connection remains signed in while Cloud Sources is closed for editing.
Model names, version names, publisher and publication time are the normal view;
complete content fingerprints and declared package metadata are under
**Technical details**.

## Prepare the tools

Install the workspace dependencies using the repository's
[development setup](../contributing/setup.md). The browser needs the matching
WASM runtime. `pnpm build:wasm:fetch` obtains an official prebuilt when it matches
the checkout; otherwise build with `pnpm build:wasm` and the pinned Rust toolchain.

Make an [ifcx-oci build from main](https://github.com/zahmadsaleem/ifcx-oci/tree/main)
and `oras` available in your terminal. Follow its
[browser application setup](https://github.com/zahmadsaleem/ifcx-oci/blob/main/DEVELOPMENT.md#connect-a-browser-application)
for client and callback registration. The recorded checks use backend revision
`8f25007`. These commands
use only the public `hello-wall.ifc` fixture already in the repository. Run them
from the IFClite repository root. Choose passwords when prompted:

```sh
ifcx-oci user add --data build/registry-demo/store writer --grant project/model:pull,push
ifcx-oci user add --data build/registry-demo/store reader --grant project/model:pull
ifcx-oci serve --data build/registry-demo/store --listen 127.0.0.1:5000 \
  --oauth-client-id ifc-lite \
  --oauth-redirect-uri http://localhost:3000/oauth/registry/callback \
  --oauth-redirect-uri http://127.0.0.1:3000/oauth/registry/callback
```

Keep that server running. In another terminal, publish the sample through the
standard OCI client using the writer's password:

```sh
oras login --plain-http --registry-config build/registry-demo/oras-auth.json \
  127.0.0.1:5000 --username writer
oras push --plain-http --registry-config build/registry-demo/oras-auth.json \
  --artifact-type application/vnd.ifcx-oci.ifc.v1 \
  --annotation org.opencontainers.image.title="Hello wall" \
  127.0.0.1:5000/project/model:issued \
  apps/viewer/public/samples/hello-wall.ifc:application/x-step
```

Artifacts, the registry store and the selected ORAS credentials file stay in
ignored `build/`. Keep credentials out of commits.

## Run the browser flow

```sh
VITE_REGISTRY_ENABLED=true IFC_REGISTRY_TARGET=http://127.0.0.1:5000 pnpm dev
```

Open the local URL printed by Vite, normally `http://localhost:3000`.
Register that exact viewer origin and callback path with the registry. If Vite
uses another port, restart the registry with its matching `--oauth-redirect-uri`.

1. Open **File → Cloud Sources**, expand **Model registry**, and paste
   `http://localhost:5000` into **Registry address**. Click **Sign in to ifcx-oci**.
   A popup opens on the registry's own address. Sign in there as the writer and
   approve access; the viewer never asks for or receives the password. Allow
   popups for the viewer if your browser blocks this window.
2. Choose the model and version from the lists. Publication details identify
   the authenticated publisher and time when the registry recorded them.
   Click **Open model** and close Cloud Sources.
3. Select a wall, open **Author → Model**, and edit **Name** in the Model
   inspector. Press Tab to apply the edit.
4. Reopen **Cloud Sources → Model registry**. The connection remains signed in.
   Enter a fresh version name and click **Publish edited model**.
5. Click **Open saved version**. Inspect the edited property and geometry to
   confirm the saved IFC was received again. The fetch uses the exact manifest
   digest internally.
6. Sign out and use the registry popup to connect as the reader. Models and versions remain browsable;
   publishing is disabled and the server also enforces the restriction.

A complete model address such as
`http://localhost:5000/project/model:issued` preselects that model and version.
OCI references (`localhost:5000/project/model:issued` or `oci://…`) and standard
`/v2/project/model/manifests/issued` URLs are also accepted. A pasted digest
reference can select a pinned release; users do not need to type a fingerprint.

No models, no versions, expired sign-in, denied access and unknown publication
records have explicit UI states. Use a new version name each time; the demo
refuses an existing tag. This check is not an atomic multi-user tag lock.

## Connection and discovery boundaries

The local demo's same-origin development proxy is pinned to
`IFC_REGISTRY_TARGET`, a loopback HTTP origin. Vite supplies this address to the
UI. Pasted addresses are normalized and must identify that configured registry;
loopback aliases at its port resolve to the same pinned target. Changing input
cannot route the proxy to another host or port. URLs containing credentials,
queries or ambiguous references are rejected before sign-in begins.

The proxy forwards `/v2/`, `/oauth/config`, `/oauth/token` and `/oauth/revoke`.
Only the exact token/revoke routes may pass the named `ifcx_oci_refresh` cookie;
other request cookies are stripped. Response cookies must have that exact name,
`Path=/oauth/`, HttpOnly and SameSite=Strict, with no Domain attribute. Discovery
and distribution never pass cookies. Upload locations are rewritten to the viewer
origin. The credential/approval page at `/oauth/authorize` opens directly on the
configured registry origin and is never proxied under the viewer's origin.
Discovery must identify that exact registry authorization endpoint, the public
client ID configured by the registry, the registered viewer callback, and PKCE S256. Unexpected
authorization addresses, token endpoints, redirects and upload locations are
rejected. No browser security setting needs changing.
Remote registries, arbitrary destinations, static hosting and Vite preview are
outside this demo's connection scope.

Sign-in uses OAuth 2.0 Authorization Code with PKCE S256: each attempt creates a
fresh random verifier and state, sends only the challenge to the registry, and
redeems the returned one-time code with the matching verifier. The callback
validates its exact origin/path, state and unambiguous parameters. A static
callback page returns the result through the existing origin-scoped
BroadcastChannel, which works with the viewer's cross-origin isolation.
Sign-in times out after five minutes; closing Cloud Sources cancels an active
attempt. Sign-out revokes the server session and prevents late token responses
from restoring access. Remembered sign-out also clears the connected state in
the viewer's other tabs; independent tab-only sessions stay separate.

Access tokens last at most 15 minutes and are renewed automatically when used.
The default session keeps its rotating refresh token in tab memory and lasts
up to eight hours. Closing/reopening Cloud Sources preserves that session;
reloading the viewer requires sign-in again unless you chose **Remember me for
30 days** on the registry page.

Remembered sessions keep their refresh token only in an HttpOnly browser cookie,
survive reloads and browser restarts, and are shared across tabs on the same
viewer origin for an absolute 30 days. Access tokens stay in memory; refresh
tokens never enter localStorage. Renewal cannot extend the original deadline or
increase the originally approved grants. Web Locks serialize cookie exchanges
across tabs, and concurrent model requests share one renewal within a tab.
The viewer retries an authorization failure once after renewal and never
retries a write after an ambiguous network error. If server sign-out fails,
retry **Sign out** before reconnecting.

Registry-owned local accounts remain available on the registry website; CLI and
ORAS retain their separate OCI login. No external identity provider is required.
The viewer has no Basic-auth or password fallback.

The UI uses the [Distribution catalog
API](https://distribution.github.io/distribution/spec/api/#listing-repositories)
at `/v2/_catalog`, plus OCI tag lists and manifests. Catalog listing is not a
required OCI Distribution endpoint. The UI follows catalog pagination. The Rust registry's explicit local token scope
`registry:catalog:read` returns the user's current exact repository/action grants
plus a catalog read capability. It does not issue wildcard repository access.
Catalog, tag, manifest and blob reads remain permission checked, and current
SQLite grants can revoke access even while a token is still valid.

## Titles, provenance and artifact integrity

The model and release titles come from manifest annotations or IFC filenames.
New browser publications include standard `org.opencontainers.image.title`,
`.authors` and `.created` annotations. Declared author and creation time are
package claims, shown separately in Technical details.

The Rust registry independently records the authenticated pushing account and
server timestamp on publication. Manifest GET/HEAD responses expose optional
`IFCX-Registry-Publisher` and `IFCX-Registry-Pushed-At` headers. These are registry
extensions; they do not claim the standard OCI manifest contains a trusted
pusher or upload timestamp. Tag reads report that tag's latest publication;
digest reads report the first observed publication of those bytes in this
registry. Older records with no captured provenance show **Publisher not
recorded** and **Publication time not recorded**. An ORAS publication through
the updated backend records its actual account just like a browser publication.

Registry publication records are stored separately and never change submitted
manifest bytes or digests. The browser verifies the manifest and IFC source
layer against SHA-256 before loading. New releases contain an empty OCI config
and one `application/x-step` layer, named by `org.opencontainers.image.title`,
with the experimental artifact type `application/vnd.ifcx-oci.ifc.v1`.
A derived release's optional single `source/model.ifc` can also be opened;
its Parquet/GLB profile is not imported by this adapter.

Publishing uses the complete, mutation-aware STEP exporter used by **Export
modified IFC**. It exports edits rather than re-uploading the original source
buffer. The demo handles one active IFC STEP model, up to 512 MiB; IFC5, portable
texture archives and incomplete exports are refused. Export coverage depends
on the model and the pinned IFClite exporter.

## Focused checks

Run through the root Turbo runner, supplying the real local executables:

```sh
IFCX_OCI_BINARY=/absolute/path/to/ifcx-oci \
IFCX_ORAS_BINARY=/absolute/path/to/oras \
TEST_PATTERN='lib/registry/.*test|sources/RegistrySource.test' \
  pnpm test --filter=@ifc-lite/viewer
pnpm typecheck
pnpm lint
```

Without the executable variables, integration/ORAS coverage reports its skipped
portion. The tests cover address parsing, S256 challenge/verifier binding,
callback validation, session renewal, remembered restoration, multi-tab cookie
serialization, sign-out races, credential boundaries, authenticated
model discovery, publisher/time metadata, actual edited IFC export, integrity,
reader denials, existing-version refusal, panel-close session survival and
independent ORAS retrieval. Generic file-source providers retain their existing
download API; publishing is a registry-specific action within Cloud Sources.

The [recorded browser walkthrough](../architecture/evidence/registry-pkce-login/README.md)
shows the password-free viewer, successful registry login, publication and reopen,
with independent ORAS integrity verification.
