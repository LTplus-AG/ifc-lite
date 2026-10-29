# Installing and hosting retained engines (draft)

Refs #7955. For explicitly qualified builds after the human licence review.
This document does not enable retained mode or authorize distributing an SDK.
Exact remains the default. `npm install @ifc-lite/wasm` supplies the retained
loader/types, **not** the separately deployed retained engine binaries.

## Build and stage

Use the repository-pinned Rust/wasm-pack setup and Emscripten 4.0.15 from emsdk
`3b3963d86a5c97adaf6eaa845cdfe0b811c2f960`. Check out usd-brep at
`c9c5979f04cea8c38213004d4f04df0dcfb40d05`; keep kernel/API and licence files clean.
Build from clean committed source in the release qualification environment:

```sh
env BUILD_RETAINED=1 bash scripts/build-wasm.sh
emcmake cmake -S native/smlib-adapter -B /absolute/managed/smlib-build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DSMLIB_SOURCE=/absolute/pinned-usd-brep
cmake --build /absolute/managed/smlib-build --parallel 4
node scripts/retained-notices.mjs --check
node scripts/stage-cli-retained-engine.mjs \
  --build /absolute/managed/smlib-build --sdk /absolute/pinned-usd-brep \
  --pkg-retained /absolute/checkout/packages/wasm/pkg-retained \
  --out /absolute/new-engine-directory
```

Activate emsdk in the build environment before `emcmake`; merely having
`emcc` on another machine does not qualify the command. Additional platform
runtime notices can be supplied with repeatable `--toolchain-notice NAME=ABS`.
The stager refuses an existing destination, malformed WASM, stale configured
modules and modified SDK sources. It never builds or executes the supplied SDK.
Keep `engine-manifest.json` and **every** file it inventories, including notices
and nested wasm-bindgen `snippets/`; hashes identify bytes but are not build
attestations. Do not assemble an engine by copying just two WASM files.

The staged directory is also consumed by CLI:

```sh
ifc-lite export model.ifc --format obj --kernel retained \
  --retained-engine /absolute/new-engine-directory --out model.obj
```

The native standalone worker uses the ordinary CMake build instead of
`emcmake`; `cmake --install` places the binary in `bin/` and notices in
`share/licenses/ifclite-smlib/`. It is a separate executable from the CLI's
Node/Emscripten engine. Archive both installation directories together and add
the final platform-specific runtime notices after the linked-artifact review.

## URL layout and headers

Serve over HTTPS (localhost is suitable for development), preferably same-origin.
Map `/smlib/` to `<engine>/smlib/` and `/retained-engine/` to `<engine>/`. Thus the
retained Rust module URL is `/retained-engine/pkg-retained/ifc-lite.js`; its WASM
and snippet imports remain relative to that URL. `/smlib/worker.mjs` is the
SMLib module Worker, and loads sibling `ifclite_smlib_browser.mjs` and `.wasm`.
These paths are part of the current driver contract. Deploy all files atomically;
never mix the two WASM builds or their JS glue across release revisions.

Send these headers on the document, assets and module Worker responses,
including errors and redirects, matching the existing viewer serving contract:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
X-Content-Type-Options: nosniff
```

Use `text/javascript` for `.js`/`.mjs`, `application/wasm` for `.wasm`, and
`application/json` for manifests. Do not let a SPA fallback return HTML for a
missing Worker or WASM URL. Preserve cross-origin isolation for all embedded
resources; an alternative `require-corp` setup needs appropriate CORS/CORP
headers for every cross-origin dependency. The current SMLib build is single
threaded, but the viewer's isolation policy still applies to module Workers.

For local viewer development, point `IFCLITE_RETAINED_ENGINE` at the staged
directory and set `VITE_RETAINED_GEOMETRY=on` for the existing root `pnpm dev`
workflow. Its middleware validates the manifest and serves both URL prefixes
with the above headers. The Vite plugin **does not copy** engines into build
output, and rejects Vercel builds with retained enabled. This draft does not
remove that distribution gate or change the production deployment workflow.
A custom host must implement the URL mappings explicitly after release approval.

## Verify the installed copy

Check with HEAD and GET (a host may configure them differently):

```sh
curl -I https://your-host.example/smlib/worker.mjs
curl -I https://your-host.example/smlib/ifclite_smlib_browser.wasm
curl -I https://your-host.example/retained-engine/pkg-retained/ifc-lite.js
curl -I https://your-host.example/retained-engine/THIRD_PARTY_NOTICES.txt
```

Then use a fresh browser tab: verify `crossOriginIsolated`, successful module
Worker startup, correct MIME types and no missing snippet requests. Explicitly
select retained, load a real IFC fixture, confirm reported refusals, and exercise
cancel. Missing/broken retained assets must fail explicitly; they must never
silently execute exact. Repeat after downloading/installing the actual release
artifact rather than serving a developer checkout. Use the existing
`geometry-platform.yml` real Worker and `viewer-retained` tests as the executable
smoke recipe; this document is a draft, not a claim that a release was hosted.
