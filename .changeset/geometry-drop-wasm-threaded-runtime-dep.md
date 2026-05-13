---
"@ifc-lite/geometry": patch
---

Drop runtime dependency on the private `@ifc-lite/wasm-threaded` workspace package. Previously published `@ifc-lite/geometry` manifests pointed at `@ifc-lite/wasm-threaded@0.1.0`, which is intentionally non-publishable, causing `npm install @ifc-lite/geometry` to fail. The threaded bundle is only imported by the single-controller worker behind a feature flag and is always supplied via a host bundler alias, so it now lives in `devDependencies` with an optional `peerDependency` documenting the alias contract.
