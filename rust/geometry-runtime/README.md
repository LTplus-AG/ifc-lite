<!-- SPDX-License-Identifier: MPL-2.0 -->
# ifc-lite-geometry-runtime

Opt-in Rust client for IFC-Lite's isolated native geometry workers, plus the
transport-neutral `protocol` module. It does not enable retained geometry in the
viewer, CLI or processing pipeline. Exact geometry remains the default.

Native callers explicitly start a separately installed compatible worker with
`SmlibWorker::spawn(executable)`. Worker ownership, retained receipts and process
supervision live in this crate. The `protocol` module is also available on
`wasm32`; native process APIs are excluded there. The browser executor remains
in `ifc-lite-wasm` behind its `retained-browser` feature.

This package contains Rust source and test peers only. It does not build,
download, link or bundle SMLib, the native adapter executable, SDK libraries,
or browser Worker/WASM assets. Those require separate installation and licence
clearance; publishing this client does not grant permission to distribute them.

The workspace supplies the crate version and the versioned geometry/core
requirements. Automated release admission is pending the first-publish bootstrap
documented in the repository's [RELEASE.md](https://github.com/LTplus-AG/ifc-lite/blob/main/RELEASE.md#geometry-runtime-first-publish-gate-7955).
An optional dependency from a published consumer still requires this crate to
exist in the registry at a compatible version.

Tests using `IFCLITE_SMLIB_WORKER` skip when no worker is configured. A green
SDK-free test run therefore does not qualify retained numerical execution.
