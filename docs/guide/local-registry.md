# Local OCI registry demo

Open a shared IFC release in the normal IFClite viewer, edit a property, publish
another version, and reopen the published version. This demo adds an **OCI
Registry** connection inside the locally hosted viewer’s **Cloud Sources** panel.
It uses an OCI registry's existing local
accounts and scoped Bearer tokens; it does not implement OAuth/OIDC sign-in.

## Prepare the tools

Install the workspace dependencies and build the viewer dependencies using the
repository's [development setup](../contributing/setup.md). The browser
needs the matching WASM runtime. `pnpm build:wasm:fetch` can obtain an official
prebuilt; if its compatibility check reports that the package is behind this
checkout, build from source with `pnpm build:wasm` and the pinned Rust toolchain.

Make the `ifcx-oci` registry binary and the standard `oras` client available in
your terminal. Run these commands from the IFClite repository root. They use only
the public `hello-wall.ifc` sample already in the repository.

Create accounts, choosing passwords when prompted, then keep the server running:

```sh
ifcx-oci user add --data build/registry-demo/store writer --grant project/model:pull,push
ifcx-oci user add --data build/registry-demo/store reader --grant project/model:pull
ifcx-oci serve --data build/registry-demo/store --listen 127.0.0.1:5000
```

In another terminal, publish the example using ORAS. Enter the writer password
when asked. The selected credentials file and artifacts stay under ignored
`build/`; do not commit them.

```sh
oras login --plain-http --registry-config build/registry-demo/oras-auth.json \
  127.0.0.1:5000 --username writer
oras push --plain-http --registry-config build/registry-demo/oras-auth.json \
  --artifact-type application/vnd.ifcx-oci.ifc.v1 \
  127.0.0.1:5000/project/model:issued \
  apps/viewer/public/samples/hello-wall.ifc:application/x-step
```

## Start the viewer

```sh
VITE_REGISTRY_ENABLED=true IFC_REGISTRY_TARGET=http://127.0.0.1:5000 pnpm dev
```

Open the local URL printed by Vite, normally `http://localhost:3000`. The target
is developer configuration, rather than an address typed into the product UI.
It accepts a loopback HTTP origin. The panel is disabled unless explicitly
enabled. The proxy is available in the development server, not a static hosted
build or Vite preview.

1. Open **File → Cloud Sources**, expand **OCI Registry**, and sign in to
   `project/model` as the writer.
2. Select `issued` and click **Pull and open**. Close Cloud Sources to view the model.
3. Select a wall, open **Author → Model**, and change its **Name** in the Model
   inspector. Press Tab to apply the edit.
4. Reopen **Cloud Sources → OCI Registry**, enter a new version such as
   `revision-2`, and click **Publish new version**. The active model is identified above the button.
5. Click **Open published version**. This fetches the saved artifact again by its
   manifest digest. Inspect the edited property to confirm it persisted.
6. Sign out and sign in as the reader. Pull remains available; publishing is
   disabled, and the registry also enforces the restriction on requests.

Passwords are cleared after sign-in attempts. Tokens live only in memory in the
current tab and expire after 15 minutes. Sign out clears the session and cancels
pending requests. Closing Cloud Sources cancels pending requests but keeps the
connection in tab memory, so you can edit and reopen the panel to publish without
signing in again. Sign-out, expiry or closing the tab ends the session. Use a new
version name each time; the demo refuses a tag that already exists. The tag check is not a multi-user compare-and-swap lock.

## Artifact and browser contracts

The browser adapter uses OCI v2 manifests and blobs, with an empty OCI config
and one `application/x-step` source layer named by
`org.opencontainers.image.title`. New publications use the experimental artifact
type `application/vnd.ifcx-oci.ifc.v1`. The manifest and source layer are checked
against SHA-256 digests before loading. The source may also come from a derived
artifact carrying exactly one optional `source/model.ifc`; this does not import
that artifact's Parquet/GLB profile into the viewer.

Publishing calls the same complete, mutation-aware STEP exporter used by
**Export modified IFC**, including property/quantity/attribute changes. It does
not upload the initial source buffer or treat camera/visibility state as an IFC
edit. The first demo supports one active IFC STEP model; IFC5, portable texture
archives and incomplete exports are refused. The local server's file limit is
512 MiB. Export coverage still depends on the model and the pinned IFClite code.

The development server proxies `/v2/` and `/token` to the configured registry.
It rewrites the Bearer realm and upload locations to the browser-facing origin.
Tokens and credentials cannot follow a redirect or upload location to another
origin. This avoids cross-origin preflights and public-site-to-loopback access.
The backend still owns all repository/action authorization.

The repository is entered explicitly because this registry does not provide a
repository catalog. Releases are listed using that repository's tags; the
received manifest digest records the exact release. A proper browser OAuth flow
would need an identity provider, authorization code + PKCE, and an identity to
registry-permissions mapping as a separate feature.

## Focused checks

Run the root Turbo test runner. Supply the local registry and ORAS executables to
exercise real interoperability; without these, the Rust integration and ORAS
portions report their skipped coverage.

```sh
IFCX_OCI_BINARY=/absolute/path/to/ifcx-oci \
IFCX_ORAS_BINARY=/absolute/path/to/oras \
TEST_PATTERN='lib/registry/.*test|sources/RegistrySource.test' pnpm test --filter=@ifc-lite/viewer
pnpm typecheck
pnpm lint
```

The adapter tests cover byte verification, redirect/realm boundaries, publishing
and receiving against the Rust registry, preserved manifest identity, existing
version refusal, reader permission denials and independent ORAS retrieval. A real
IFC export test also checks that a pending wall edit survives the complete STEP
export while retaining the model’s entity count.

The Cloud Sources UI check covers placement alongside the existing connections,
collapse/expand navigation, session survival when the panel closes, and explicit
sign-out. Registry publishing is an OCI-specific action; the generic file-source
provider API retains its existing download capabilities.
