# ifc-lite-geometry-runtime

Source-only isolated native geometry worker client. Refs #7955.

The `retained-runtime` feature enables the retained protocol and forwards to
`ifc-lite-geometry/retained-runtime`. No SDK, C++ kernel, executable, WASM or
Emscripten runtime is included or downloaded. Applications supply a separately
built worker. Default features do not enable retained geometry.

See the repository's `docs/architecture/retained-licensing.md` and
`docs/guide/retained-installation.md` before distributing a linked engine.
Licensed under MPL-2.0; see LICENSE.
