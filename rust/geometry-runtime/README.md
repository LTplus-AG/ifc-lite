<!-- SPDX-License-Identifier: MPL-2.0 -->
# ifc-lite-geometry-runtime

Opt-in Rust client and transport protocol for IFC-Lite's isolated native
geometry workers. Native callers start a separately installed compatible
worker with `SmlibWorker::spawn(executable)`. This crate owns the worker process,
its handles and retained-operation receipts. The `protocol` module is also
available on `wasm32`; native process APIs are excluded there.

The crate does not enable retained geometry in the viewer or CLI. The
processing crate's `retained-native` feature is opt-in, and exact geometry
remains the default. The browser executor lives in `ifc-lite-wasm` behind its
separate `retained-browser` feature.

The archive contains Rust source, test peers and Cargo metadata. It does not
build, download, link or bundle SMLib, the native adapter executable, SDK
libraries, or browser Worker/WASM assets. Those need separate installation and
licence review. Publishing this client does not clear redistribution of them.

The workspace supplies the crate version and its versioned geometry/core
requirements. A published processing crate with an optional runtime dependency
still needs the matching runtime version to resolve in crates.io.

Tests that need an actual SMLib worker use `IFCLITE_SMLIB_WORKER` and skip when
it is absent. An SDK-free green test run does not qualify retained numerical
execution.

## License

This Source Code Form is subject to the terms of the Mozilla Public License,
v. 2.0. If a copy of the MPL was not distributed with this file, you can obtain
one at <https://mozilla.org/MPL/2.0/>.
