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

Make the `ifcx-oci` binary and `oras` available in your terminal. These commands
use only the public `hello-wall.ifc` fixture already in the repository. Run them
from the IFClite repository root. Choose passwords when prompted:

```sh
ifcx-oci user add --data build/registry-demo/store writer --grant project/model:pull,push
ifcx-oci user add --data build/registry-demo/store reader --grant project/model:pull
ifcx-oci serve --data build/registry-demo/store --listen 127.0.0.1:5000
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

1. Open **File → Cloud Sources**, expand **Model registry**, and paste
   `http://localhost:5000` into **Registry address**. Connect as the writer.
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
6. Sign out and connect as the reader. Models and versions remain browsable;
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
queries or ambiguous references are rejected before credentials are sent.

The proxy forwards `/v2/` and `/token`, removes browser cookies, and rewrites
Bearer realms and upload locations to the viewer origin. The adapter accepts
only that token path and registry distribution paths, and rejects redirects,
foreign realms and upload locations. No browser security setting needs changing.
Remote registries, arbitrary destinations, static hosting and Vite preview are
outside this demo's connection scope.

Passwords are cleared after sign-in attempts and source-card collapse. Tokens
and selected-model state live only in tab memory across closing/reopening Cloud
Sources. Sign-out or connection changes clear authentication and model metadata;
expiry requires reconnecting. Closing Cloud Sources cancels in-flight requests.
This uses local accounts and scoped Bearer tokens, rather than OAuth/OIDC.

The UI reads the standard `/v2/_catalog`, repository tag lists and OCI manifests.
It follows catalog pagination. The Rust registry's explicit local token scope
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
portion. The tests cover address parsing, credential boundaries, authenticated
model discovery, publisher/time metadata, actual edited IFC export, integrity,
reader denials, existing-version refusal, panel-close session survival and
independent ORAS retrieval. Generic file-source providers retain their existing
download API; publishing is a registry-specific action within Cloud Sources.
